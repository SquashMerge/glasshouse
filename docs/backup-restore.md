# Backup and restore

These commands are repository-supported operator tooling for the durable Glasshouse stores. Current Compose files pin PostgreSQL 18.6 (`postgres:18.6-alpine`) and ClickHouse 26.10.2.103 (`clickhouse/clickhouse-server:26.10.2.103-alpine`); Valkey 9.1.3 is rebuilt separately. Support covers backup/restore on these current versions, not legacy datastore migration or cross-version restore. See [supported datastores](datastore-upgrades.md). A backup is not a database snapshot across both systems: PostgreSQL is dumped first and ClickHouse second, so writes during the operation can produce a cross-store point-in-time difference. Pause ingestion and application writes when a tighter consistency point is required, and record the resulting recovery point.

ClickHouse's local `File()` backup backend requires both `backups.allowed_disk` and `backups.allowed_path`. The development Compose files mount `infra/clickhouse/backup.xml`, which confines backup files to `/var/lib/clickhouse/backup/` inside the ClickHouse data volume. Custom Compose deployments must mount equivalent ClickHouse server configuration before starting the service; restarting ClickHouse is required for a changed server config to take effect.

## Backup

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

The manifest contains the source identity, creation time, store names, and server versions. It does not contain passwords, connection URLs, or application data. Treat the dump and ClickHouse archive as sensitive: they include tenant data, prompts, traces, audit records, and any retained secrets that were already present in application data.

Valkey is disposable coordination/cache state and is intentionally not included. Recreate it from the target Compose deployment; do not treat queued jobs, locks, sessions, or cache entries as durable recovery data. Pending work must be re-admitted or re-created according to the application’s normal recovery behavior.

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
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/infra/compose.production.yaml \
RESTORE_TARGET_ENV_FILE=/run/secrets/glasshouse-restore.env \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027 \
make restore
```

Run this from the matching source checkout. Set the three `BACKUP_SOURCE_*` values to the **actual live stack** to be protected by the safety checks, not a different stack or an arbitrary local development project. Verify that the selected project and its running containers and mounts correspond to that live stack and to the artifact's source; the manifest's source ID does not verify this mapping. The source must remain running for inspection. The script uses the checkout root as the source Compose project directory and `RESTORE_TARGET_DIRECTORY` as the target Compose project directory. Relative source paths resolve from the checkout root and relative target paths from the target directory; relative Compose bind mounts also resolve from their respective project directories, not the manifest directories. Check the resolved configurations, project names, containers and mounts before proceeding. Use a controlled shell without conflicting exports: Compose gives exported variables precedence over env-file values. Image-only manifests also require the matching image references for interpolation, even when operating only on the databases.

`BACKUP_SOURCE_COMPOSE_FILE`, `BACKUP_SOURCE_ENV_FILE`, and `BACKUP_SOURCE_COMPOSE_PROJECT` default to `infra/compose.yaml`, `infra/.env`, and `glasshouse`. Restore uses those same source defaults for its live/source checks; do not rely on them for a production stack with different settings. `RESTORE_TARGET_ENV_FILE` defaults to `infra/.env` below the target directory and may point to an external production secret env file; the selected Compose service configuration supplies both database usernames and passwords, so no credential variables need to be copied into the command or documentation.

The exact confirmation, an explicit target identity, a distinct Compose project, non-overlapping inspected storage mounts, and empty target stores are mandatory. The command fails before any restore write when confirmation is missing, the target is marked live, the target is the source checkout, a service/container/storage mount is shared or overlaps, or either target store contains application objects. It does not use `--clean`, drop a database, remove a volume, or overwrite an existing installation.

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
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/infra/compose.yaml \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027 \
make test-backup-restore-integration
```

The integration gate removes only its uniquely named source probe table after the check. It does not remove target data, volumes, databases, or deployments.

CI runs this gate for current-to-current recovery. The records include tenant IDs, JSONB, DateTime64, Map metadata, a MergeTree token index, and restored storage constraints. The artifact format remains `glasshouse-backup-v1`; artifact validation proves integrity, not server-version compatibility. PostgreSQL restore uses the target server's bundled `pg_restore` with `--exit-on-error --single-transaction`. A PostgreSQL failure rolls back that store; a later ClickHouse failure does not roll PostgreSQL back. Provision another empty isolated target after any partial restore rather than deleting data to retry.

Disposable Linux CI projects additionally set `BACKUP_RESTORE_APPLICATION_FIXTURE=1` to migrate both full schemas, seed real Project/Trace/Observation records, and verify restored migration ledgers through repeated migrations. This fixture uses private Compose bridge IPs and intentionally leaves its application rows in the disposable source; do not enable it on a live/operator source. The ordinary operator integration gate still removes only its uniquely named probe table.

## Operations and security

- Retain multiple dated artifacts according to the organization’s recovery policy, and rotate/delete old artifacts only through an approved operator process after retention/legal holds are checked.
- Encrypt backups at rest and in transit using the destination filesystem/object-storage controls. The scripts do not implement encryption or key management.
- Restrict the destination and restore commands to operators who are authorized to read all tenant data and administer both databases. Use filesystem ACLs, storage IAM, audit logs, and separate restore credentials where available.
- Keep `infra/.env`, database passwords, and provider credentials outside artifacts and logs. Never put secrets in `BACKUP_SOURCE_ID`, target IDs, artifact names, or shell transcripts.
- Test recovery using the same supported service images recorded in the manifest. Legacy backups and cross-version restore are unsupported; custom schema and extensions still need an installation-specific recovery drill.
- Backups do not guarantee zero data loss, cross-store transactional consistency, a particular RPO/RTO, or recovery of Valkey queues/sessions.
