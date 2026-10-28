import { getPool, requireAuthorizedConsultation, requirePatientAppointment, sql, audit } from "@/server/services/shared";
import { ApiError } from "@/lib/security/errors";
import type { AuthUser } from "@/lib/auth/session";
import {
  appointmentSchema,
  availabilitySchema,
  credentialSchema,
  documentUploadSchema,
  doctorProfileSchema,
  medicalRecordSchema,
  patientDocumentUploadSchema,
  patientProfileSchema,
  prescriptionSchema,
} from "@/lib/validation/schemas";
import { z } from "zod";
import { createPrivateReadUrl, createPrivateUploadUrl, verifyPrivateUpload } from "@/server/services/private-storage";
import {
  assertAppointmentSlotFree,
  assertDoctorCanAcceptPaidAppointments,
  assertOwnPatientData,
  assertPrescriptionDoctor,
} from "@/server/policies";

export async function patientProfile(user: AuthUser, body?: unknown) {
  const pool = await getPool();
  if (body === undefined) {
    const result = await pool.request().input("userId", sql.UniqueIdentifier, user.userId)
      .query(`SELECT u.Email AS email, p.FullName AS fullName, p.Phone AS phone, p.DateOfBirth AS dateOfBirth
        FROM dbo.Users u INNER JOIN dbo.PatientProfiles p ON p.UserId = u.UserId WHERE u.UserId = @userId`);
    return result.recordset[0] ?? null;
  }
  const parsed = patientProfileSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Patient profile is invalid.", "VALIDATION_ERROR");
  await pool.request()
    .input("userId", sql.UniqueIdentifier, user.userId)
    .input("fullName", sql.NVarChar(120), parsed.data.fullName)
    .input("phone", sql.NVarChar(32), parsed.data.phone ?? null)
    .input("dateOfBirth", sql.Date, parsed.data.dateOfBirth ?? null)
    .query(`UPDATE dbo.PatientProfiles SET FullName = @fullName, Phone = @phone,
        DateOfBirth = @dateOfBirth, UpdatedAt = SYSUTCDATETIME() WHERE UserId = @userId`);
  return patientProfile(user);
}

export async function searchDoctors(query: URLSearchParams) {
  const specialization = query.get("specialization")?.trim().slice(0, 100) ?? "";
  const search = query.get("q")?.trim().slice(0, 100) ?? "";
  const pool = await getPool();
  const result = await pool.request()
    .input("specialization", sql.NVarChar(100), specialization)
    .input("search", sql.NVarChar(100), search)
    .query(`SELECT TOP (50) d.UserId AS doctorId, d.FullName AS fullName,
        d.Specialization AS specialization, d.Biography AS biography, d.ConsultationFee AS consultationFee
      FROM dbo.DoctorProfiles d
      WHERE d.VerificationStatus = N'Approved' AND d.ConsultationFee IS NOT NULL
        AND (@specialization = N'' OR d.Specialization = @specialization)
        AND (@search = N'' OR d.FullName LIKE N'%' + @search + N'%' OR d.Specialization LIKE N'%' + @search + N'%')
      ORDER BY d.FullName`);
  return result.recordset;
}

export async function doctorDetails(doctorId: string) {
  const pool = await getPool();
  const result = await pool.request().input("doctorId", sql.UniqueIdentifier, doctorId)
    .query(`SELECT UserId AS doctorId, FullName AS fullName, Specialization AS specialization,
        Biography AS biography, ConsultationFee AS consultationFee
      FROM dbo.DoctorProfiles WHERE UserId = @doctorId AND VerificationStatus = N'Approved'`);
  if (!result.recordset[0]) throw new ApiError(404, "Doctor was not found.", "NOT_FOUND");
  return result.recordset[0];
}

