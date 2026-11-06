# Backup and restore

These commands are repository-supported operator tooling for the durable Glasshouse stores. Current Compose files pin PostgreSQL 18.6 (`postgres:18.6-alpine`) and ClickHouse 26.10.2.103 (`clickhouse/clickhouse-server:26.10.2.103-alpine`); Valkey 9.1.3 is rebuilt separately. Support covers backup/restore on these current versions, not legacy datastore migration or cross-version restore. See [supported datastores](datastore-upgrades.md). A backup is not a database snapshot across both systems: PostgreSQL is dumped first and ClickHouse second, so writes during the operation can produce a cross-store point-in-time difference. Pause ingestion and application writes when a tighter consistency point is required, and record the resulting recovery point.

ClickHouse's local `File()` backup backend requires both `backups.allowed_disk` and `backups.allowed_path`. The development Compose files mount `infra/clickhouse/backup.xml`, which confines backup files to `/var/lib/clickhouse/backup/` inside the ClickHouse data volume. Custom Compose deployments must mount equivalent ClickHouse server configuration before starting the service; restarting ClickHouse is required for a changed server config to take effect.

Whole-database ClickHouse backups include OTLP `logs` and migration `0009` bookkeeping alongside traces/observations. The application restore fixture checks log Organization/Project scope, exact event/observed nanoseconds and nested int64 AnyValue bodies before replaying the migration runners. This fixture must be run through the existing isolated restore drill to establish actual backup/restore evidence; seeding and verifying a single database alone is not a restore drill.

## Backup

The native `BACKUP DATABASE` includes the `metrics` table and ClickHouse migration
bookkeeping alongside traces and Observations. Metric integers/nanoseconds and
typed histogram/exemplar data are restored from their original stored values;
there is no separate metrics artifact. Pause HTTP/gRPC metric exporters along
with trace ingestion when establishing a recovery point. After isolated restore,
check scoped metric counts and exact typed values with `GET /v1/metrics` before
cutover. An older artifact predating metrics receives the empty table through
additive migration `0010_otlp_metrics.sql` during normal startup. Retention and
Project deletion affect live stores, not already-created backup artifacts.

PostgreSQL backups also contain the secret per-Project Metric identity keys from
`90063_metric_identity_keys.sql`. Preserve those keys with the corresponding
ClickHouse data to keep new points in the same series after recovery. Restoring
ClickHouse alone or replacing keys splits future identities; neither action
rewrites old IDs. Treat the PostgreSQL dump as secret-bearing: possession of a
key permits offline guesses against that Project's pre-redaction identities.

Install the client/runtime prerequisites used by the operator host: Bash, Docker Compose v2, `python3`, `sha256sum`, and a running stack; other examples use GNU Make. The Compose service containers provide `pg_dump`, `psql`, and `clickhouse-client`; PostgreSQL credentials are passed through the Compose exec environment, while ClickHouse uses a private mode-0600 client config that is removed after the command. Command output never includes credential values.

Choose a destination with restrictive permissions. The destination can be a local disk, an encrypted mounted filesystem, or an operator-managed object-storage sync target. The script itself writes only to a local filesystem path.

```sh
BACKUP_DESTINATION=/secure/glasshouse-backups \
BACKUP_SOURCE_ID=production-eu-1 \
BACKUP_SOURCE_COMPOSE_FILE=/srv/glasshouse/infra/compose.production.yaml \
BACKUP_SOURCE_ENV_FILE=/run/secrets/glasshouse-production.env \
BACKUP_SOURCE_COMPOSE_PROJECT=glasshouse-production \
bash infra/scripts/backup.sh
```

Run this from the matching source checkout. The script uses the repository root as
the Compose project directory, so relative bind mounts in the selected manifest
resolve there. It does not source the checkout's `infra/.env`; avoid `make backup`
for production because that target sources the local development environment and
can override the selected source. Compose gives exported shell variables
precedence over the supplied env file, so use a controlled environment without
conflicting exports and verify the resolved configuration and project before
running the backup.

The script creates a mode-0700 staging directory and mode-0600 dump files, validates both files, writes SHA-256 checksums and a secret-free manifest, then atomically renames the staging directory. A directory is a complete backup only when it contains `manifest.json` with `complete: true`; a failed or interrupted staging directory is never published as a completed artifact. Existing artifact IDs are never overwritten.

Validate an artifact without contacting either database:

```sh
BACKUP_ARTIFACT=/secure/glasshouse-backups/20261027T120000Z-1234 \
make backup-validate
```

