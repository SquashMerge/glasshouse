# Local authentication and revocable sessions

Issue #189 adds the API over #188's [credential/bootstrap service](local-credentials-runbook.md). The [#190 browser/account flows](local-account-management.md) use these opaque cookie sessions, including fetch-based SSE; Basic remains operator/API compatibility.

## Deployment and transport

Serve the browser and `/v1` API through the **same HTTPS origin**. Set `NODE_ENV=production` and, behind a proxy, `ASTRAEA_PUBLIC_ORIGIN=https://your-astraea-host`. Use one exact origin (scheme, host and optional port), without a path/trailing slash; forwarded headers are not trusted to select it. Without this setting, development checks the request URL's origin. Compose forwards it to the API. Disable secret-bearing auth request-body/header diagnostics in external proxies/APM.

| Method/path | Contract |
| --- | --- |
| `POST /v1/auth/login` | JSON `{username,password}` only. Server-selected Organization, Argon2id verification, fresh random session per success; returns `{ok:true}`. Client actor/role/Organization claims are rejected. Header-only Basic prevalidation remains for compatibility and creates no local session. |
| `GET /v1/auth/session` | Trusted Actor/Organization IDs, local username, authentication kind, immutable expiry, separate `csrf_token`. Basic reports NULL username/expiry/CSRF. No role claims are cached. |
| `POST /v1/auth/logout` | Cookie + CSRF revokes only this session; clears the cookie with matching attributes. Basic has no server session to revoke. |
| `POST /v1/auth/password` | Local session + CSRF, `{current_password,new_password}`; compare-and-set verification, revocation of all account sessions and cookie clearing. Sign in again afterward. |
| `GET /v1/auth/setup` | Content-free `{available}` only. |
| `POST /v1/auth/setup` | Username/password + operator-provisioned single-use token through #188's atomic first-Admin gate. Creates no session automatically. |
| `POST /v1/auth/invitations/accept` | Enrollment token + first password through #188's single-use service. Creates no session automatically. |

Sessions use **32 CSPRNG bytes**, unpadded base64url; only a SHA-256 one-way token digest is stored in PostgreSQL. The **8-hour absolute lifetime** is immutable and capped at storage time. There is no sliding renewal; reauthenticate for a new session. Admission caps active sessions at **10 per account**, revokes the oldest, and prunes expired/revoked records. PostgreSQL checks expiry against its current clock. Credential-version changes, disablement, expiry and revocation fail closed; re-enabling an account never restores old sessions. Migration `0101_local_sessions.sql` is additive over exact #188, imports no passwords or sessions, and preserves roles/grants/audit history. It is included in the production image's root-relative migration directory and applied by the normal startup runner.

The host-only cookie explicitly sets `HttpOnly; SameSite=Strict; Path=/v1; Max-Age=28800; Expires=...` and **Secure in production**. Its raw value travels only in `Set-Cookie`/`Cookie`, never API JSON, OpenAPI examples, logs or audits. Do not read/store it in browser JavaScript or web storage. Cookie clients fetch the separate, session-bound CSRF value from `/v1/auth/session` and send `x-astraea-csrf` on **every unsafe method**, including OTLP. This value is not a bearer token. Foreign Origin and cross-site/same-site Fetch Metadata fail closed; login/setup/enrollment also check Origin to prevent login/setup CSRF. Non-browser clients may omit browser Origin/Fetch Metadata, but cookie mutations still require CSRF.

**Precedence:** any presented session cookie wins over Basic, including malformed, duplicated, expired or revoked cookies. Basic cannot rescue a bad cookie or suppress CSRF. Remove a stale cookie before switching to Basic. Basic still verifies environment secrets and server-provisioned `basic:v1` identities, checks account eligibility, and uses the same downstream authorization. There is no account linking by username/email. Basic password rotation remains in deployment secrets. Retain the configured Basic operator recovery identity in local-bootstrap mode.

The browser posts local credentials once, keeps the display name and CSRF value only in memory, restores session context after reload, and sends CSRF on mutations (including POST SSE requests). It does not persist local passwords or read the HttpOnly cookie. Sign-out revokes the session before clearing workspace state. Basic environment passwords are never imported into local accounts; provision a local credential separately using the guarded setup/enrollment paths.

## Failure admission, revocation and audits

Wrong username/password, unavailable accounts, lockout and invalid auth payloads return the same `401 UNAUTHORIZED / Authentication required` without a cookie. Unknown/disabled/passwordless usernames perform dummy Argon2id verification. Login permits **four concurrent password verifications per API process** without an unbounded verification queue. PostgreSQL coordinates a **120-attempt/60-second Organization budget** and **5 attempts/15-minute fixed username bucket** across processes; success clears its bucket. Only an 8-bit bucket and a global bucket are persisted, never username/IP/device/user-agent: anonymous state is bounded to **257 rows per Organization**. Collisions can temporarily lock out another account, never grant access. Denials do not extend the window. Setup, enrollment, password change and Basic prevalidation share this admission service with their own identifiers. Apply deployment edge limits for availability.

Append-only `local_auth_audit_events` contain IDs, action and time only: successful/failed/limited login, session logout, credential changes. Failed attempts contain no username or inferred Actor. Application auth logs use safe IDs/event names only. Passwords, hashes, cookies, headers, digests and raw tokens are excluded from responses/diagnostics; auth responses are `no-store`.

Storage-level password/reset/algorithm/version or enabled-state changes revoke every account session and increment storage-managed `auth_version`. Logout revokes only the current session. `LocalCredentialStore.initiatePasswordReset` is an Admin-only same-Organization service boundary for the account-management slice: clear the target password, revoke sessions/outstanding enrollments, and produce a replacement seven-day single-use enrollment token for secure delivery. It is not a public recovery endpoint. Sole/last-Admin recovery remains the configured Basic operator's existing break-glass authority.