export async function getDoctorProfile(user: AuthUser) {
  const pool = await getPool();
  const result = await pool.request().input("doctorId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT FullName AS fullName, Specialization AS specialization, Biography AS biography,
        ConsultationFee AS consultationFee, VerificationStatus AS verificationStatus, RejectionReason AS rejectionReason
      FROM dbo.DoctorProfiles WHERE UserId = @doctorId`);
  return result.recordset[0] ?? null;
}

export async function updateDoctorProfile(user: AuthUser, body: unknown) {
  const parsed = doctorProfileSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Doctor profile is invalid.", "VALIDATION_ERROR");
  const pool = await getPool();
  await pool.request()
    .input("doctorId", sql.UniqueIdentifier, user.userId)
    .input("fullName", sql.NVarChar(120), parsed.data.fullName)
    .input("specialization", sql.NVarChar(100), parsed.data.specialization ?? null)
    .input("biography", sql.NVarChar(2000), parsed.data.biography ?? null)
    .input("fee", sql.Decimal(10, 2), parsed.data.consultationFee ?? null)
    .query(`UPDATE dbo.DoctorProfiles SET FullName = @fullName, Specialization = @specialization,
        Biography = @biography, ConsultationFee = @fee, UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @doctorId`);
  return getDoctorProfile(user);
}

export async function submitCredential(user: AuthUser, body: unknown) {
  const parsed = credentialSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Credential details are invalid.", "VALIDATION_ERROR");
  if (!parsed.data.documentObjectKey.startsWith(`credentials/${user.userId}/`)) {
    throw new ApiError(400, "Credential document key is invalid.", "INVALID_DOCUMENT");
  }
  await verifyPrivateUpload(parsed.data.documentObjectKey, "application/pdf");
  const pool = await getPool();
  const result = await pool.request()
    .input("doctorId", sql.UniqueIdentifier, user.userId)
    .input("type", sql.NVarChar(80), parsed.data.credentialType)
    .input("issuer", sql.NVarChar(160), parsed.data.issuer ?? null)
    .input("number", sql.NVarChar(100), parsed.data.credentialNumber ?? null)
    .input("objectKey", sql.NVarChar(512), parsed.data.documentObjectKey ?? null)
    .query(`INSERT INTO dbo.DoctorCredentials (DoctorId, CredentialType, Issuer, CredentialNumber, DocumentObjectKey)
      OUTPUT INSERTED.CredentialId AS credentialId, INSERTED.Status AS status, INSERTED.CreatedAt AS createdAt
      VALUES (@doctorId, @type, @issuer, @number, @objectKey)`);
  return result.recordset[0];
}

export async function credentialUploadUrl(user: AuthUser, body: unknown) {
  const parsed = documentUploadSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Upload details are invalid.", "VALIDATION_ERROR");
  if (parsed.data.contentType !== "application/pdf") {
    throw new ApiError(400, "Credential documents must be PDF files.", "UNSUPPORTED_FILE_TYPE");
  }
  return createPrivateUploadUrl(`credentials/${user.userId}`, "application/pdf");
}

export async function listCredentials(user: AuthUser) {
  const pool = await getPool();
  const result = await pool.request().input("doctorId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT CredentialId AS credentialId, CredentialType AS credentialType, Issuer AS issuer,
        Status AS status, ReviewedAt AS reviewedAt, CreatedAt AS createdAt
      FROM dbo.DoctorCredentials WHERE DoctorId = @doctorId ORDER BY CreatedAt DESC`);
  return result.recordset;
}

export async function availability(doctorId: string, from: string | null, to: string | null) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start ||
      end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw new ApiError(400, "A valid date range of at most 31 days is required.", "VALIDATION_ERROR");
  }
  const pool = await getPool();
  const result = await pool.request()
    .input("doctorId", sql.UniqueIdentifier, doctorId)
    .input("from", sql.DateTime2, start)
    .input("to", sql.DateTime2, end)
    .query(`SELECT a.AvailabilityId AS availabilityId, a.StartAt AS startAt, a.EndAt AS endAt
      FROM dbo.DoctorAvailability a INNER JOIN dbo.DoctorProfiles d ON d.UserId = a.DoctorId
      WHERE a.DoctorId = @doctorId AND a.IsAvailable = 1 AND d.VerificationStatus = N'Approved'
        AND a.StartAt >= @from AND a.EndAt <= @to
        AND NOT EXISTS (SELECT 1 FROM dbo.Appointments b
          WHERE b.DoctorId = a.DoctorId AND b.AvailabilityId = a.AvailabilityId
            AND b.Status NOT IN (N'Cancelled', N'Rejected')
            AND (b.Status <> N'PendingPayment' OR b.CreatedAt >= DATEADD(minute, -15, SYSUTCDATETIME())
              OR EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.AppointmentId = b.AppointmentId AND p.Status = N'Created')))
      ORDER BY a.StartAt`);
  return result.recordset;
}