The manifest contains the source identity, Docker daemon ID, Compose project, creation time, store names, and server versions. Backups created before daemon and project recording do not have those fields. The daemon ID and project are metadata, not proof that a target is on an independent host or independent storage; they are not an authenticity mechanism. It does not contain passwords, connection URLs, or application data. The full-instance database contents **can** contain credentials, credential digests, API keys, sessions, tenant data, prompts, traces and audit records. Restore can reinstate old users, privileges, session records and credentials: keep the target offline, invalidate sessions and rotate or revoke compromised/restored credentials and keys before cutover. Secure artifacts accordingly.

Checksums detect corruption, not provenance: an attacker can replace both data and checksums, and even a structurally valid PostgreSQL dump can execute arbitrary SQL on restore. Restore only an artifact whose provenance and integrity were independently authenticated by the trusted host operator (for example, verify an out-of-band signature or digests from a trusted channel), not an upload or tenant-supplied archive. `RESTORE_TRUSTED_ARTIFACT` is the operator's explicit attestation, not an authenticity check. The artifact directory and its regular files must be owned by the current operator, inaccessible to group/other users, and not symlinks or hard links. Restore copies them to a private local temporary directory before validation and uses that copy throughout; allow temporary disk space for the full artifact. This protects against unprivileged other users, not a compromised operator account, root, Docker administrator, or a malicious process running under the same user. The temporary directory and backing filesystem must also be trusted.

Valkey is disposable coordination/cache state and is intentionally not included. Recreate it from the target Compose deployment; do not treat Valkey-resident queued jobs, locks, or cache entries as durable recovery data. Pending work must be re-admitted or re-created according to the application’s normal recovery behavior. Local authentication session token digests and session records are persisted in PostgreSQL, not Valkey, and are included in the backup; invalidate restored sessions and re-secure credentials before cutover.

## Isolated restore

Restore is never an in-place repair command. Prepare a stopped or separately running target deployment in a different directory and Compose project. Its PostgreSQL and ClickHouse volumes must have unique names and must not be bind mounts or named volumes used by the live/source stack. Both target databases must contain no application objects or tables; only server system objects may exist. Do not pre-run migrations: the backup restores the source migration bookkeeping, and target migrations are applied or validated after restore. Do not use the source `infra/compose.yaml` as the target file. Do not delete volumes or databases to make a target empty.

For a recovery drill, the target Compose file must use the same supported service images as the source. Preserve the source PostgreSQL and ClickHouse database names. The selected target environment file must contain target-only credentials; it may be the default `infra/.env` or an external secret file passed via `RESTORE_TARGET_ENV_FILE`. Start only the isolated target data services, then run:

```sh
BACKUP_ARTIFACT=/secure/glasshouse-backups/20261027T120000Z-1234 \
BACKUP_SOURCE_COMPOSE_FILE=/srv/glasshouse/infra/compose.production.yaml \
BACKUP_SOURCE_ENV_FILE=/run/secrets/glasshouse-production.env \
BACKUP_SOURCE_COMPOSE_PROJECT=glasshouse-production \
RESTORE_TARGET_ID=restore-drill-2026-10-27 \
RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO restore-drill-2026-10-27' \
RESTORE_TARGET_LIVE=false \
RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP' \
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/infra/compose.production.yaml \
RESTORE_TARGET_ENV_FILE=/run/secrets/glasshouse-restore.env \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027 \
make restore
```

Run this from the matching source checkout. Set the three `BACKUP_SOURCE_*` values to the **actual live stack** to be protected by the safety checks, not a different stack or an arbitrary local development project. Verify that the selected project and its running containers and mounts correspond to that live stack and to the artifact's source; the manifest's source ID does not verify this mapping. The source must remain running for inspection. The script uses the checkout root as the source Compose project directory and `RESTORE_TARGET_DIRECTORY` as the target Compose project directory. Relative source paths resolve from the checkout root and relative target paths from the target directory; relative Compose bind mounts also resolve from their respective project directories, not the manifest directories. Check the resolved configurations, project names, containers and mounts before proceeding. Use a controlled shell without conflicting exports: Compose gives exported variables precedence over env-file values. Image-only manifests also require the matching image references for interpolation, even when operating only on the databases.

