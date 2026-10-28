import { ApiError } from "@/lib/security/errors";
import type { AuthUser } from "@/lib/auth/session";
import { getPool, sql } from "@/lib/db/pool";
import { preferredLanguageSchema } from "@/lib/validation/schemas";

export async function languagePreference(user: AuthUser, body?: unknown) {
  const pool = await getPool();
  if (body === undefined) {
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, user.userId)
      .query("SELECT PreferredLanguage AS language FROM dbo.Users WHERE UserId = @userId");
    const preference = result.recordset[0] as { language: "en" | "te" } | undefined;
    if (!preference) throw new ApiError(404, "User profile was not found.", "NOT_FOUND");
    return preference;
  }

  const parsed = preferredLanguageSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Language preference is invalid.", "VALIDATION_ERROR");
  await pool.request()
    .input("userId", sql.UniqueIdentifier, user.userId)
    .input("language", sql.NVarChar(5), parsed.data.language)
    .query(`UPDATE dbo.Users SET PreferredLanguage = @language, UpdatedAt = SYSUTCDATETIME()
      WHERE UserId = @userId`);
  return { language: parsed.data.language };
}