export async function setAvailability(user: AuthUser, body: unknown, removeId?: string) {
  const pool = await getPool();
  if (removeId) {
    await pool.request().input("availabilityId", sql.UniqueIdentifier, removeId)
      .input("doctorId", sql.UniqueIdentifier, user.userId)
      .query(`UPDATE dbo.DoctorAvailability SET IsAvailable = 0
        WHERE AvailabilityId = @availabilityId AND DoctorId = @doctorId
          AND NOT EXISTS (SELECT 1 FROM dbo.Appointments WHERE AvailabilityId = @availabilityId
            AND Status NOT IN (N'Cancelled', N'Rejected'))`);
    return { removed: true };
  }
  const parsed = availabilitySchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Availability is invalid.", "VALIDATION_ERROR");
  if (Date.parse(parsed.data.startAt) <= Date.now()) {
    throw new ApiError(400, "Availability must be in the future.", "VALIDATION_ERROR");
  }
  const status = await pool.request().input("doctorId", sql.UniqueIdentifier, user.userId)
    .query("SELECT VerificationStatus AS status FROM dbo.DoctorProfiles WHERE UserId = @doctorId");
  if (status.recordset[0]?.status !== "Approved") throw new ApiError(403, "Doctor approval is required.", "DOCTOR_NOT_VERIFIED");
  const result = await pool.request()
    .input("doctorId", sql.UniqueIdentifier, user.userId)
    .input("startAt", sql.DateTime2, new Date(parsed.data.startAt))
    .input("endAt", sql.DateTime2, new Date(parsed.data.endAt))
    .query(`INSERT INTO dbo.DoctorAvailability (DoctorId, StartAt, EndAt)
      OUTPUT INSERTED.AvailabilityId AS availabilityId, INSERTED.StartAt AS startAt, INSERTED.EndAt AS endAt
      VALUES (@doctorId, @startAt, @endAt)`);
  return result.recordset[0];
}

export async function bookAppointment(user: AuthUser, body: unknown) {
  const parsed = appointmentSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Appointment details are invalid.", "VALIDATION_ERROR");
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const slot = await new sql.Request(transaction)
      .input("availabilityId", sql.UniqueIdentifier, parsed.data.availabilityId)
      .input("doctorId", sql.UniqueIdentifier, parsed.data.doctorId)
      .query(`SELECT a.AvailabilityId AS availabilityId, a.StartAt AS startAt, a.EndAt AS endAt,
          d.ConsultationFee AS fee, d.VerificationStatus AS verificationStatus
        FROM dbo.DoctorAvailability a WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN dbo.DoctorProfiles d WITH (UPDLOCK, HOLDLOCK) ON d.UserId = a.DoctorId
        WHERE a.AvailabilityId = @availabilityId AND a.DoctorId = @doctorId AND a.IsAvailable = 1`);
    const available = slot.recordset[0];
    if (!available) throw new ApiError(409, "This appointment slot is unavailable.", "SLOT_UNAVAILABLE");
    assertDoctorCanAcceptPaidAppointments(available.verificationStatus, available.fee === null ? null : Number(available.fee));
    if (new Date(available.startAt).getTime() <= Date.now()) {
      throw new ApiError(400, "Appointment time must be in the future.", "VALIDATION_ERROR");
    }
    await new sql.Request(transaction)
      .input("availabilityId", sql.UniqueIdentifier, parsed.data.availabilityId)
      .query(`UPDATE dbo.Appointments SET Status = N'Cancelled', UpdatedAt = SYSUTCDATETIME()
        WHERE AvailabilityId = @availabilityId AND Status = N'PendingPayment'
          AND PaymentStatus = N'Pending' AND CreatedAt < DATEADD(minute, -15, SYSUTCDATETIME())
          AND NOT EXISTS (SELECT 1 FROM dbo.Payments p WHERE p.AppointmentId = dbo.Appointments.AppointmentId AND p.Status = N'Created')`);
    const collision = await new sql.Request(transaction)
      .input("availabilityId", sql.UniqueIdentifier, parsed.data.availabilityId)
      .input("doctorId", sql.UniqueIdentifier, parsed.data.doctorId)
      .input("startAt", sql.DateTime2, available.startAt)
      .input("endAt", sql.DateTime2, available.endAt)
      .query(`SELECT TOP (1) AppointmentId FROM dbo.Appointments WITH (UPDLOCK, HOLDLOCK)
        WHERE DoctorId = @doctorId AND StartAt < @endAt AND EndAt > @startAt
          AND Status NOT IN (N'Cancelled', N'Rejected')`);
    assertAppointmentSlotFree(collision.recordset.length > 0);
    const result = await new sql.Request(transaction)
      .input("patientId", sql.UniqueIdentifier, user.userId)
      .input("doctorId", sql.UniqueIdentifier, parsed.data.doctorId)
      .input("availabilityId", sql.UniqueIdentifier, parsed.data.availabilityId)
      .input("startAt", sql.DateTime2, available.startAt)
      .input("endAt", sql.DateTime2, available.endAt)
      .input("fee", sql.Decimal(10, 2), available.fee)
      .query(`INSERT INTO dbo.Appointments (PatientId, DoctorId, AvailabilityId, StartAt, EndAt, FeeAmount)
        OUTPUT INSERTED.AppointmentId AS appointmentId, INSERTED.StartAt AS startAt,
          INSERTED.EndAt AS endAt, INSERTED.FeeAmount AS feeAmount, INSERTED.Status AS status
        VALUES (@patientId, @doctorId, @availabilityId, @startAt, @endAt, @fee)`);
    await transaction.commit();
    return result.recordset[0];
  } catch (error) {
    await transaction.rollback();
    if (error instanceof ApiError) throw error;
    if (isUniqueViolation(error)) throw new ApiError(409, "This appointment slot has already been booked.", "SLOT_UNAVAILABLE");
    throw error;
  }
}