`BACKUP_SOURCE_COMPOSE_FILE`, `BACKUP_SOURCE_ENV_FILE`, and `BACKUP_SOURCE_COMPOSE_PROJECT` default to `infra/compose.yaml`, `infra/.env`, and `glasshouse`. Restore uses those same source defaults for its live/source checks; do not rely on them for a production stack with different settings. `RESTORE_TARGET_ENV_FILE` defaults to `infra/.env` below the target directory and may point to an external production secret env file; the selected Compose service configuration supplies both database usernames and passwords, so no credential variables need to be copied into the command or documentation.

The exact confirmation, an explicit target identity, a distinct Compose project, non-overlapping inspected storage mounts, and empty target stores are mandatory. Both modes now require the target's two dedicated, writable, non-external local-driver Docker volumes at `/var/lib/postgresql` and `/var/lib/clickhouse`, with a local Unix Docker endpoint, no driver options, no nested mounts and no other container attached. PostgreSQL must listen on `/var/run/postgresql` port 5432; validation and restore use that socket with a cleared libpq environment inside the inspected container. The running server's canonical `data_directory` and `pg_wal` must be inside its volume, and custom tablespaces are rejected; restored objects use the default tablespace. ClickHouse must listen on 127.0.0.1 port 9000 and its reported server path and all configured disk paths must be local and resolve inside its volume, as must the backup directory. This stricter contract also applies when the source is live. In default mode both source containers must currently be reachable on the same Docker daemon; a missing source fails closed.

These are point-in-time checks, not protection against a hostile operator or server. The trusted operator must authenticate the backup, trust the selected container images, processes and configuration (including no malicious internal symlinks, SQL, plugins, remote storage aliases, or hidden mounts), and prevent concurrent container, filesystem, database, and configuration changes throughout the operation. Independently verify that target storage is local and dedicated, source and target cannot share a backing device, and the target cannot receive traffic. If isolation cannot be established, do not proceed. The tool does not use `--clean`, drop a database, remove a volume, or intentionally overwrite an existing installation.

### When the source is unavailable

This is an explicit disaster-recovery mode, **not an in-place restore** or a bypass for an unsafe target. Independently authenticate the artifact, including its manifest, using a trusted out-of-band source before attesting trust. The manifest must contain the source Docker daemon ID and Compose project recorded at backup time; older backups without these fields fail closed in this mode. The current target daemon ID and project must differ from the recorded source values. Neither an unsigned manifest nor different daemon IDs or project names proves a separate physical host or independent storage: independently establish both, and do not edit a real manifest merely to pass the checks.

Prepare a separate target host and directory, with the same supported server versions and database names, offline from application traffic. Connect Docker via a **local Unix socket** on that target. Start both target Compose data services with two distinct writable non-external named volumes using the `local` driver with no driver options, at `/var/lib/postgresql` and `/var/lib/clickhouse` respectively. Do not use bind mounts for data. Both stores must be empty, and no other running or stopped container may use either volume; the inspector also rejects overlapping inspected mount sources. Docker inspection cannot rule out backing-store aliases, hidden mounts, malicious administrators, or races: the operator must verify physical/storage independence and prevent concurrent changes throughout the restore. If that cannot be established, stop.

Use the same target and trust variables as above, adding all four source-loss variables (the example repeats the complete command):

```sh
BACKUP_ARTIFACT=/secure/glasshouse-backups/20261027T120000Z-1234 \
RESTORE_TARGET_ID=restore-drill-2026-10-27 \
RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO restore-drill-2026-10-27' \
RESTORE_TARGET_LIVE=false \
RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP' \
RESTORE_SOURCE_UNAVAILABLE=true \
RESTORE_SOURCE_UNAVAILABLE_CONFIRMATION='SOURCE IS UNAVAILABLE' \
RESTORE_DISTINCT_HOST_CONFIRMATION='I VERIFIED DISTINCT HOST' \
RESTORE_DISTINCT_STORAGE_CONFIRMATION='I VERIFIED DISTINCT STORAGE' \
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/infra/compose.production.yaml \
RESTORE_TARGET_ENV_FILE=/run/secrets/glasshouse-restore.env \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027 \
make restore
```

The script does not require source Compose files or a reachable source in this mode, but does require the target services to be running. Keep the restored target offline and invalidate PostgreSQL-backed sessions, rotate or revoke restored credentials and keys as appropriate, then complete the migration and verification steps below before cutover.

