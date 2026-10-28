import { ApiError } from "@/lib/security/errors";
import type { Role } from "@/lib/auth/session";

export function assertRole(actual: Role, allowed: Role[]): void {
  if (!allowed.includes(actual)) throw new ApiError(403, "You are not allowed to perform this action.", "FORBIDDEN");
}

export function assertOwnPatientData(actorId: string, patientId: string): void {
  if (actorId.toLowerCase() !== patientId.toLowerCase()) {
    throw new ApiError(403, "Patients may only access their own information.", "FORBIDDEN");
  }
}

export function assertDoctorCanAcceptPaidAppointments(status: string, fee: number | null): void {
  if (status !== "Approved" || fee === null || fee <= 0) {
    throw new ApiError(403, "This doctor is not currently accepting paid appointments.", "DOCTOR_NOT_VERIFIED");
  }
}

export function assertAppointmentSlotFree(hasOverlap: boolean): void {
  if (hasOverlap) throw new ApiError(409, "This appointment slot has already been booked.", "SLOT_UNAVAILABLE");
}

export function assertPrescriptionDoctor(actorRole: Role, actorId: string, appointmentDoctorId: string): void {
  if (actorRole !== "Doctor" || actorId.toLowerCase() !== appointmentDoctorId.toLowerCase()) {
    throw new ApiError(403, "Only the appointment's doctor may issue a prescription.", "FORBIDDEN");
  }
}
