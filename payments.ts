import { createHmac } from "node:crypto";
import { getPool, sql } from "@/server/services/shared";
import { ApiError } from "@/lib/security/errors";
import {
  verifyHmacSignature,
  verifyRazorpayPaymentSignature,
} from "@/lib/security/payment-signature";
import type { AuthUser } from "@/lib/auth/session";
import { audit } from "@/server/services/shared";
import { z } from "zod";

const orderSchema = z.object({ appointmentId: z.string().uuid() });
const verifySchema = z.object({
  orderId: z.string().min(1).max(80),
  paymentId: z.string().min(1).max(80),
  signature: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

function razorpayCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !keyId.startsWith("rzp_test_")) {
    throw new ApiError(503, "Razorpay test-mode credentials are not configured.", "PAYMENTS_NOT_CONFIGURED");
  }
  return { keyId, keySecret };
}

export function checkoutConfiguration() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  return {
    checkoutEnabled: Boolean(
      keyId?.startsWith("rzp_test_") &&
      process.env.RAZORPAY_KEY_SECRET &&
      process.env.RAZORPAY_WEBHOOK_SECRET,
    ),
  };
}

function commissionBasisPoints(): number {
  const value = Number(process.env.PLATFORM_COMMISSION_BPS ?? "0");
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new ApiError(500, "Platform commission configuration is invalid.", "SERVER_CONFIGURATION_ERROR");
  }
  return value;
}

