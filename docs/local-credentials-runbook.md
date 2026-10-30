# Local credentials and guarded bootstrap

Issue #188 supplies PostgreSQL persistence and service boundaries. The [local login/session API](local-sessions-runbook.md) is supplied by #189; [local setup and account management](local-account-management.md) supplies #190's browser UX. Browser sign-in uses cookies; Basic remains operator/API compatibility.

## Identity and storage

- Usernames are ASCII, 3–64 characters: first character alphanumeric, then alphanumeric, `.`, `_`, or `-`. ASCII case normalizes to lowercase; whitespace and non-ASCII are rejected rather than trimmed or Unicode-normalized.
- A username is unique **within an Organization**. Its existing `actor_identities` provider is `local:v1`; its canonical subject is `<organization-uuid>:<normalized-username>`, preserving the registry's global provider/subject key. Composite foreign keys bind the credential to that exact Organization, Actor, and identity. The credential identity is immutable.
- Local provisioning creates a new durable Actor. It never merges with a Basic or future IdP identity by matching username/email. Existing Basic Actor IDs, memberships, durable roles, and audit history remain intact. Migration 0098 imports no environment passwords and seeds no local accounts or tokens.
- Authorization uses `organization_actor_roles`; the role applies to every Project in that Organization. Identity links and role/bootstrap changes use existing content-free Admin audit events. No password, hash, token, email, or username is added to those events.
- `enabled=false` prevents credential verification and first-password enrollment, revokes local sessions, and denies later authenticated/worker effects. Disabling a local credential does not edit unrelated Basic credentials or roles; there is no automatic local-to-Basic account linking.

## First-Admin bootstrap

The historical `db:migrate` command runs SQL **and then grants the configured Basic owner Admin**. That remains the default (`GLASSHOUSE_AUTH_BOOTSTRAP_MODE=basic`) for continuity. It also closes local setup. For an intentionally fresh local-first deployment, set `GLASSHOUSE_AUTH_BOOTSTRAP_MODE=local` **before the first migration/start**. Local mode still validates the configured Basic recovery owner and provisions configured Basic identity mappings, but skips membership/Admin/Project bootstrap grants; it never removes existing identities, roles, or memberships. This retains the operator's existing recovery identity without granting it ordinary product access. An unsupported mode fails startup.

The target Organization must already exist. `GLASSHOUSE_DEFAULT_ORGANIZATION_ID` selects it server-side, defaulting to the seeded `00000000-0000-4000-8000-000000000001`. Provisioning never creates a tenant from request input. Retain required Basic configuration while the existing API/dashboard use it; local mode does not give fresh Basic credentials product access automatically. Switching back to Basic mode deliberately restores its existing bootstrap behavior.

Provision a **32-byte CSPRNG token encoded as unpadded base64url (43 characters)** in an operator-managed, restricted-permission file. For example, in the deployment environment:

```sh
umask 077
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > /secure/glasshouse-local-bootstrap.token
```

Do not put the token in argv, a ticket, Git, ordinary logs, or API metadata. Mount the file into the operator command environment and set:

```env
GLASSHOUSE_AUTH_BOOTSTRAP_MODE=local
GLASSHOUSE_DEFAULT_ORGANIZATION_ID=00000000-0000-4000-8000-000000000001
GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE=/secure/glasshouse-local-bootstrap.token
```

With `DATABASE_URL` configured on the deployment/service network, run from `apps/api`:

```sh
bun run db:migrate
bun run auth:provision-bootstrap
```

In an Glasshouse devcontainer use `make devcontainer-db-migrate`; run all application commands inside that workspace and use its PostgreSQL service-network URL. The token-file setting is needed only by the explicit operator command, not by normal startup. Production images already contain the API source, Bun runtime, migration runner, and root-relative SQL directory; the token file must be supplied by deployment secret mounting.

Provisioning stores only a SHA-256 digest of this high-entropy token, with an exact **24-hour** PostgreSQL expiry. It can rotate/replace an unused token; normal startup neither provisions nor extends its lifetime. Replacing it invalidates the previous token. The first setup transaction locks the Organization's bootstrap-control row, verifies the digest using `timingSafeEqual`, rechecks expiry at consumption, creates the salted password hash/Actor/identity/Admin role, appends existing audit facts, and consumes/closes the token atomically. A rollback restores the unused token. Concurrent, malformed, invalid, expired, replayed, and cross-Organization setup attempts fail without changing credentials or authorization.

