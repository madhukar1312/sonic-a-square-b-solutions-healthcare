import { getPool, sql } from "@/server/services/shared";
import { ApiError } from "@/lib/security/errors";
import type { AuthUser } from "@/lib/auth/session";
import { audit } from "@/server/services/shared";
import { createPrivateReadUrl } from "@/server/services/private-storage";
import { z } from "zod";

const reviewSchema = z.object({
  decision: z.enum(["Approved", "Rejected"]),
  reason: z.string().trim().max(500).nullable().optional(),
});

export async function listUsers() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) UserId AS userId, Email AS email,
      Role AS role, IsActive AS isActive, CreatedAt AS createdAt
    FROM dbo.Users ORDER BY CreatedAt DESC`);
  return result.recordset;
}

export async function listCredentialsForReview() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) c.CredentialId AS credentialId,
      c.DoctorId AS doctorId, d.FullName AS doctorName, c.CredentialType AS credentialType,
      c.Issuer AS issuer, c.CredentialNumber AS credentialNumber, c.Status AS status,
      c.CreatedAt AS createdAt
    FROM dbo.DoctorCredentials c INNER JOIN dbo.DoctorProfiles d ON d.UserId = c.DoctorId
    ORDER BY c.CreatedAt ASC`);
  return result.recordset;
}

