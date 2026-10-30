# Supported datastores: October 2026

## Selected versions

Checked on **2026-10-30**; these are release pins, not floating major tags.

| Store | Selected image | Selection |
|---|---|---|
| PostgreSQL | `postgres:18.6-alpine` | Latest supported stable major and minor; 19 is still RC. |
| ClickHouse | `clickhouse/clickhouse-server:26.10.2.103-alpine` | Latest official GitHub stable release, published 2026-10-24. |
| Valkey | `valkey/valkey:9.1.3-alpine` | Latest stable release, including the October Pub/Sub security fix; 9.2 is RC. |

Authoritative references:

- [PostgreSQL support/versioning](https://www.postgresql.org/support/versioning/),
  [18.6 notes](https://www.postgresql.org/docs/18/release-18-6.html), and
  [official image layout](https://github.com/docker-library/postgres/blob/master/18/alpine3.23/Dockerfile).
- [ClickHouse stable release v26.10.2.103-stable](https://github.com/ClickHouse/ClickHouse/releases/tag/v26.10.2.103-stable)
  and [Docker image tag 26.10.2.103-alpine](https://hub.docker.com/layers/clickhouse/clickhouse-server/26.10.2.103-alpine/images).
  On 2026-10-30, the official GitHub releases API reported that release as latest,
  and Docker Hub listed the matching image for amd64 and arm64. A published
  Docker tag alone does not establish official stable-release status.
- [Valkey releases](https://valkey.io/download/releases/),
  [9.1.3 images](https://valkey.io/download/releases/v9-1-3/), and
  [release notes](https://github.com/valkey-io/valkey/releases/tag/9.1.3).

The exact image tags were also checked through Docker Hub's tag API. Tags can
still be republished; operators requiring immutable artifacts should record and
approve their resolved digests.

## Runtime and recovery contract

These versions are used by development, dependency-only, production,
devcontainer, and CI deployments. PostgreSQL 18 uses versioned PGDATA beneath
the `/var/lib/postgresql` parent volume mount. ClickHouse mounts the restricted
`infra/clickhouse/backup.xml` configuration for its `File()` backup backend.
Valkey supplies authenticated Pub/Sub and disposable coordination state.

The supported data path is a fresh deployment on these versions and
[current-version backup/restore](backup-restore.md) into a separate empty target
using the same service images and database names. Legacy datastore migration,
in-place major-version conversion, cross-version restore, and older-version
backup compatibility are outside the supported contract. No legacy source
fixtures or old-store detection gates are maintained. Do not delete existing
data volumes to make startup or verification pass.

Backups retain the `glasshouse-backup-v1` artifact format. PostgreSQL restore
uses the target's bundled `pg_restore --exit-on-error --single-transaction`.
That transaction covers PostgreSQL only; there is no atomic restore across
PostgreSQL and ClickHouse. Provision another empty isolated target after a
partial restore. Artifact validation checks integrity, not server-version or
custom-schema compatibility. Valkey is rebuilt separately and is not backed up.

## Verification gates and limits

```sh
bun run test:infra-security
make test-backup-restore
# With all three isolated services reachable using the repository environment:
GLASSHOUSE_VERIFY_DATASTORE_VERSIONS=1 bash infra/scripts/with-local-env.sh bun --cwd apps/api test tests/integration/datastore-connectivity.test.ts
make test-db-migrations
```

Coding-agent commands run inside the isolated devcontainer. CI exercises fresh
application startup/restart, application SQL migration fixtures, ClickHouse
schema/tenant checks, and pg/ClickHouse/ioredis connectivity with exact version
assertions.

The current-to-current backup/restore job uses the real operator scripts with
separate source and target projects. It checks scoped JSONB/MergeTree records,
DateTime64, Map metadata, a token index, and restored tenant constraints.
Disposable Linux CI additionally sets `BACKUP_RESTORE_APPLICATION_FIXTURE=1` to
apply both full schemas, seed a real Project/Trace/Observation, restore migration
ledgers, and rerun both migration systems twice. This fixture uses private
Compose bridge IPs and must not be enabled on a live/operator source.

The fixture self-check creates/drops only uniquely named disposable databases;
it does not exercise backup/restore. When the running isolated services differ
from the pins or nested Docker is unavailable, report exact-image startup,
production-image builds, Docker-backed migration harnesses, and real Compose
backup/restore as unverified locally. Static checks and client probes are not
substitutes. Record exact PR-head CI results and an installation-specific
recovery drill before relying on production recovery.
