# Single-image deployment bundle — experimental

This is an **unreleased candidate**, not a published or verified release. The
image, installation, upgrade and disaster recovery have not yet passed the
required Docker integration gates. Do not deploy it as production until those
gates and the exact artifact's provenance have been verified. Only linux/amd64
is intended by this candidate. No registry publication is implied.

The bundle generator includes the image-only Compose manifest, configuration,
and the existing native operator backup/restore scripts. It does not contain an
image: a separately authenticated matching `docker save` archive must be loaded
and tagged as the `GLASSHOUSE_IMAGE` value in the environment file. Verify the
archive checksum and its provenance independently; a checksum distributed next
to an untrusted file does not authenticate it. Never use `latest` for releases.

## Deployment

Keep this entire directory together. Copy `production.env.example` to a private
location, replace all placeholders with strong unique secrets, set the image
tag to the exact loaded image, and configure the public HTTPS origin. Do not
commit secrets. Compose gives exported variables precedence over the env file;
use a controlled shell. In commands below substitute absolute paths:

```sh
docker load -i /secure/verified-glasshouse-image.tar.gz
docker compose --project-directory /srv/glasshouse --env-file /run/secrets/glasshouse.env -f /srv/glasshouse/compose.yaml config --quiet
docker compose --project-directory /srv/glasshouse --env-file /run/secrets/glasshouse.env -f /srv/glasshouse/compose.yaml up -d --no-build --pull never --wait
```

The application binds `127.0.0.1:3000` by default; put a TLS reverse proxy in
front of that one port and forward all paths, Authorization and cookies; do not
buffer SSE and configure appropriate streaming timeouts. Datastore ports are not
published. No gRPC listener is included; any future gRPC endpoint requires a
separate port. Preserve the Compose project name and named volumes; do not use
`down --volumes`. Back up and verify before upgrading. Application migrations
run on startup and rollback can be impossible. Cross-version datastore restores
are unsupported. For an existing two-image install, independently check its
project, volume names, public origin and reverse-proxy routes before changing
topology; a shared Compose name alone does not establish the correct data.

## Backup and isolated restore

Bash, Docker Compose v2, Python 3 and `sha256sum` are required on the trusted
operator host. The scripts use the bundle root as the source Compose project
directory; select the actual live stack and verify its containers and mounts.
Use a controlled environment without conflicting exports. Pause application
writes and ingestion for a tighter recovery point: PostgreSQL and ClickHouse
are backed up sequentially, not in one transaction. Valkey is not backed up.
Artifacts contain all tenants' sensitive data, credential digests and sessions;
protect and independently authenticate them. Checksums are not authenticity.

```sh
cd /srv/glasshouse
BACKUP_DESTINATION=/secure/backups \
BACKUP_SOURCE_ID=production \
BACKUP_SOURCE_COMPOSE_FILE=/srv/glasshouse/compose.yaml \
BACKUP_SOURCE_ENV_FILE=/run/secrets/glasshouse.env \
BACKUP_SOURCE_COMPOSE_PROJECT=glasshouse-production \
bash infra/scripts/backup.sh

BACKUP_ARTIFACT=/secure/backups/REPLACE_WITH_BACKUP_ID bash infra/scripts/restore.sh --validate-only
```

Restore **only** to a separate offline target with distinct dedicated local
volumes and empty databases, never the live stack. Before any restore read the
included `docs/backup-restore.md`, including isolation and source-unavailable
requirements; its Makefile examples are for source checkouts. The equivalent
standalone invocation is `bash infra/scripts/restore.sh`, with the same
variables, but use the actual bundle paths for the source and target Compose
files and env files. For example, after independently verifying the live source,
target isolation, provenance and compatible versions:

```sh
cd /srv/glasshouse
BACKUP_ARTIFACT=/secure/backups/REPLACE_WITH_BACKUP_ID \
BACKUP_SOURCE_COMPOSE_FILE=/srv/glasshouse/compose.yaml \
BACKUP_SOURCE_ENV_FILE=/run/secrets/glasshouse.env \
BACKUP_SOURCE_COMPOSE_PROJECT=glasshouse-production \
RESTORE_TARGET_ID=restore-drill \
RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO restore-drill' \
RESTORE_TARGET_LIVE=false \
RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP' \
RESTORE_TARGET_DIRECTORY=/srv/glasshouse-restore \
RESTORE_TARGET_COMPOSE_FILE=/srv/glasshouse-restore/compose.yaml \
RESTORE_TARGET_ENV_FILE=/run/secrets/glasshouse-restore.env \
RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-drill \
bash infra/scripts/restore.sh
```

Restore can reinstate valid users, privileges, credentials and sessions. Keep
the target offline, invalidate sessions, rotate/revoke credentials, run target
migrations, and verify representative data in both stores before cutover. A
health check alone does not prove data integrity. The bundled guide contains
more detail and explicitly describes source-loss mode and its attestations.
