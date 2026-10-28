import { getPool, sql } from "@/lib/db/pool";
import { ApiError } from "@/lib/security/errors";
import type { AuthUser } from "@/lib/auth/session";

export async function audit(
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string | null = null,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const pool = await getPool();
  await pool.request()
    .input("actorUserId", sql.UniqueIdentifier, actorUserId)
    .input("action", sql.NVarChar(100), action)
    .input("entityType", sql.NVarChar(100), entityType)
    .input("entityId", sql.NVarChar(100), entityId)
    .input("metadata", sql.NVarChar(1000), JSON.stringify(metadata))
    .query(`INSERT INTO dbo.AuditLogs (ActorUserId, Action, EntityType, EntityId, MetadataJson)
      VALUES (@actorUserId, @action, @entityType, @entityId, @metadata)`);
}

export async function requirePatientAppointment(user: AuthUser, appointmentId: string) {
  const pool = await getPool();
  const result = await pool.request()
    .input("appointmentId", sql.UniqueIdentifier, appointmentId)
    .input("userId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT AppointmentId AS appointmentId, PatientId AS patientId, DoctorId AS doctorId,
        StartAt AS startAt, EndAt AS endAt, Status AS status, PaymentStatus AS paymentStatus
      FROM dbo.Appointments WHERE AppointmentId = @appointmentId AND PatientId = @userId`);
  const appointment = result.recordset[0];
  if (!appointment) throw new ApiError(404, "Appointment was not found.", "NOT_FOUND");
  return appointment;
}

export async function requireAuthorizedConsultation(user: AuthUser, appointmentId: string) {
  const pool = await getPool();
  const result = await pool.request()
    .input("appointmentId", sql.UniqueIdentifier, appointmentId)
    .input("userId", sql.UniqueIdentifier, user.userId)
    .query(`SELECT a.AppointmentId AS appointmentId, a.PatientId AS patientId, a.DoctorId AS doctorId,
        a.Status AS status, a.PaymentStatus AS paymentStatus, a.StartAt AS startAt, a.EndAt AS endAt,
        d.VerificationStatus AS verificationStatus
      FROM dbo.Appointments a INNER JOIN dbo.DoctorProfiles d ON d.UserId = a.DoctorId
      WHERE a.AppointmentId = @appointmentId AND (a.PatientId = @userId OR a.DoctorId = @userId)`);
  const appointment = result.recordset[0];
  if (!appointment) throw new ApiError(404, "Appointment was not found.", "NOT_FOUND");
  if (!["Confirmed", "Completed"].includes(appointment.status) || appointment.paymentStatus !== "Paid" ||
      appointment.verificationStatus !== "Approved") {
    throw new ApiError(403, "This appointment is not authorized for a consultation.", "CONSULTATION_NOT_AUTHORIZED");
  }
  return appointment;
}

export function requireConsultationWindow(appointment: { status: string; startAt: Date; endAt: Date }): void {
  const now = Date.now();
  const start = new Date(appointment.startAt).getTime() - 15 * 60 * 1000;
  const end = new Date(appointment.endAt).getTime() + 30 * 60 * 1000;
  if (appointment.status !== "Confirmed" || now < start || now > end) {
    throw new ApiError(403, "The consultation is outside its permitted appointment window.", "CONSULTATION_NOT_AVAILABLE");
  }
}

export function parseDate(value: string | null, label: string): Date {
  if (!value) throw new ApiError(400, `${label} is required.`, "VALIDATION_ERROR");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ApiError(400, `${label} is invalid.`, "VALIDATION_ERROR");
  return parsed;
}

export { getPool, sql };
