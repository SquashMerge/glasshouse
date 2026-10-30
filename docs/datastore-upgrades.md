# Datastore upgrade: October 2026

## Selected versions

Checked on **2026-10-30**; these are release pins, not floating major tags.

| Store | Previous deployment tag | Selected image | Selection |
|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` | `postgres:18.6-alpine` | Latest supported stable major and minor; 19 is still RC. |
| ClickHouse | `clickhouse/clickhouse-server:24-alpine` | `clickhouse/clickhouse-server:26.10.3.7-alpine` | Latest official stable package channel, including the October security fix. |
| Valkey | `valkey/valkey:8-alpine` | `valkey/valkey:9.1.3-alpine` | Latest stable release, including the October Pub/Sub security fix; 9.2 is RC. |

The old tags floated: record the **actual** source server versions and image
digests before planning an upgrade. CI's historical fixture deliberately keeps
`postgres:16.15-alpine` and `clickhouse/clickhouse-server:24.8.14.39-alpine` as
source-only versions. It does not establish compatibility for every old tag.

Authoritative references:

- [PostgreSQL support/versioning](https://www.postgresql.org/support/versioning/),
  [17 migration notes](https://www.postgresql.org/docs/17/release-17.html#RELEASE-17-MIGRATION),
  [18 migration notes](https://www.postgresql.org/docs/18/release-18.html#RELEASE-18-MIGRATION),
  [18.6 notes](https://www.postgresql.org/docs/18/release-18-6.html), and
  [official image layout](https://github.com/docker-library/postgres/blob/master/18/alpine3.23/Dockerfile).
- [ClickHouse package channel](https://packages.clickhouse.com/),
  [upgrade guidance](https://clickhouse.com/docs/operations/update),
  [2025 changelog](https://clickhouse.com/docs/resources/changelogs/oss/2025.md), and
  [2026 changelog](https://clickhouse.com/docs/resources/changelogs/oss/2026.md).
  The package channel and published image include 26.10.3.7 even though the
  GitHub releases API still lists 26.10.2.103 as its newest stable release.
- [Valkey releases](https://valkey.io/download/releases/),
  [9.1.3 images](https://valkey.io/download/releases/v9-1-3/), and
  [release notes](https://github.com/valkey-io/valkey/releases/tag/9.1.3).

The exact image tags were also checked through Docker Hub's tag API. Tags can
still be republished; operators requiring immutable artifacts should record and
approve their resolved digests.

## Compatibility assessment

### PostgreSQL 16 → 18

This is a **major-version migration**, not an existing-volume image swap.
PostgreSQL 18's image uses `PGDATA=/var/lib/postgresql/18/docker` and a volume
at `/var/lib/postgresql`. All current Compose files use that parent mount.
Existing physical volume names are retained: an old root-level `PG_VERSION`
is detected by the official entrypoint, which refuses initialization instead
of silently starting an empty database. Do not override `PGDATA`, move files,
or rename the old volume to bypass that refusal. No automatic `pg_upgrade`,
physical conversion, or in-place existing-volume guarantee is provided.

Use a logical custom-format dump on the old server and the **target's PG18
`pg_restore`** into a new, empty target. The backup tools already use server-
bundled clients; no host PostgreSQL client upgrade is needed. Restore now uses
`--exit-on-error --single-transaction` so PostgreSQL errors roll back that
store's restore. This is not an atomic restore across PostgreSQL and ClickHouse.

Review custom extensions, roles, collations and server settings separately.
The repository uses `pgcrypto`, PL/pgSQL, JSONB, ordinary indexes and advisory
locks; it does not install pgvector. PG17's maintenance `search_path` change
can affect custom expression-index functions. PG18 enables checksums for new
clusters, deprecates MD5 passwords, changes AFTER-trigger role handling, makes
virtual generated columns the default, and adds NOT NULL entries to
`pg_constraint`. Keep generated-column behavior explicit in custom schema. Keep SCRAM authentication,
rehearse all migrations/authorization triggers, rebuild indexes through logical
restore, and run `ANALYZE` on the restored target. No new application migration
is needed solely for the server upgrade.

### ClickHouse 24 → 26

Use downtime and **backup/restore to a separate empty server**, preserving the
source database name. The gap exceeds the upstream one-year rolling-upgrade
compatibility window. Do not reuse the source volume or promise a binary
downgrade to 24 after 26 has written parts.

Glasshouse uses MergeTree tables, DateTime64, Map/String payloads,
`JSONEachRow`, token/bloom/minmax skip indexes, and tenant CHECK constraints.
It does not store the native experimental JSON/Object/Dynamic types, use
Keeper/replication, disable the analyzer, or use removed WINDOW VIEW/CatBoost
features. Relevant upstream changes include the mandatory analyzer in 26.9,
new JSON serialization formats, nullable tuple-subcolumn defaults, changed
default compression (ZSTD for network traffic and larger parts), and stricter
backup disk privileges. Custom objects/profiles/grants using removed features
need remediation before migration; new codecs/serialization can prevent
downgrade. The backup backend remains `File()`, with restricted path/disk
configuration mounted in every application topology including the devcontainer.
Custom least-privilege backup accounts must have appropriate BACKUP/RESTORE and
file/disk access grants. Preserve these restrictions rather than opening an
arbitrary filesystem path. The selected stable package fixes CVE-2026-116366.

### Valkey 8 → 9.1

The application uses authenticated RESP through ioredis for PING and Pub/Sub;
the current client is retained. Pub/Sub is transient, so clients reconnect and
live streams may need reopening. The repository enables AOF, but Valkey is
disposable coordination state, not a durable backup dependency. Provision a
**new target Valkey volume** and let PostgreSQL-backed work recovery rebuild
coordination. Preserve the old volume for rollback. Do not load a 9.x-written
AOF/RDB into 8.x or flush the source to make it empty. Custom modules, clusters,
persisted business keys and ACLs require their own migration assessment.
9.1.3 fixes Pub/Sub security and RDB/AOF compatibility defects; this procedure
does not claim persisted 8→9→8 data-file compatibility.

## Existing-install migration and rollback

1. Inventory source versions/digests, deployment project/file, volume names,
   database names, migrations and representative tenant-scoped record IDs/counts.
   Preserve the old checkout, Compose files, secret configuration and images.
   Reserve enough space for the old stores, backup and full restored stores.
2. Rehearse on an isolated deployment first. For the final cutover, stop API,
   workers and ingestion/traffic **before** backup; leave only source database
   servers available. Freeze writes until validation/cutover finishes. Never run
   `compose up` with the new images against the source project.
3. In the source checkout, run [backup and artifact validation](backup-restore.md)
   with its existing deployment file/env/project selected. Preserve the complete
   artifact off the source host with approved encryption/access controls. The
   `glasshouse-backup-v1` format is unchanged; historical manifests remain valid.
   Dumps omit ownership/ACLs and do not include cluster-global roles; provision
   target credentials and any custom grants/extensions separately.
4. Prepare a separate current checkout and secret env file using the **same
   PostgreSQL and ClickHouse database names** as the source. Use
   `infra/compose.production.yaml` with a distinct Compose project; its default
   project-prefixed volumes are distinct. Inspect their resolved names and
   mounts before starting anything. The local/deps Compose files contain fixed
   legacy physical names and container names: copying them or changing only
   `--project-name` is **not** sufficient isolation. Do not reuse those files
   as an upgrade target without deliberately overriding every storage/container
   identity. Start only the new data services:

   ```sh
   docker compose --project-directory /srv/glasshouse-next \
     --env-file /secure/glasshouse-next.env --project-name glasshouse-next \
     -f /srv/glasshouse-next/infra/compose.production.yaml \
     up -d --wait postgres clickhouse valkey
   ```

5. Run `make restore` from the source/tooling checkout with `BACKUP_ARTIFACT`,
   all `BACKUP_SOURCE_*` selectors, and the isolated `RESTORE_TARGET_*` values
   from [the restore example](backup-restore.md#isolated-restore). Point the target
   directory/file/env/project at step 4 and supply exact confirmation. The
   existing safety guards require distinct inspected mounts and empty stores.
   Do not pre-run migrations or delete data to satisfy emptiness. If a restore
   fails, keep diagnostics/artifacts and provision another empty target rather
   than clearing or overwriting the failed one.
6. Run both normal migration runners against the **target**, then run them again
   to prove migration-ledger/checksum compatibility. Run PostgreSQL `ANALYZE`.
   Start the target API/web behind a closed proxy (stop the old API first if
   binding the same ports). Check `/v1/health`, exact server versions, logs,
   authenticated Project/Prompt/Evaluation reads, scoped trace/observation
   counts, tenant constraints and Pub/Sub/SSE. Run the connectivity test below
   using target-only URLs. Back up the upgraded target and restore that artifact
   into a second empty target to validate the new recovery path.
7. Switch traffic only after data-integrity and recovery checks pass. Keep the
   old deployment stopped and its data/backup intact for the recovery window.
   Before new writes are admitted, rollback means stopping the new application
   and routing back to the unchanged old deployment with its original images,
   mount layout and secrets. After new writes, rollback loses those writes
   unless separately reconciled: stop traffic and make an explicit recovery-point
   decision. Never attach a PG18 directory to PG16 or CH26-written storage to CH24.
   Application-only rollback also requires compatibility with applied SQL
   migrations. No command in this procedure removes a volume.

## Verification gates and limits

```sh
bun run test:infra-security
make test-backup-restore
# With all three isolated services reachable using the repository environment:
bash infra/scripts/with-local-env.sh bun --cwd apps/api test tests/integration/datastore-connectivity.test.ts
# Set GLASSHOUSE_VERIFY_DATASTORE_VERSIONS=1 to require the exact selected versions.
make test-db-migrations
```

CI exercises fresh application startup/restart, PostgreSQL migration fixtures,
ClickHouse schema/tenant checks, and the application pg/ClickHouse/ioredis
connectivity test with exact version assertions. Backup/restore has two isolated
source/target jobs: current→current and historical PG16/CH24→current. Both check
scoped JSONB/MergeTree records and restored tenant constraints through the real
operator scripts. On disposable Linux CI projects only,
`BACKUP_RESTORE_APPLICATION_FIXTURE=1` additionally applies both complete schemas,
seeds a real Project/Trace/Observation, restores migration ledgers, verifies the
records and reruns both migration runners twice. This opt-in fixture reaches
CI's private Compose bridge IPs and must not be enabled on an operator's live
source. A separate synthetic old-store entrypoint check verifies that PG18
refuses a root-level PG16 marker without initializing a new database. These
checks test logical migration and refusal, not conversion of old volumes.

The running coding-agent container initially has the old services. Do not
recreate it against its existing stores to claim the new images were tested.
Without an isolated Docker route, image startup, cross-version migration,
production-image builds and the real Compose backup/restore gates are
**unverified locally**; static/safety tests and old-service client probes are
not substitutes. Record the exact PR-head CI outcomes and an installation-
specific restore drill before production cutover. No universal existing-data
upgrade, zero-loss recovery, or binary downgrade guarantee is made.