export async function listAppointments(
  user: AuthUser,
  doctorView = false,
  period: "all" | "upcoming" | "previous" = "all",
) {
  const pool = await getPool();
  const column = doctorView ? "DoctorId" : "PatientId";
  const result = await pool.request()
    .input("userId", sql.UniqueIdentifier, user.userId)
    .input("period", sql.NVarChar(10), period)
    .query(`SELECT a.AppointmentId AS appointmentId, a.DoctorId AS doctorId,
        a.StartAt AS startAt, a.EndAt AS endAt, a.FeeAmount AS feeAmount, a.Status AS status,
        a.PaymentStatus AS paymentStatus,
        CASE WHEN a.PaymentStatus = N'Paid' AND a.Status IN (N'Confirmed', N'Completed') THEN p.FullName ELSE NULL END AS patientName,
        CASE WHEN a.PaymentStatus = N'Paid' AND a.Status IN (N'Confirmed', N'Completed') THEN a.PatientId ELSE NULL END AS patientId,
        d.FullName AS doctorName,
        CASE WHEN EXISTS (SELECT 1 FROM dbo.Payments pay
          WHERE pay.AppointmentId = a.AppointmentId AND pay.Status = N'Created')
          THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS hasPaymentOrder
      FROM dbo.Appointments a
      INNER JOIN dbo.PatientProfiles p ON p.UserId = a.PatientId
      INNER JOIN dbo.DoctorProfiles d ON d.UserId = a.DoctorId
      WHERE a.${column} = @userId
        AND (@period = N'all' OR (@period = N'upcoming' AND a.StartAt > SYSUTCDATETIME())
          OR (@period = N'previous' AND a.StartAt <= SYSUTCDATETIME()))
      ORDER BY a.StartAt DESC`);
  return result.recordset;
}