export async function createPaymentOrder(user: AuthUser, body: unknown) {
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Appointment id is invalid.", "VALIDATION_ERROR");
  const credentials = razorpayCredentials();
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw new ApiError(503, "Razorpay webhook configuration is required before checkout can be enabled.", "PAYMENTS_NOT_CONFIGURED");
  }
  const commissionBps = commissionBasisPoints();
  const pool = await getPool();
  const appointmentResult = await pool.request()
    .input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
    .input("patientId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT a.AppointmentId AS appointmentId, a.DoctorId AS doctorId, a.FeeAmount AS feeAmount,
        a.Status AS status, a.PaymentStatus AS paymentStatus, a.CreatedAt AS createdAt, a.StartAt AS startAt,
        d.VerificationStatus AS verificationStatus
      FROM dbo.Appointments a INNER JOIN dbo.DoctorProfiles d ON d.UserId = a.DoctorId
      WHERE a.AppointmentId = @appointmentId AND a.PatientId = @patientId`);
  const appointment = appointmentResult.recordset[0];
  if (!appointment) throw new ApiError(404, "Appointment was not found.", "NOT_FOUND");
  if (appointment.status !== "PendingPayment" || appointment.paymentStatus !== "Pending" ||
      appointment.verificationStatus !== "Approved") {
    throw new ApiError(409, "This appointment is not eligible for payment.", "PAYMENT_NOT_ALLOWED");
  }
  if (Date.now() - new Date(appointment.createdAt).getTime() > 15 * 60 * 1000) {
    await pool.request().input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
      .query(`UPDATE dbo.Appointments SET Status = N'Cancelled', UpdatedAt = SYSUTCDATETIME()
        WHERE AppointmentId = @appointmentId AND Status = N'PendingPayment' AND PaymentStatus = N'Pending'
          AND NOT EXISTS (SELECT 1 FROM dbo.Payments p
            WHERE p.AppointmentId = dbo.Appointments.AppointmentId AND p.Status = N'Created')`);
    throw new ApiError(409, "This appointment reservation has expired. Please book another slot.", "APPOINTMENT_EXPIRED");
  }
  if (new Date(appointment.startAt).getTime() <= Date.now()) {
    throw new ApiError(409, "This appointment has expired.", "APPOINTMENT_EXPIRED");
  }
  const amountPaise = Math.round(Number(appointment.feeAmount) * 100);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new ApiError(409, "The appointment fee is invalid.", "INVALID_FEE");
  }

  const priorOrder = await pool.request()
    .input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
    .input("patientId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT TOP (1) RazorpayOrderId AS orderId, AmountPaise AS amountPaise, Currency AS currency
      FROM dbo.Payments WHERE AppointmentId = @appointmentId AND PatientId = @patientId AND Status = N'Created'`);
  if (priorOrder.recordset[0]) {
    const savedOrder = priorOrder.recordset[0] as { orderId: string; amountPaise: number; currency: string };
    const statusResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${encodeURIComponent(savedOrder.orderId)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!statusResponse.ok) throw new ApiError(502, "The payment provider could not check the existing order.", "PAYMENT_PROVIDER_ERROR");
    const providerOrder = await statusResponse.json() as {
      amount?: number; currency?: string; status?: string; expire_by?: number;
    };
    if (providerOrder.amount !== Number(savedOrder.amountPaise) || providerOrder.currency !== savedOrder.currency) {
      throw new ApiError(502, "The payment provider returned an invalid existing order.", "PAYMENT_PROVIDER_ERROR");
    }
    if (providerOrder.status === "created" || providerOrder.status === "attempted") {
      if (!providerOrder.expire_by || providerOrder.expire_by <= Math.floor(Date.now() / 1000)) {
        await expireUnpaidOrder(pool, savedOrder.orderId);
        throw new ApiError(409, "This appointment reservation has expired. Please choose another time.", "APPOINTMENT_EXPIRED");
      }
      return {
        orderId: savedOrder.orderId,
        amount: Number(savedOrder.amountPaise),
        currency: savedOrder.currency,
        keyId: credentials.keyId,
      };
    }
    if (providerOrder.status === "expired") {
      await expireUnpaidOrder(pool, savedOrder.orderId);
      throw new ApiError(409, "This appointment reservation has expired. Please choose another time.", "APPOINTMENT_EXPIRED");
    }
    throw new ApiError(409, "Payment for this appointment is still being confirmed.", "PAYMENT_PROCESSING");
  }

  const orderResponse = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: parsed.data.appointmentId,
      expire_by: Math.floor((Date.now() + 15 * 60 * 1000) / 1000),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!orderResponse.ok) throw new ApiError(502, "The payment provider could not create an order.", "PAYMENT_PROVIDER_ERROR");
  const order = await orderResponse.json() as { id?: string; amount?: number; currency?: string };
  if (!order.id || order.amount !== amountPaise || order.currency !== "INR") {
    throw new ApiError(502, "The payment provider returned an invalid order.", "PAYMENT_PROVIDER_ERROR");
  }

  const commission = Math.floor(amountPaise * commissionBps / 10000);
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const current = await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
      .input("patientId", sql.UniqueIdentifier, user.userId)
      .query(`SELECT a.AppointmentId FROM dbo.Appointments a WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN dbo.DoctorProfiles d WITH (UPDLOCK, HOLDLOCK) ON d.UserId = a.DoctorId
        WHERE a.AppointmentId = @appointmentId AND a.PatientId = @patientId
          AND a.Status = N'PendingPayment' AND a.PaymentStatus = N'Pending'
          AND a.StartAt > SYSUTCDATETIME() AND a.CreatedAt >= DATEADD(minute, -15, SYSUTCDATETIME())
          AND d.VerificationStatus = N'Approved'`);
    if (!current.recordset[0]) throw new ApiError(409, "This appointment is no longer eligible for payment.", "PAYMENT_NOT_ALLOWED");
    await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
      .input("patientId", sql.UniqueIdentifier, user.userId)
      .input("doctorId", sql.UniqueIdentifier, appointment.doctorId)
      .input("amount", sql.BigInt, amountPaise)
      .input("commission", sql.BigInt, commission)
      .input("earnings", sql.BigInt, amountPaise - commission)
      .input("orderId", sql.NVarChar(80), order.id)
      .query(`INSERT INTO dbo.Payments
        (AppointmentId, PatientId, DoctorId, AmountPaise, CommissionPaise, DoctorEarningsPaise, RazorpayOrderId)
        VALUES (@appointmentId, @patientId, @doctorId, @amount, @commission, @earnings, @orderId)`);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ApiError) throw error;
    if (isUniqueViolation(error)) throw new ApiError(409, "A payment order already exists for this appointment.", "PAYMENT_ORDER_EXISTS");
    throw error;
  }
  return { orderId: order.id, amount: amountPaise, currency: "INR", keyId: credentials.keyId };
}

