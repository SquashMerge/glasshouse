# Local setup, sign-in and account management

The browser uses local usernames and the existing [opaque server session](local-sessions-runbook.md). Basic Auth remains an operator/API compatibility adapter. Public registration is disabled. These flows collect no email and implement no email delivery, provider selection or domain matching.

## First deployment

1. Select the existing Organization with `GLASSHOUSE_DEFAULT_ORGANIZATION_ID`. Set `GLASSHOUSE_AUTH_BOOTSTRAP_MODE=local` **before first start**; default Basic bootstrap would create its Admin and close local setup. Startup still applies PostgreSQL/ClickHouse migrations before serving.
2. Follow [the bootstrap runbook](local-credentials-runbook.md#first-admin-bootstrap) to generate a 32-byte base64url secret in a restricted operator file and run `auth:provision-bootstrap`. Provisioning stores only a digest and gives it 24 hours. Replace an unused/expired secret by generating a replacement file and rerunning the command; this invalidates the previous secret. Startup never provisions or extends it.
3. Serve browser and `/v1` on one HTTPS origin. Set `NODE_ENV=production` and `GLASSHOUSE_PUBLIC_ORIGIN` to that exact origin. Exclude auth bodies, Authorization/Cookie/Set-Cookie headers and code responses from proxy/APM diagnostics, analytics, browser session replay and support recordings.
4. Visit `/setup` (fresh protected visits redirect there only when the server permits setup). Enter secret, username and password. The server chooses Organization, Admin role and existing initial Project authority. No arbitrary scope/role or fabricated Project/legacy grants are accepted.
5. Sign in at `/login` after commit. Setup stays closed across reload/restart and later account changes. Concurrent setup has at most one winner; later attempts have uniform authentication failures. `/setup` only reports “unavailable or already initialized,” without account/tenant details. Delete the used secret file.

## Returning users and manual enrollment

- Login sends username/password once to obtain the HttpOnly cookie. Protected API/SSE requests use that cookie. JavaScript keeps safe session context and a separate CSRF value only in memory. Passwords, setup/enrollment codes and session cookies never enter Web Storage; legacy Basic credentials are removed from both storage types. Reload rechecks the server session before rendering the workspace.
- Moving between protected application pages reuses the verified in-memory session without a full-screen session check. Initial entry, reload, return from a public authentication page, and tab focus still check the session; expiry, logout and cross-tab invalidation retain their existing behavior. API requests continue to enforce server-side authority independently.
- Sessions expire after eight hours. Expired/invalid/revoked sessions return to login; network/server failures offer retry. Logout revokes remotely before clearing workspace data; failed logout offers retry.
- Invalid credentials, disabled/passwordless accounts and limiter denials share a non-enumerating server error. The browser explains these possibilities without identifying which applies. Wait 15 minutes after repeated failures. No public account-existence or status lookup is available.
- An Admin privately hands the account holder their username and code. Visit `/enroll`, enter the code and confirm a first password. Codes last seven days and are single-use. The UI clears code/password fields after submission. Invalid/expired/revoked/consumed/disabled cases share recovery guidance: ask the Admin for a fresh code. Never put codes in URLs.
- All local passwords—including sign-in and current-password checks—must contain at least 12 Unicode code points and no more than 1024 UTF-8 bytes. Use a long, unique passphrase and do not reuse passwords.
- Recovery is Admin-initiated re-enrollment. If no usable Admin remains, use the configured Basic owner's [existing break-glass API](08-project-workspace-authorization-runbook.md#admin-access-and-break-glass-recovery) with its confirmation, audit and cooldown. Never reopen setup. Basic is not a browser login option.

## Admin controls

Open **Settings → Access**. Local usernames, current Organization roles, status, and pending/expired/revoked/consumed enrollment history appear alongside durable-Actor role management. Lists never retrieve codes, digests, hashes or email addresses.

- **Provision:** choose a username and existing Admin/User/Read-only role. The chosen role applies to every Project in the Organization. Usernames accept 3–64 ASCII characters: first alphanumeric, then alphanumeric, `.`, `_` or `-`; case normalizes to lowercase.
- **One-time handoff:** provisioning/reset shows the code once to the authorized Admin. Hand it off privately, then dismiss. Navigation/reload/dismissal discards it; query/mutation caches and Web Storage never contain it. If a response was lost, refresh account state and issue a replacement through re-enrollment rather than blindly repeating provisioning.
- **Revoke enrollment:** prevents unused-code redemption, without disabling an enrolled account.
- **Disable:** preserves identities/roles, revokes every session and unused enrollment, and blocks login/enrollment. **Enable** never restores old sessions or revoked codes. Passwordless enabled accounts need a fresh code.
- **Re-enroll:** requires an enabled account and confirmation; removes the password, revokes sessions/unused codes and shows one replacement code.
- **Role changes:** use the existing `/v1/admin/actors/{actorId}/role` and RBAC policy. Pending/expired-passwordless/revoked-passwordless/disabled/non-Admin accounts cannot replace the last usable Admin. Disable/reset/demotion share credential and existing organization-role/advisory fences, preventing simultaneous final-Admin loss.

## Management API

Every operation requires the authenticated trusted principal and current server-side Organization Admin authority. Cookie mutations also require the existing CSRF/origin checks. Requests never choose an Organization.

| Method/path | Input / output |
| --- | --- |
| `GET /v1/admin/local-accounts` | Safe `items` list. |
| `POST /v1/admin/local-accounts` | Strict `{username,role}` → `{actor_id,enrollment_id,code}` once. |
| `PUT /v1/admin/local-accounts/{actorId}/status` | Strict `{enabled}` → `{ok:true}`. |
| `POST /v1/admin/local-accounts/{actorId}/reset` | No scope/role payload → `{actor_id,enrollment_id,code}` once. |
| `DELETE /v1/admin/local-enrollments/{enrollmentId}` | Revoke unused same-Organization enrollment → `{ok:true}`. |
| `PUT /v1/admin/actors/{actorId}/role` | Existing `{role}` contract and role/grant/audit system. |

Responses are `no-store`. Failed management effects roll back; safe errors exclude submitted secrets and database diagnostics. Authentication-control mutations revalidate credentials/session inside their own transaction, avoiding upgrades of a separate request-long SHARE fence. The public method-exact authentication inventory is unchanged.

## Verification and code generation

Inside the required isolated workspace, install the locked dependencies and run format/lint/typecheck/build, `bun run test`, `bun run openapi:check`, `bun run codegen`, `bun test --cwd apps/api tests/integration/local-accounts.test.ts`, and `make test-db-migrations`.

No schema/bootstrap migration is needed: controls use migrations 0098–0102 and existing roles/grants/audits. The new PostgreSQL suite creates/drops an isolated database, observes actual setup/credential-vs-role waiters, and checks tenant/CSRF/last-Admin rollback, one-time visibility and session invalidation. The historical migration CI harness retains its assertions and includes this suite. Hosted CI's local-first browser journey uses test-only operator provisioning, desktop/mobile enrollment and setup closure after API restart. Auth browser runs disable traces/screenshots/videos and export no HAR/storage-state or secret-bearing attachments.

`openapi.yaml` is tracked. TS/Python clients live in ignored `clients/`; regenerate through existing codegen commands rather than hand-editing clients as a second auth implementation.