export async function cancelAppointment(user: AuthUser, appointmentId: string) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, appointmentId)
      .input("userId", sql.UniqueIdentifier, user.userId)
      .query(`UPDATE dbo.Appointments WITH (UPDLOCK, HOLDLOCK) SET Status = N'Cancelled', UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.AppointmentId AS appointmentId
        WHERE AppointmentId = @appointmentId AND PatientId = @userId
          AND Status = N'PendingPayment' AND PaymentStatus = N'Pending' AND StartAt > SYSUTCDATETIME()
          AND NOT EXISTS (SELECT 1 FROM dbo.Payments p WITH (UPDLOCK, HOLDLOCK)
            WHERE p.AppointmentId = dbo.Appointments.AppointmentId AND p.Status = N'Created')`);
    if (!result.recordset[0]) throw new ApiError(404, "A cancellable appointment was not found.", "NOT_FOUND");
    await transaction.commit();
    return { cancelled: true };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function updateAppointmentStatus(user: AuthUser, appointmentId: string, body: unknown) {
  const parsed = z.object({ status: z.enum(["Rejected", "Cancelled", "Completed"]) }).safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Appointment status is invalid.", "VALIDATION_ERROR");
  const status = parsed.data.status;
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, appointmentId)
      .input("doctorId", sql.UniqueIdentifier, user.userId)
      .input("status", sql.NVarChar(12), status)
      .query(`UPDATE dbo.Appointments WITH (UPDLOCK, HOLDLOCK) SET Status = @status, UpdatedAt = SYSUTCDATETIME()
        OUTPUT INSERTED.AppointmentId AS appointmentId, INSERTED.Status AS status
        WHERE AppointmentId = @appointmentId AND DoctorId = @doctorId
          AND ((@status = N'Rejected' AND Status = N'PendingPayment' AND PaymentStatus = N'Pending') OR
               (@status = N'Cancelled' AND Status = N'PendingPayment' AND PaymentStatus = N'Pending' AND StartAt > SYSUTCDATETIME()) OR
               (@status = N'Completed' AND Status = N'Confirmed' AND PaymentStatus = N'Paid' AND EndAt <= SYSUTCDATETIME()))
          AND (@status = N'Completed' OR NOT EXISTS (SELECT 1 FROM dbo.Payments p WITH (UPDLOCK, HOLDLOCK)
            WHERE p.AppointmentId = dbo.Appointments.AppointmentId AND p.Status = N'Created'))`);
    if (!result.recordset[0]) throw new ApiError(409, "Appointment status cannot be changed.", "INVALID_STATUS_TRANSITION");
    await transaction.commit();
    return result.recordset[0];
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function authorizedPatientDetails(user: AuthUser, appointmentId: string) {
  const pool = await getPool();
  const result = await pool.request()
    .input("appointmentId", sql.UniqueIdentifier, appointmentId)
    .input("doctorId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT p.UserId AS patientId, p.FullName AS fullName
      FROM dbo.Appointments a INNER JOIN dbo.PatientProfiles p ON p.UserId = a.PatientId
      WHERE a.AppointmentId = @appointmentId AND a.DoctorId = @doctorId
        AND a.Status IN (N'Confirmed', N'Completed') AND a.PaymentStatus = N'Paid'
        AND EXISTS (SELECT 1 FROM dbo.DoctorProfiles d WHERE d.UserId = a.DoctorId
          AND d.VerificationStatus = N'Approved')`);
  if (!result.recordset[0]) throw new ApiError(404, "Authorized patient information was not found.", "NOT_FOUND");
  return result.recordset[0];
}

export async function prescriptions(user: AuthUser, appointmentId?: string) {
  const pool = await getPool();
  const result = await pool.request()
    .input("userId", sql.UniqueIdentifier, user.userId)
    .input("appointmentId", sql.UniqueIdentifier, appointmentId ?? null)
    .input("role", sql.NVarChar(10), user.role)
    .query(`SELECT p.PrescriptionId AS prescriptionId, p.AppointmentId AS appointmentId,
        p.PatientId AS patientId, p.DoctorId AS doctorId, p.Instructions AS instructions,
        p.CreatedAt AS createdAt, i.PrescriptionItemId AS itemId, i.ItemName AS itemName,
        i.Dosage AS dosage, i.Frequency AS frequency, i.Duration AS duration, i.Instructions AS itemInstructions
      FROM dbo.Prescriptions p INNER JOIN dbo.PrescriptionItems i ON i.PrescriptionId = p.PrescriptionId
      WHERE ((@role = N'Patient' AND p.PatientId = @userId) OR (@role = N'Doctor' AND p.DoctorId = @userId))
        AND (@appointmentId IS NULL OR p.AppointmentId = @appointmentId)
      ORDER BY p.CreatedAt DESC`);
  return result.recordset;
}

export async function createPrescription(user: AuthUser, body: unknown) {
  const parsed = prescriptionSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Prescription details are invalid.", "VALIDATION_ERROR");
  const appointment = await requireAuthorizedConsultation(user, parsed.data.appointmentId);
  assertPrescriptionDoctor(user.role, user.userId, appointment.doctorId);
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const created = await new sql.Request(transaction)
      .input("appointmentId", sql.UniqueIdentifier, parsed.data.appointmentId)
      .input("patientId", sql.UniqueIdentifier, appointment.patientId)
      .input("doctorId", sql.UniqueIdentifier, user.userId)
      .input("instructions", sql.NVarChar(2000), parsed.data.instructions ?? null)
      .query(`INSERT INTO dbo.Prescriptions (AppointmentId, PatientId, DoctorId, Instructions)
        OUTPUT INSERTED.PrescriptionId AS prescriptionId
        VALUES (@appointmentId, @patientId, @doctorId, @instructions)`);
    const prescriptionId = created.recordset[0].prescriptionId as string;
    for (const item of parsed.data.items) {
      await new sql.Request(transaction)
        .input("prescriptionId", sql.UniqueIdentifier, prescriptionId)
        .input("itemName", sql.NVarChar(160), item.itemName)
        .input("dosage", sql.NVarChar(120), item.dosage ?? null)
        .input("frequency", sql.NVarChar(120), item.frequency ?? null)
        .input("duration", sql.NVarChar(120), item.duration ?? null)
        .input("instructions", sql.NVarChar(500), item.instructions ?? null)
        .query(`INSERT INTO dbo.PrescriptionItems
          (PrescriptionId, ItemName, Dosage, Frequency, Duration, Instructions)
          VALUES (@prescriptionId, @itemName, @dosage, @frequency, @duration, @instructions)`);
    }
    await transaction.commit();
    return { prescriptionId };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function medicalRecords(user: AuthUser) {
  const pool = await getPool();
  const result = await pool.request().input("userId", sql.UniqueIdentifier, user.userId)
    .input("role", sql.NVarChar(10), user.role)
    .query(`SELECT DISTINCT r.MedicalRecordId AS medicalRecordId, r.PatientId AS patientId,
        r.RecordType AS recordType, r.FileName AS fileName, r.ContentType AS contentType, r.CreatedAt AS createdAt
      FROM dbo.MedicalRecords r
      WHERE (@role = N'Patient' AND r.PatientId = @userId)
        OR (@role = N'Doctor' AND EXISTS (SELECT 1 FROM dbo.Appointments a
          WHERE a.PatientId = r.PatientId AND a.DoctorId = @userId AND a.AppointmentId = r.AppointmentId
            AND a.Status IN (N'Confirmed', N'Completed') AND a.PaymentStatus = N'Paid'
            AND EXISTS (SELECT 1 FROM dbo.DoctorProfiles d WHERE d.UserId = a.DoctorId
              AND d.VerificationStatus = N'Approved')))
      ORDER BY r.CreatedAt DESC`);
  return result.recordset;
}

export async function createMedicalRecord(user: AuthUser, body: unknown) {
  const parsed = medicalRecordSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Medical record details are invalid.", "VALIDATION_ERROR");
  const { patientId, appointmentId, recordType, fileName, objectKey, contentType } = parsed.data;
  if (user.role === "Patient") assertOwnPatientData(user.userId, patientId);
  if (user.role === "Patient" && appointmentId) await requirePatientAppointment(user, appointmentId);
  if (user.role === "Doctor") {
    if (!appointmentId) throw new ApiError(403, "An authorized appointment is required.", "FORBIDDEN");
    const appointment = await requireAuthorizedConsultation(user, appointmentId);
    if (appointment.doctorId.toLowerCase() !== user.userId.toLowerCase() ||
        appointment.patientId.toLowerCase() !== patientId.toLowerCase()) {
      throw new ApiError(403, "This patient is not authorized for this doctor.", "FORBIDDEN");
    }
  }
  if (!objectKey.startsWith(`medical-records/${patientId}/`)) {
    throw new ApiError(400, "Medical document key is invalid.", "INVALID_DOCUMENT");
  }
  await verifyPrivateUpload(objectKey, contentType);
  const pool = await getPool();
  const result = await pool.request()
    .input("patientId", sql.UniqueIdentifier, patientId)
    .input("uploadedBy", sql.UniqueIdentifier, user.userId)
    .input("appointmentId", sql.UniqueIdentifier, appointmentId ?? null)
    .input("recordType", sql.NVarChar(80), recordType)
    .input("fileName", sql.NVarChar(255), fileName)
    .input("objectKey", sql.NVarChar(512), objectKey)
    .input("contentType", sql.NVarChar(120), contentType)
    .query(`INSERT INTO dbo.MedicalRecords (PatientId, UploadedBy, AppointmentId, RecordType, FileName, ObjectKey, ContentType)
      OUTPUT INSERTED.MedicalRecordId AS medicalRecordId
      VALUES (@patientId, @uploadedBy, @appointmentId, @recordType, @fileName, @objectKey, @contentType)`);
  return { medicalRecordId: result.recordset[0].medicalRecordId };
}

export async function medicalRecordUploadUrl(user: AuthUser, body: unknown) {
  const parsed = patientDocumentUploadSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Upload details are invalid.", "VALIDATION_ERROR");
  const { patientId, appointmentId, contentType } = parsed.data;
  if (user.role === "Patient") assertOwnPatientData(user.userId, patientId);
  if (user.role === "Patient" && appointmentId) await requirePatientAppointment(user, appointmentId);
  if (user.role === "Doctor") {
    if (!appointmentId) throw new ApiError(403, "An authorized appointment is required.", "FORBIDDEN");
    const appointment = await requireAuthorizedConsultation(user, appointmentId);
    if (appointment.doctorId.toLowerCase() !== user.userId.toLowerCase() ||
        appointment.patientId.toLowerCase() !== patientId.toLowerCase()) {
      throw new ApiError(403, "This patient is not authorized for this doctor.", "FORBIDDEN");
    }
  }
  return createPrivateUploadUrl(`medical-records/${patientId}`, contentType);
}

export async function medicalRecordDownload(user: AuthUser, recordId: string) {
  const pool = await getPool();
  const result = await pool.request()
    .input("recordId", sql.UniqueIdentifier, recordId)
    .input("userId", sql.UniqueIdentifier, user.userId)
    .input("role", sql.NVarChar(10), user.role)
    .query(`SELECT r.ObjectKey AS objectKey, r.AppointmentId AS appointmentId
      FROM dbo.MedicalRecords r
      WHERE r.MedicalRecordId = @recordId AND
        ((@role = N'Patient' AND r.PatientId = @userId) OR
         (@role = N'Doctor' AND EXISTS (SELECT 1 FROM dbo.Appointments a
           WHERE a.AppointmentId = r.AppointmentId AND a.PatientId = r.PatientId
             AND a.DoctorId = @userId AND a.Status IN (N'Confirmed', N'Completed') AND a.PaymentStatus = N'Paid'
             AND EXISTS (SELECT 1 FROM dbo.DoctorProfiles d WHERE d.UserId = a.DoctorId
               AND d.VerificationStatus = N'Approved')))`);
  if (!result.recordset[0]) throw new ApiError(404, "Medical record was not found.", "NOT_FOUND");
  return createPrivateReadUrl(result.recordset[0].objectKey as string);
}

export async function paymentHistory(user: AuthUser) {
  const pool = await getPool();
  const column = user.role === "Patient" ? "PatientId" : "DoctorId";
  const result = await pool.request().input("userId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT PaymentId AS paymentId, AppointmentId AS appointmentId, AmountPaise AS amountPaise,
        CommissionPaise AS commissionPaise, DoctorEarningsPaise AS doctorEarningsPaise,
        Currency AS currency, Status AS status, CreatedAt AS createdAt
      FROM dbo.Payments WHERE ${column} = @userId ORDER BY CreatedAt DESC`);
  return result.recordset;
}

export async function doctorEarnings(user: AuthUser) {
  const pool = await getPool();
  const result = await pool.request().input("doctorId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT COUNT_BIG(*) AS paidPayments,
        COALESCE(SUM(AmountPaise), 0) AS grossPaise,
        COALESCE(SUM(CommissionPaise), 0) AS commissionPaise,
        COALESCE(SUM(DoctorEarningsPaise), 0) AS earningsPaise
      FROM dbo.Payments WHERE DoctorId = @doctorId AND Status = N'Paid'`);
  return result.recordset[0];
}

export async function recordAdministrativeAudit(userId: string, action: string, type: string, id: string | null) {
  await audit(userId, action, type, id);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "number" in error &&
    ((error as { number?: number }).number === 2601 || (error as { number?: number }).number === 2627);
}