async function expireUnpaidOrder(pool: sql.ConnectionPool, orderId: string) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const expired = await new sql.Request(transaction).input("orderId", sql.NVarChar(80), orderId)
      .query(`UPDATE dbo.Payments SET Status = N'Failed', UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.AppointmentId AS appointmentId
        WHERE RazorpayOrderId = @orderId AND Status = N'Created'`);
    if (expired.recordset[0]) {
      await new sql.Request(transaction)
        .input("appointmentId", sql.UniqueIdentifier, expired.recordset[0].appointmentId)
        .query(`UPDATE dbo.Appointments SET Status = N'Cancelled', PaymentStatus = N'Failed', UpdatedAt = SYSUTCDATETIME()
          WHERE AppointmentId = @appointmentId AND Status = N'PendingPayment' AND PaymentStatus = N'Pending'`);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function verifyPayment(user: AuthUser, body: unknown) {
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Payment verification details are invalid.", "VALIDATION_ERROR");
  const { keyId, keySecret } = razorpayCredentials();
  if (!verifyRazorpayPaymentSignature(
    keySecret, parsed.data.orderId, parsed.data.paymentId, parsed.data.signature,
  )) {
    throw new ApiError(400, "Payment signature is invalid.", "INVALID_PAYMENT_SIGNATURE");
  }
  const pool = await getPool();
  const result = await pool.request()
    .input("orderId", sql.NVarChar(80), parsed.data.orderId)
    .input("paymentId", sql.NVarChar(80), parsed.data.paymentId)
    .input("patientId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT PaymentId AS paymentId, AmountPaise AS amountPaise, Status AS status,
        RazorpayPaymentId AS razorpayPaymentId
      FROM dbo.Payments WHERE RazorpayOrderId = @orderId AND PatientId = @patientId`);
  const paymentRow = result.recordset[0];
  if (!paymentRow) throw new ApiError(404, "Payment order was not found.", "NOT_FOUND");
  if (paymentRow.status === "Paid" && paymentRow.razorpayPaymentId === parsed.data.paymentId) return { status: "Paid" };
  if (paymentRow.status !== "Created") throw new ApiError(409, "Payment is already finalized.", "PAYMENT_FINALIZED");
  const verified = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(parsed.data.paymentId)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!verified.ok) throw new ApiError(502, "The payment provider could not verify this payment.", "PAYMENT_PROVIDER_ERROR");
  const providerPayment = await verified.json() as { order_id?: string; amount?: number; currency?: string; status?: string };
  if (providerPayment.order_id !== parsed.data.orderId || providerPayment.amount !== Number(paymentRow.amountPaise) ||
      providerPayment.currency !== "INR" || providerPayment.status !== "captured") {
    throw new ApiError(409, "The payment has not been captured for this order.", "PAYMENT_NOT_CAPTURED");
  }
  await markPaymentPaid(parsed.data.orderId, parsed.data.paymentId);
  await audit(user.userId, "payment.verified", "Payment", parsed.data.orderId);
  return { status: "Paid" };
}

export async function processRazorpayWebhook(rawBody: string, signature: string | null, eventId: string | null) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !verifyHmacSignature(secret, rawBody, signature)) {
    throw new ApiError(400, "Webhook signature is invalid.", "INVALID_WEBHOOK_SIGNATURE");
  }
  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string; amount?: number; currency?: string } };
      order?: { entity?: { id?: string } };
    };
  };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    throw new ApiError(400, "Webhook payload is invalid.", "INVALID_WEBHOOK");
  }
  const type = event.event;
  const payment = event.payload?.payment?.entity;
  if (!type) throw new ApiError(400, "Webhook payload is incomplete.", "INVALID_WEBHOOK");
  const id = eventId?.trim().slice(0, 120) || createHmac("sha256", secret).update(rawBody).digest("hex");
  if (type !== "payment.captured" && type !== "payment.failed" && type !== "order.expired") {
    return { received: true, ignored: true };
  }
  const orderId = type === "order.expired" ? event.payload?.order?.entity?.id : payment?.order_id;
  if (!orderId) throw new ApiError(400, "Webhook order details are incomplete.", "INVALID_WEBHOOK");
  if (type !== "order.expired" && !payment?.id) {
    throw new ApiError(400, "Webhook payment details are incomplete.", "INVALID_WEBHOOK");
  }
  if (type === "payment.captured" && (typeof payment?.amount !== "number" || payment.currency !== "INR")) {
    throw new ApiError(400, "Captured payment amount is missing or invalid.", "INVALID_WEBHOOK");
  }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const seen = await new sql.Request(transaction)
      .input("eventId", sql.NVarChar(120), id)
      .query("SELECT EventId FROM dbo.PaymentWebhookEvents WITH (UPDLOCK, HOLDLOCK) WHERE EventId = @eventId");
    if (seen.recordset.length) {
      await transaction.commit();
      return { received: true, duplicate: true };
    }
    await new sql.Request(transaction).input("eventId", sql.NVarChar(120), id).input("eventType", sql.NVarChar(100), type)
      .query("INSERT INTO dbo.PaymentWebhookEvents (EventId, EventType) VALUES (@eventId, @eventType)");
    if (type === "order.expired") {
      const expired = await new sql.Request(transaction).input("orderId", sql.NVarChar(80), orderId)
        .query(`UPDATE dbo.Payments SET Status = N'Failed', UpdatedAt = SYSUTCDATETIME()
          OUTPUT INSERTED.AppointmentId AS appointmentId
          WHERE RazorpayOrderId = @orderId AND Status = N'Created'`);
      if (expired.recordset[0]) {
        await new sql.Request(transaction)
          .input("appointmentId", sql.UniqueIdentifier, expired.recordset[0].appointmentId)
          .query(`UPDATE dbo.Appointments SET Status = N'Cancelled', PaymentStatus = N'Failed', UpdatedAt = SYSUTCDATETIME()
            WHERE AppointmentId = @appointmentId AND Status = N'PendingPayment' AND PaymentStatus = N'Pending'`);
      } else {
        const existing = await new sql.Request(transaction).input("orderId", sql.NVarChar(80), orderId)
          .query("SELECT PaymentId FROM dbo.Payments WHERE RazorpayOrderId = @orderId");
        if (!existing.recordset[0]) throw new ApiError(404, "Payment order was not found.", "NOT_FOUND");
      }
    } else if (payment?.id) {
      await updatePaymentInTransaction(transaction, orderId, payment.id,
        type === "payment.captured" ? "Paid" : "Failed", payment.amount, payment.currency);
    } else {
      throw new ApiError(400, "Webhook payment details are incomplete.", "INVALID_WEBHOOK");
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  await audit(null, "payment.webhook.processed", "Payment", orderId, { eventId: id, status: type });
  return { received: true };
}

async function markPaymentPaid(orderId: string, paymentId: string) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await updatePaymentInTransaction(tx, orderId, paymentId, "Paid");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function updatePaymentInTransaction(
  transaction: sql.Transaction,
  orderId: string,
  paymentId: string,
  status: "Paid" | "Failed",
  amount?: number,
  currency?: string,
) {
  const result = await new sql.Request(transaction)
    .input("orderId", sql.NVarChar(80), orderId)
    .input("paymentId", sql.NVarChar(80), paymentId)
    .input("status", sql.NVarChar(10), status)
    .input("amount", sql.BigInt, amount ?? null)
    .input("currency", sql.Char(3), currency ?? null)
    .query(`UPDATE dbo.Payments SET Status = @status, RazorpayPaymentId = @paymentId,
        UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.PaymentId AS paymentId, INSERTED.AppointmentId AS appointmentId,
        INSERTED.CommissionPaise AS commissionPaise
      WHERE RazorpayOrderId = @orderId AND Status = N'Created'
        AND (@amount IS NULL OR AmountPaise = @amount)
        AND (@currency IS NULL OR Currency = @currency)`);
  if (!result.recordset[0]) {
    const prior = await new sql.Request(transaction).input("orderId", sql.NVarChar(80), orderId)
      .query("SELECT Status FROM dbo.Payments WHERE RazorpayOrderId = @orderId");
    if (!prior.recordset[0]) throw new ApiError(404, "Payment order was not found.", "NOT_FOUND");
    if (prior.recordset[0].Status !== status) throw new ApiError(409, "Payment is already finalized.", "PAYMENT_FINALIZED");
    return;
  }
  const row = result.recordset[0];
  if (status === "Paid") {
    await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, row.appointmentId)
      .query(`UPDATE dbo.Appointments SET PaymentStatus = N'Paid', Status = N'Confirmed', UpdatedAt = SYSUTCDATETIME()
        WHERE AppointmentId = @appointmentId AND Status = N'PendingPayment' AND PaymentStatus = N'Pending'`);
    await new sql.Request(transaction).input("paymentId", sql.UniqueIdentifier, row.paymentId)
      .input("commission", sql.BigInt, row.commissionPaise)
      .query(`INSERT INTO dbo.PlatformCommissionLedger (PaymentId, CommissionPaise) VALUES (@paymentId, @commission)`);
  } else {
    await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, row.appointmentId)
      .query(`UPDATE dbo.Appointments SET PaymentStatus = N'Failed', Status = N'Cancelled', UpdatedAt = SYSUTCDATETIME()
        WHERE AppointmentId = @appointmentId AND Status = N'PendingPayment' AND PaymentStatus = N'Pending'`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "number" in error &&
    ((error as { number?: number }).number === 2601 || (error as { number?: number }).number === 2627);
}