## Route and authorization inventory

The complete method/path inventory is checked in as **`openapi.yaml`**. The session regression iterates **every registered operation**, checks its security declaration and unauthenticated denial, and separately inventories raw/documentation/internal paths. Only these method-exact operations are public:

- `GET`/implicit `HEAD /health` and `/v1/health`: content-free PostgreSQL/ClickHouse/Valkey readiness.
- `GET /v1/auth/setup`: availability only.
- `POST /v1/auth/setup`: guarded operator-token consumption.
- `POST /v1/auth/login`: bounded credential verification.
- `POST /v1/auth/invitations/accept`: guarded one-time enrollment.

All other methods/paths—including `/openapi.json`, `/reference`, raw OTLP, Agent Introspection, SSE, Admin/recovery and unknown `/internal/*`—require authentication. No HTTP worker bypass exists. The narrow `/v1` cookie is not automatically sent to root documentation paths; use Basic there or inspect the local artifact. OpenAPI reads declare Cookie or Basic; mutations also declare CSRF for Cookie. Self-password change declares local-session-only security.

| Entry point | Authorization/fence contract |
| --- | --- |
| Workspace boot (`/v1/me`, Project list/create) | Accept durable local identities without fabricating legacy memberships. Roles/grants are request-time PostgreSQL decisions. |
| REST and raw OTLP | Credential/session SHARE fences cover handler settlement. Repository membership → Project → audit fences still enforce tenant/operation. Disable/logout/reset wins first → no effect; request wins first → revocation waits for the admitted effect. Existing remote effect-claim semantics apply. |
| SSE | No connection-long transaction; each comment/heartbeat/snapshot/data frame rechecks and holds credential/session and current Project authority through delivery. Revocation/expiry aborts subsequent frames. |
| Workers and recovery | Dispatch/persistence/recovery use durable requester Actor, current account eligibility, roles/grants and Project fences. Local optimization provenance uses server-derived `actor:<uuid>`; role/grant revocation cancels its jobs too. Independently admitted background jobs use Actor authority rather than a browser session lifetime: logout/password rotation does not cancel a job, while account disablement/current-role denial prevents later effects. Internal evaluation identities remain server-only and tenant-scoped. |
| Remaining Basic-only SQL | Identity bootstrap/recovery and legacy membership lock/projection/backfill queries intentionally preserve Basic compatibility records. They are not local workspace authorization gates. Governance preview consumption and optimization requester lookup now accept trusted local provenance. |

Credential fences precede membership/Project/audit locks. Request fences use a separate bounded authentication pool so waiting requests do not consume repository connections. Auth-control mutations revalidate in their own credential transaction. Revocation must not replay an admitted mutation.

Migration `0102_local_actor_execution_scope.sql` updates the Experiment and Evaluation Run requester-scope triggers to accept eligible `local:v1` human actors alongside Basic actors. Organization/Project provenance constraints remain in force; internal worker identities cannot impersonate human requesters. The real admission regression creates and publishes an Evaluation Definition, admits its Run and tasks, checks restart recovery, then disables the local actor and verifies no later dispatch/recovery admission.

## Verification

Inside the isolated devcontainer:

```sh
bun install --frozen-lockfile
make devcontainer-db-migrate
bash infra/scripts/with-local-env.sh bun test --cwd apps/api tests/integration/local-credentials.test.ts tests/integration/local-sessions.test.ts
bun run test:pg-migration-filenames
bun run openapi:snapshot
bun run openapi:check
make test-db-migrations
```

The wrapper selects the private service-network URL, overriding copied host-local URLs. The session suite creates/drops fresh and populated-0100 databases, verifies storage guards, workspace boot, CSRF/cookies, OTLP, every protected route and per-frame SSE; it observes actual PostgreSQL waiters for both auth-vs-disable/revoke race winners and checks denied writes/audits/provider work. The Docker-backed migration CI harness also runs the suite. If nested Docker is unavailable, report the full harness unverified and run focused PostgreSQL tests on the devcontainer network.

Hosted E2E starts its fresh database in local-bootstrap mode with `ASTRAEA_PUBLIC_ORIGIN=http://localhost:5173`. CI generates and masks a random one-time operator token and a separate test-only local password, runs `auth:provision-bootstrap`, then `infra/scripts/setup-e2e-local-auth.ts` checks setup availability, consumption, permanent closure, and replay rejection. Only afterward does CI grant its legacy Basic owner access through the existing bootstrap command. Browser helpers use `E2E_LOCAL_USERNAME` / `E2E_LOCAL_PASSWORD`; direct API fixtures retain `UI_USERNAME` / `UI_PASSWORD`. E2E uses one browser worker for the shared account's bounded sessions/verification capacity. Traces, screenshots, video recording, and automatic failure-page snapshots (`PLAYWRIGHT_NO_COPY_PROMPT`) are disabled to keep passwords and session cookies out of artifacts. The browser suite checks local cookie login/reload/logout and direct Basic prevalidation/session/project access separately.

The separate `local-onboarding` CI job keeps Basic bootstrap grants disabled and uses `infra/scripts/prepare-local-auth-e2e.ts` to provision a restricted-permission operator setup file. Its browser creates the first local Admin, consumes manual first-password enrollments, checks account-management and last-Admin behavior at mobile/desktop widths, and verifies setup stays closed after restart. Its local `UI_PASSWORD` is independently random and masked, not the Basic API fixture password; setup/enrollment/password inputs avoid secret-bearing Playwright call logs. Both auth jobs disable failure-page snapshots and auth recordings, and always remove their setup files and isolated stacks.
