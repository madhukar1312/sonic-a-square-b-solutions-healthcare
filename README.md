# Sonic Healthcare Platform

Company: Sonic A Square B Solutions Pvt. Ltd.

The responsive patient/doctor interface in `index.html`, `styles.css`, and `script.js` is served unchanged at `/`; its JavaScript uses same-origin authenticated APIs. Account registration/login, profiles, saved language preference, approved-doctor search, available-time display, appointment and record lists, doctor availability/profile updates, authorized prescriptions, appointment status changes, and payment-derived earnings use the SQL Server backend.

Online booking is unavailable until checkout is configured; the interface does not create unpaid reservations. Private medical/credential document storage and telehealth are not configured, so uploads and calls are unavailable. The configured local database has no imported provider or patient records. **This setup is not ready for clinical production use; do not enter real health or identity information.**

The backend is a Next.js App Router REST API using TypeScript, SQL Server, parameterized `mssql` queries, Zod validation, bcrypt password hashes, HTTP-only database-backed sessions, and optional private Azure Blob Storage. Razorpay is restricted to test keys.

## Run locally

1. Install Node.js 20 LTS or newer.
2. Install dependencies: `npm install`.
3. Copy `.env.example` to `.env.local` and fill in the values below. Do not commit `.env.local`.
4. Create an empty SQL Server database named `SonicHealthcare` (or your chosen name).
5. Apply the schema from the repository root using SQLCMD:

   ```powershell
   sqlcmd -S <server> -d SonicHealthcare -U <migration-user> -P <migration-password> -i database\schema.sql
   ```

   `database\schema.sql` includes the versioned migrations in order. They create missing tables, indexes, and the account language-preference field; the consultation-fee migration brings existing doctor profile fees into the ₹350–₹600 range and enforces that limit. The migrations do not drop tables.
6. Configure a separate least-privilege application SQL login. Grant it only the `SELECT`, `INSERT`, `UPDATE`, and `DELETE` permissions it needs on `dbo`; do not run the app as `db_owner` or `sysadmin`.
7. Start the server: `npm run dev`. Open `http://localhost:3000`; the interface and `/api/...` endpoints are served from the same origin.

Production commands: `npm run build`, then `npm start`.

## Environment variables

Required for database-backed APIs:

| Variable | Purpose |
|---|---|
| `DB_SERVER` | SQL Server host |
| `DB_PORT` | SQL Server port; defaults to `1433` |
| `DB_NAME` | Database name; defaults to `SonicHealthcare` |
| `DB_USER` / `DB_PASSWORD` | Least-privilege application login |
| `DB_ENCRYPT` | TLS for the SQL Server connection; keep `true` in production |
| `DB_TRUST_SERVER_CERTIFICATE` | Keep `false` in production |
| `AUTH_SECRET` | Random secret of at least 32 characters used to HMAC session-token hashes |

Generate a secret locally in PowerShell with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Optional integrations:

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay test credentials. The key ID must start with `rzp_test_`; live keys are rejected. |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured for the Razorpay webhook endpoint |
| `PLATFORM_COMMISSION_BPS` | Commission in basis points (100 = 1%). Defaults to `0`; configure only after approving the business rate. |
| `AZURE_STORAGE_CONNECTION_STRING` | Server-only Azure Blob Storage connection string |
| `MEDICAL_RECORDS_CONTAINER` | Private blob container for credentials and medical documents |
| `JITSI_BASE_URL` / `JITSI_APP_SECRET` | Reserved for a future authenticated telehealth provider adapter; join currently returns `503` until an adapter is implemented and validated. |

Never put these values in browser code. Do not enable public access on the Azure container. Document upload links grant create/write access for five minutes; authorized download links grant read access for five minutes. Supported documents are PDF, JPEG, and PNG; metadata registration rejects files larger than 20 MiB. The upload SAS itself does not impose a byte limit, so use a server-side upload gateway or Azure policy to enforce size and malware scanning before production.

## Admin provisioning

Public registration has only patient and doctor routes; it cannot assign `Admin`. Provision an administrator out-of-band after applying the schema. Generate a bcrypt hash using `bcryptjs` on a trusted machine, then run `database\seeds\001_admin_seed.sql` with SQLCMD variables `AdminEmail` and `AdminPasswordHash`. The seed intentionally contains no default account or password.

## Cookie and request security

- Obtain a CSRF token from `GET /api/auth/csrf` before a state-changing request. Send it as both the `sonic_csrf` cookie and `x-csrf-token` header; the browser receives the cookie automatically.
- State-changing requests also require a matching `Origin` and `Host`. Do not add permissive CORS rules.
- The authentication cookie is HTTP-only, SameSite strict, Secure in production, random, opaque, and stored only as an HMAC hash in SQL Server. Passwords are bcrypt-hashed. Tokens are never stored in localStorage.
- The in-memory auth rate limiter is per Node process. For multi-instance production, replace it with a shared store and configure the trusted reverse proxy to overwrite forwarding headers.
- `UserSessions` expire after seven days. Logout revokes the server-side session.

## REST endpoints