After the restore completes, apply the repository migrations against the target before serving traffic. Use the target deployment’s normal migration command, not the source deployment’s command, and confirm the migration count/checksum checks succeed. Then run the target API health endpoint and the repository smoke checks. Verify representative records in both stores, including at least one organization/project-scoped PostgreSQL record and one organization/project-scoped ClickHouse trace/observation. Compare counts or known test IDs with the source; a health response alone is not data-integrity proof.

For a repeatable manual gate, seed representative records in the source, create an artifact, validate it, restore to a newly-created isolated target with unique volumes, migrate, run health/integrity checks, and preserve the artifact manifest and command results as the drill record. The fast repository gate is:

```sh
make test-backup-restore
```

With a separately provisioned, running, empty target deployment, the real probe gate creates temporary representative records in both stores, backs them up, validates and restores them, and verifies the records in the target. It never creates or destroys target services or volumes. The following is a **development-only** example: `make test-backup-restore-integration` sources `infra/.env` and can override selected source settings. Do not use it for the production invocation above; it writes probe data to its source and requires carefully configured, isolated test deployments.

```sh
RESTORE_TARGET_ID=restore-drill-2026-10-27 \
RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO restore-drill-2026-10-27' \
RESTORE_TARGET_LIVE=false \
RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP' \
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/infra/compose.yaml \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027 \
make test-backup-restore-integration
```

The integration gate removes only its uniquely named source probe table after the check. It does not remove target data, volumes, databases, or deployments.

CI runs this gate for current-to-current recovery. It also runs `bash infra/scripts/test-source-down-integration.sh`, which creates and removes its own uniquely named disposable source and target projects and volumes, tests fail-closed cases, and verifies restored PostgreSQL and ClickHouse rows after removing the source. Both projects are on one local Docker daemon: the test changes only the private synthetic fixture's source daemon ID to exercise the source-unavailable success branch. It does not prove two-host or physical-storage isolation. The live-source gate's records include tenant IDs, JSONB, DateTime64, Map metadata, a MergeTree token index, and restored storage constraints.

The artifact format remains `glasshouse-backup-v1`. Offline `--validate-only` checks the outer manifest, SHA-256 and ZIP CRCs, and the ClickHouse native `.backup` version-1 manifest, referenced file sizes and native CityHash checksums. Only standalone, non-encrypted, non-incremental backups in the supported current-server format are accepted. This is a streaming, CPU-intensive pass over the ClickHouse contents and may take substantial time for large backups. Offline validation does **not** inspect PostgreSQL dump contents. Before either restore writes, the running target versions must match the supported manifest versions, the ClickHouse backup must contain the target database metadata, and the target's `pg_restore` renders the complete dump to a discarded stream without connecting to a database. This catches malformed and truncated compressed data that `pg_restore --list` can miss, but does not execute SQL or guarantee that restore will succeed. Native checksums and metadata cannot establish provenance or detect intentional omission of both an entry and its associated files; authenticate the artifact independently and run a recovery drill.

PostgreSQL restore uses `--exit-on-error --single-transaction`. A PostgreSQL failure rolls back that store; a later ClickHouse failure does not roll PostgreSQL back. After any partial or uncertain restore, do not blindly retry: investigate the state and provision another empty isolated target rather than deleting data.

Disposable Linux CI projects additionally set `BACKUP_RESTORE_APPLICATION_FIXTURE=1` to migrate both full schemas, seed real Project/Trace/Observation records, and verify restored migration ledgers through repeated migrations. This fixture uses private Compose bridge IPs and intentionally leaves its application rows in the disposable source; do not enable it on a live/operator source. The ordinary operator integration gate still removes only its uniquely named probe table.

## Operations and security

- Retain multiple dated artifacts **off the source host** according to the organization’s recovery policy, and rotate/delete old artifacts only through an approved operator process after retention/legal holds are checked.
- Encrypt backups at rest and in transit using the destination filesystem/object-storage controls. The scripts do not implement encryption or key management.
- Restrict the destination and restore commands to operators who are authorized to read all tenant data and administer both databases. Use filesystem ACLs, storage IAM, audit logs, and separate restore credentials where available.
- Keep `infra/.env`, database passwords, and provider credentials outside artifacts and logs. Never put secrets in `BACKUP_SOURCE_ID`, target IDs, artifact names, or shell transcripts.
- Test recovery using the same supported service images recorded in the manifest. Legacy backups and cross-version restore are unsupported; custom schema and extensions still need an installation-specific recovery drill.
- Backups do not guarantee zero data loss, cross-store transactional consistency, a particular RPO/RTO, or recovery of Valkey queues and cache entries.