Any first Admin, including a Basic/recovery-created Admin, permanently closes setup under the same database fence. Existing Admins close it during migration. It stays closed after credential disablement or subsequent role changes; disabling an Admin does not turn setup into recovery. Use the existing operator-controlled [break-glass recovery boundary](08-project-workspace-authorization-runbook.md#admin-access-and-break-glass-recovery), never reopen setup controls. Remove the token file after consumption or replacement. Any future HTTP setup/enrollment transport must use HTTPS and exclude secrets from request/access diagnostics.

## Admin-created accounts and enrollments

`LocalCredentialStore.provision` requires a server-trusted same-Organization Admin through the existing authorization lock helper. It reserves the username, creates the durable identity and chosen existing role, and creates a first-password enrollment with **no password hash until redemption**. The Organization role controls access to every Project in that Organization.

Migration `0099_usable_local_admin_guard.sql` shares `organization_actor_is_usable_admin` between final-Admin role removal and break-glass recovery. Migration `0100_usable_local_admin_identity_unlink_guard.sql` applies the same usable-Admin semantics to identity unlinking, excluding the identity being removed. A local Admin counts as usable only when its credential is enabled and has a password hash. An unredeemed, revoked, or expired passwordless Admin invitation cannot justify removing/demoting or unlinking the last usable Admin or block operator recovery when no usable Admin remains. Successful enrollment makes an enabled local Admin usable; disabling it stops it counting. Legacy/non-local identity behavior is preserved. These checks leave account records, role assignments, and permanently closed setup controls intact; recovery still requires the configured Basic owner and existing confirmation, audit, and cooldown.

- `first_use`: Admin-created account; securely deliver the generated enrollment token for first-password setting.
- The historical `email_invitation` storage variant is not exposed by #190. This slice provisions username-only `first_use` enrollments. Email/provider/domain work is deferred to #200 and external-domain invitations to #199.

Enrollment tokens use 32 random bytes, are stored only as SHA-256 digests, expire exactly **7 days** after creation, are single-use, and are Admin-revocable. Redemption atomically sets the first password and consumes the record. It cannot overwrite an existing password, enroll a disabled account, cross Organizations, or revive consumed/revoked/expired records. The service returns an enrollment token only at provisioning for secure delivery; it never returns password hashes. Subsequent HTTP adapters must avoid exposing tokens in lists, audit, logs, or snapshots. There is no public self-registration.

## Argon2id policy and calibration

`Bun.password.hash` generates the random salt and PHC string; `Bun.password.verify` performs password verification. Policy **version 1** is Argon2id v19, **64 MiB**, **3 iterations**, Bun's **p=1**. PostgreSQL stores the PHC hash, algorithm, and policy version together, or all three NULL before enrollment. Every local password—including login and current-password verification—requires at least 12 Unicode code points and no more than 1024 UTF-8 bytes. The [session API runbook](local-sessions-runbook.md) defines login admission and revocation.

From `apps/api`, `bun run auth:calibrate-passwords` runs 20 sequential hash/verify samples and emits only runtime, public policy, count, and latency percentiles. Reference measurement on the branch devcontainer with Bun 1.3.14: hash p50/p95 **91/96 ms**, verify p50/p95 **90/97 ms**. Recalibrate on deployment hardware and size memory/concurrency admission in the later login boundary; these sequential numbers are not a production-load guarantee.

Successful verification can rehash a weaker recognized PHC profile to policy 1, using a compare-and-set update that also rechecks `enabled` and the previously verified hash. Failed verification does not write. A stronger memory/iteration profile is not downgraded. Unknown algorithm/versions, malformed PHC, and excessive work factors fail closed. A future policy change must explicitly retain supported predecessor verification versions, increment the policy version, and add PostgreSQL rehash/race regression coverage; do not reinterpret an old version silently or make work factors client-controlled.

## Verification

```sh
bun run test:pg-migration-filenames
bun test --cwd apps/api tests/integration/local-credentials.test.ts
make test-db-migrations
```

The focused test requires a real `DATABASE_URL` and database-creation privileges on isolated PostgreSQL. It creates/drops dedicated databases, uses the production migration runner for fresh/current and populated-0097/0098/0099 upgrade histories, compares legacy authorization/audit continuity fixtures, tests usable-Admin role and identity-unlink guards and the real recovery handler, and requires two setup transactions to be visibly blocked simultaneously in `pg_stat_activity` before allowing exactly one commit. Unlink regressions cover pending, revoked, expired-passwordless, disabled, and successfully enrolled local Admin replacements, including preservation of role/account rows. The Docker-backed migration gate invokes it and the 0100 SQL assertions in CI. If nested Docker is unavailable in a devcontainer, report the full gate as unavailable and run the focused database suite on that container's PostgreSQL service; do not use host Docker/services as fallback.