Every write endpoint requires CSRF and same-origin checks, except the Razorpay webhook, which verifies Razorpay's HMAC signature. `Admin` access is checked on the server.

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/auth/csrf` | Public; obtain CSRF cookie/token |
| POST | `/api/auth/register/patient` | Public; registers a patient |
| POST | `/api/auth/register/doctor` | Public; doctor starts Pending |
| POST | `/api/auth/login` | Public; rate limited |
| POST | `/api/auth/logout` | Authenticated |
| GET | `/api/auth/me` | Authenticated |
| GET / PATCH | `/api/profile/language` | Authenticated; the account's preferred language (`en` or `te`) |
| GET / PATCH | `/api/patients/me` | Patient; own profile |
| GET | `/api/doctors?q=&specialization=` | Public; approved doctors only |
| GET | `/api/doctors/{doctorId}` | Public; approved doctor details and server-set fee |
| GET | `/api/doctors/{doctorId}/availability?from=&to=` | Public; up to 31 days |
| GET / PATCH | `/api/doctors/me` | Doctor; profile, ₹350–₹600 consultation fee, verification state |
| GET / POST | `/api/doctors/credentials` | Doctor; submit/view credential metadata |
| POST | `/api/doctors/credentials/upload-url` | Doctor; short-lived private PDF upload URL |
| POST / DELETE | `/api/doctors/availability[/{availabilityId}]` | Approved Doctor; set/remove slots |
| GET | `/api/doctors/appointments` | Doctor; assigned appointments |
| GET | `/api/doctors/appointments/{appointmentId}/patient` | Assigned, paid Doctor; limited patient details |
| PATCH | `/api/doctors/appointments/{appointmentId}/status` | Doctor; reject/cancel unpaid request or complete past paid consultation |
| GET | `/api/doctors/earnings` | Doctor; paid earnings summary |
| GET / POST | `/api/appointments` | Patient; own list (`?period=upcoming|previous`, default `all`) / transactional booking |
| DELETE | `/api/appointments/{appointmentId}` | Patient; cancel eligible unpaid reservation |
| GET / POST | `/api/prescriptions` | Patient/Doctor view own items; assigned Doctor creates for paid consultation |
| GET / POST | `/api/medical-records` | Patient/Doctor; authorized metadata only |
| POST | `/api/medical-records/upload-url` | Patient/Doctor; short-lived private upload URL |
| GET | `/api/medical-records/{recordId}/url` | Patient or assigned Doctor; short-lived signed read URL |
| POST | `/api/payments/orders` | Patient; creates Razorpay test order from database fee |
| POST | `/api/payments/verify` | Patient; verifies signature and captured payment with Razorpay |
| POST | `/api/payments/webhooks/razorpay` | Razorpay; raw-body signature and event-id deduplication |
| GET | `/api/payments/history` | Patient/Doctor; own payment history |
| POST | `/api/consultations/{appointmentId}/join` | Assigned paid Patient/approved Doctor, within appointment window; currently documented `503` placeholder |
| GET | `/api/admin/users` | Admin |
| GET | `/api/admin/doctors/credentials` | Admin |
| GET | `/api/admin/credentials/{credentialId}/url` | Admin; short-lived credential document URL |
| POST | `/api/admin/credentials/{credentialId}/review` | Admin |
| POST | `/api/admin/doctors/{doctorId}/review` | Admin; approval requires an approved credential |
| GET | `/api/admin/appointments` | Admin |
| GET | `/api/admin/payments` | Admin |
| GET | `/api/admin/commissions` | Admin |
| GET | `/api/admin/audit-logs` | Admin |

For browser clients, first call `/api/auth/csrf`, read the non-HTTP-only `sonic_csrf` cookie, then send it in `x-csrf-token` for writes. After login/registration, the server rotates the CSRF cookie; read the updated value before subsequent writes.

Bookings use serializable SQL transactions, availability/appointment range locks, an overlap check, and a unique active-slot index. The API fee is sourced from SQL Server. An unfinished Razorpay order keeps its slot reserved until a terminal webhook arrives; add a provider-reconciliation job for abandoned orders before production. Paid appointments cannot be cancelled because refunds are not implemented; add and validate a refund workflow before enabling that policy.

## Tests and verification

- `npm test` runs deterministic security/validation tests and a SQL integration suite that is skipped unless `RUN_SQL_INTEGRATION_TESTS=true` and `DB_NAME` contains `test`.
- SQL integration tests create uniquely named fixtures and delete only those test-owned records. Run them only against a disposable test database after applying the migration.
- `npm run typecheck` checks TypeScript.
- `npm run build` validates the Next.js production build.

Doctor consultation fees are validated and constrained to ₹350–₹600 by the backend. The directory includes only approved provider records. Doctor payment summaries aggregate recorded paid transactions: gross fees, platform commission, and doctor earnings are calculated from the payment ledger, not the current consultation fee.

The page includes centralized English and Telugu interface resources for its copy, forms, client-side validation, appointment statuses, and notifications. The language selector updates the signed-in user's `PreferredLanguage` through `PATCH /api/profile/language`; the browser preference is a fallback when signed out. Missing or unsupported account preferences fall back to English.

The current application has no AI assistant or outbound notification-template service. The localization resources include assistant interface phrases, but an AI service or outbound notification system must apply the user's language preference when those features are introduced; no assistant or messaging integration is currently available.

No environment secrets, Razorpay credentials, or Azure storage configuration are included in this repository. The local SQL Server schema has been applied, but payment provider/webhook validation, private document uploads, and telehealth remain unavailable until their respective services are configured and verified. Do not represent the application as ready for real patient care until these integrations, security controls, compliance obligations, and end-to-end workflows have been independently configured and verified.
