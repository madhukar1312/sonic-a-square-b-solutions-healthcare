import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createSession, createCsrfToken, type Role } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getPool, sql } from "@/lib/db/pool";
import { ApiError } from "@/lib/security/errors";
import { credentialsSchema, loginSchema } from "@/lib/validation/schemas";

type AccountRow = { userId: string; email: string; role: Role; passwordHash: string };
let dummyPasswordHash: Promise<string> | undefined;

export async function registerAccount(
  body: unknown,
  role: Exclude<Role, "Admin">,
  response: NextResponse,
): Promise<{ userId: string; email: string; role: Role }> {
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Registration details are invalid.", "VALIDATION_ERROR");
  const { email, password, fullName } = parsed.data;
  const passwordHash = await hashPassword(password);
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let userId = "";
  try {
    const request = new sql.Request(transaction);
    const inserted = await request
      .input("email", sql.NVarChar(254), email)
      .input("passwordHash", sql.NVarChar(100), passwordHash)
      .input("role", sql.NVarChar(10), role)
      .query(`INSERT INTO dbo.Users (Email, PasswordHash, Role)
        OUTPUT INSERTED.UserId AS userId VALUES (@email, @passwordHash, @role)`);
    userId = inserted.recordset[0].userId as string;
    const profileRequest = new sql.Request(transaction).input("userId", sql.UniqueIdentifier, userId)
      .input("fullName", sql.NVarChar(120), fullName);
    if (role === "Patient") {
      await profileRequest.query("INSERT INTO dbo.PatientProfiles (UserId, FullName) VALUES (@userId, @fullName)");
    } else {
      await profileRequest.query("INSERT INTO dbo.DoctorProfiles (UserId, FullName) VALUES (@userId, @fullName)");
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    if (isUniqueViolation(error)) throw new ApiError(409, "An account with this email already exists.", "EMAIL_IN_USE");
    throw error;
  }

  const csrfToken = createCsrfToken();
  await createSession(userId, csrfToken, response);
  return { userId, email, role };
}

export async function loginAccount(body: unknown, response: NextResponse): Promise<{ userId: string; email: string; role: Role }> {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Email or password is invalid.", "VALIDATION_ERROR");
  const pool = await getPool();
  const result = await pool.request()
    .input("email", sql.NVarChar(254), parsed.data.email)
    .query(`SELECT UserId AS userId, Email AS email, Role AS role, PasswordHash AS passwordHash
      FROM dbo.Users WHERE Email = @email AND IsActive = 1`);
  const user = result.recordset[0] as AccountRow | undefined;
  const hashToCheck = user?.passwordHash ?? await (dummyPasswordHash ??= hashPassword(randomBytes(32).toString("hex")));
  if (!(await verifyPassword(parsed.data.password, hashToCheck)) || !user) {
    throw new ApiError(401, "Email or password is invalid.", "INVALID_CREDENTIALS");
  }
  const csrfToken = createCsrfToken();
  await createSession(user.userId, csrfToken, response);
  return { userId: user.userId, email: user.email, role: user.role };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "number" in error &&
    ((error as { number?: number }).number === 2601 || (error as { number?: number }).number === 2627);
}