export async function reviewDoctor(admin: AuthUser, doctorId: string, body: unknown) {
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Doctor review decision is invalid.", "VALIDATION_ERROR");
  if (parsed.data.decision === "Rejected" && !parsed.data.reason) {
    throw new ApiError(400, "A rejection reason is required.", "VALIDATION_ERROR");
  }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    if (parsed.data.decision === "Rejected") {
      const activePayment = await new sql.Request(transaction).input("doctorId", sql.UniqueIdentifier, doctorId)
        .query(`SELECT TOP (1) p.PaymentId FROM dbo.Payments p WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.Appointments a ON a.AppointmentId = p.AppointmentId
          WHERE a.DoctorId = @doctorId AND p.Status = N'Created'`);
      if (activePayment.recordset[0]) {
        throw new ApiError(409, "Resolve pending payment orders before rejecting this doctor.", "PENDING_PAYMENT_ORDERS");
      }
    }
    if (parsed.data.decision === "Approved") {
      const credential = await new sql.Request(transaction).input("doctorId", sql.UniqueIdentifier, doctorId)
        .query(`SELECT TOP (1) CredentialId FROM dbo.DoctorCredentials WITH (UPDLOCK, HOLDLOCK)
          WHERE DoctorId = @doctorId AND Status = N'Approved'`);
      if (!credential.recordset[0]) {
        throw new ApiError(409, "At least one credential must be approved before approving a doctor.", "CREDENTIALS_NOT_APPROVED");
      }
    }
    const updated = await new sql.Request(transaction)
      .input("doctorId", sql.UniqueIdentifier, doctorId)
      .input("decision", sql.NVarChar(10), parsed.data.decision)
      .input("reason", sql.NVarChar(500), parsed.data.reason ?? null)
      .input("adminId", sql.UniqueIdentifier, admin.userId)
      .query(`UPDATE dbo.DoctorProfiles SET VerificationStatus = @decision, RejectionReason = @reason,
          ReviewedBy = @adminId, ReviewedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.UserId AS doctorId, INSERTED.VerificationStatus AS verificationStatus
        WHERE UserId = @doctorId`);
    if (!updated.recordset[0]) throw new ApiError(404, "Doctor was not found.", "NOT_FOUND");
    await new sql.Request(transaction)
      .input("adminId", sql.UniqueIdentifier, admin.userId)
      .input("decision", sql.NVarChar(100), `doctor.${parsed.data.decision.toLowerCase()}`)
      .input("doctorId", sql.NVarChar(100), doctorId)
      .input("metadata", sql.NVarChar(1000), JSON.stringify({ reason: parsed.data.reason ?? null }))
      .query(`INSERT INTO dbo.AuditLogs (ActorUserId, Action, EntityType, EntityId, MetadataJson)
        VALUES (@adminId, @decision, N'Doctor', @doctorId, @metadata)`);
    await transaction.commit();
    return updated.recordset[0];
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function reviewCredential(admin: AuthUser, credentialId: string, body: unknown) {
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Credential review decision is invalid.", "VALIDATION_ERROR");
  if (parsed.data.decision === "Rejected" && !parsed.data.reason) {
    throw new ApiError(400, "A rejection reason is required.", "VALIDATION_ERROR");
  }
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const updated = await new sql.Request(transaction)
      .input("credentialId", sql.UniqueIdentifier, credentialId)
      .input("decision", sql.NVarChar(10), parsed.data.decision)
      .input("adminId", sql.UniqueIdentifier, admin.userId)
      .query(`UPDATE dbo.DoctorCredentials SET Status = @decision, ReviewedBy = @adminId,
          ReviewedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.CredentialId AS credentialId, INSERTED.DoctorId AS doctorId,
          INSERTED.Status AS status WHERE CredentialId = @credentialId`);
    if (!updated.recordset[0]) throw new ApiError(404, "Credential was not found.", "NOT_FOUND");
    if (parsed.data.decision === "Rejected") {
      const remaining = await new sql.Request(transaction).input("doctorId", sql.UniqueIdentifier, updated.recordset[0].doctorId)
        .query(`SELECT TOP (1) CredentialId FROM dbo.DoctorCredentials WITH (UPDLOCK, HOLDLOCK)
          WHERE DoctorId = @doctorId AND Status = N'Approved'`);
      if (!remaining.recordset[0]) {
        const activePayment = await new sql.Request(transaction)
          .input("doctorId", sql.UniqueIdentifier, updated.recordset[0].doctorId)
          .query(`SELECT TOP (1) p.PaymentId FROM dbo.Payments p WITH (UPDLOCK, HOLDLOCK)
            INNER JOIN dbo.Appointments a ON a.AppointmentId = p.AppointmentId
            WHERE a.DoctorId = @doctorId AND p.Status = N'Created'`);
        if (activePayment.recordset[0]) {
          throw new ApiError(409, "Resolve pending payment orders before revoking this doctor's verification.", "PENDING_PAYMENT_ORDERS");
        }
        await new sql.Request(transaction)
          .input("doctorId", sql.UniqueIdentifier, updated.recordset[0].doctorId)
          .input("adminId", sql.UniqueIdentifier, admin.userId)
          .input("reason", sql.NVarChar(500), parsed.data.reason ?? null)
          .query(`UPDATE dbo.DoctorProfiles SET VerificationStatus = N'Pending', RejectionReason = @reason,
              ReviewedBy = @adminId, ReviewedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
            WHERE UserId = @doctorId AND VerificationStatus = N'Approved'`);
      }
    }
    await new sql.Request(transaction)
      .input("adminId", sql.UniqueIdentifier, admin.userId)
      .input("credentialId", sql.NVarChar(100), credentialId)
      .input("metadata", sql.NVarChar(1000), JSON.stringify({
        decision: parsed.data.decision,
        reason: parsed.data.reason ?? null,
      }))
      .query(`INSERT INTO dbo.AuditLogs (ActorUserId, Action, EntityType, EntityId, MetadataJson)
        VALUES (@adminId, N'doctor.credential.reviewed', N'DoctorCredential', @credentialId, @metadata)`);
    await transaction.commit();
    return updated.recordset[0];
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function credentialDocumentUrl(credentialId: string) {
  const pool = await getPool();
  const result = await pool.request().input("credentialId", sql.UniqueIdentifier, credentialId)
    .query("SELECT DocumentObjectKey AS objectKey FROM dbo.DoctorCredentials WHERE CredentialId = @credentialId");
  const objectKey = result.recordset[0]?.objectKey as string | undefined;
  if (!objectKey) throw new ApiError(404, "Credential document was not found.", "NOT_FOUND");
  return createPrivateReadUrl(objectKey);
}

export async function adminAppointments() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) a.AppointmentId AS appointmentId,
      a.PatientId AS patientId, p.FullName AS patientName, a.DoctorId AS doctorId,
      d.FullName AS doctorName, a.StartAt AS startAt, a.EndAt AS endAt,
      a.FeeAmount AS feeAmount, a.Status AS status, a.PaymentStatus AS paymentStatus,
      a.CreatedAt AS createdAt
    FROM dbo.Appointments a INNER JOIN dbo.PatientProfiles p ON p.UserId = a.PatientId
      INNER JOIN dbo.DoctorProfiles d ON d.UserId = a.DoctorId
    ORDER BY a.CreatedAt DESC`);
  return result.recordset;
}

export async function adminPayments() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) PaymentId AS paymentId,
      AppointmentId AS appointmentId, PatientId AS patientId, DoctorId AS doctorId,
      AmountPaise AS amountPaise, CommissionPaise AS commissionPaise,
      DoctorEarningsPaise AS doctorEarningsPaise, Status AS status,
      RazorpayOrderId AS razorpayOrderId, CreatedAt AS createdAt, UpdatedAt AS updatedAt
    FROM dbo.Payments ORDER BY CreatedAt DESC`);
  return result.recordset;
}

export async function adminCommissions() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) l.LedgerId AS ledgerId,
      l.PaymentId AS paymentId, p.AppointmentId AS appointmentId, l.CommissionPaise AS commissionPaise,
      l.CreatedAt AS createdAt FROM dbo.PlatformCommissionLedger l
      INNER JOIN dbo.Payments p ON p.PaymentId = l.PaymentId ORDER BY l.CreatedAt DESC`);
  return result.recordset;
}

export async function adminAuditLogs() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT TOP (200) AuditLogId AS auditLogId,
      ActorUserId AS actorUserId, Action AS action, EntityType AS entityType,
      EntityId AS entityId, MetadataJson AS metadataJson, CreatedAt AS createdAt
    FROM dbo.AuditLogs ORDER BY CreatedAt DESC`);
  return result.recordset;
}

export async function logAdminRead(user: AuthUser, action: string) {
  await audit(user.userId, action, "AdminView");
}
