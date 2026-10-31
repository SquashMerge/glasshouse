# Image-only Compose bundle (experimental; no snapshots published)

This directory contains an image-only variant of the production Compose
manifest and its required ClickHouse and Valkey configuration. The snapshot
publisher, registry privacy controls and image provenance have not yet been
verified. A read-only CI job is configured to build and exercise this bundle;
its hosted result must be checked for the exact revision. No private Glasshouse
snapshot images are provided by this bundle alone. Do not treat this bundle as a
supported production release or assume image names below exist.
The source-build production path remains documented in
[`docs/self-hosted-production.md`](../../docs/self-hosted-production.md).

The bundle requires Docker Compose v2 (including `up --wait`) and the complete contents of this directory,
not a source checkout or a local Bun/Node installation. Obtain the directory and
its nested `infra/` files from the same trusted source revision as the images;
for example, on a separate trusted machine with Git, run
`git archive <full-source-sha> deploy/snapshot | tar -x`, transfer
`deploy/snapshot` intact, and verify its source. Git is not needed on the target.
Only `linux/amd64` is a
full-stack target; other platforms have not been verified. API and web image
references are mandatory, but Compose does **not** validate their digest,
source revision, provenance, privacy, or whether they form a matching pair.
The operator must independently verify these properties before deployment.

When trusted matching image digests are available, place `production.env.example`
in a protected location and replace its placeholders with independently generated
secrets as described in the production guide. Set the two image values to
verified immutable manifest/index digests, for example:

```sh
export GLASSHOUSE_API_IMAGE='ghcr.io/squashmerge/glasshouse-api-snapshot@sha256:<verified-api-digest>'
export GLASSHOUSE_WEB_IMAGE='ghcr.io/squashmerge/glasshouse-web-snapshot@sha256:<verified-web-digest>'
docker compose --project-directory /path/to/snapshot --env-file /secure/glasshouse.production.env -f /path/to/snapshot/compose.yaml pull
docker compose --project-directory /path/to/snapshot --env-file /secure/glasshouse.production.env -f /path/to/snapshot/compose.yaml up -d --no-build --wait
```

Replace the example names only after the package names and private access have
been verified. Authenticate Docker to the private registry using a credential
with the minimum required package-read access; use `--password-stdin` and do
not put credentials in shell history or the environment template. Check both
an authorized pull and an anonymous denial. A source repository being public does
not prove its packages are private, and linking a public repository to a private
package may expose that package to fork workflows. Do not authorize that link
without reviewing the actual GitHub package access policy.

An HTTPS reverse proxy must route `/v1` (including `/v1/*`), `/health`,
`/openapi.json`, and `/reference` to the loopback API port, and `/` to the
loopback web port. Vite preview does **not** proxy API requests and checks the
upstream Host: configure the proxy to send `Host: localhost` to the web service
(or explicitly permit a trusted host in Vite configuration). Preserve the
path, Authorization headers and SSE streaming for the API; disable proxy buffering for
SSE, and use suitable streaming timeouts. The CI-only proxy is not a production
TLS configuration. Do not expose data-service ports. Preserve the Compose
project name and existing named volumes when upgrading; **never remove data
volumes for routine deployment**. All five services default to Docker's `local`
logging driver with `10m` and `3` rotation bounds; overrides must be compatible
with the configured driver and retain bounded logs.
Before upgrading, take and verify a backup, review both datastore and application
migration compatibility, and check health plus authenticated access. Application
rollback may be impossible after migrations; cross-version datastore restore is
not supported.

## Backup and restore tooling is separate

The application images and bundle do not contain the operator scripts, Makefile,
or guides. Obtain the [backup/restore guide](../../docs/backup-restore.md) and a
trusted matching source revision separately; links outside this directory do not
work if only the bundle was transferred. The tools require Docker Compose, GNU
Make, Python 3 and `sha256sum` on their operator host. They are not a standalone
checkout-free bundle: `backup.sh` and the source side of `restore.sh` force the
**repository root** as Compose project-directory. Therefore relative bind mounts
in the selected source manifest resolve against that root, not the deployed
bundle directory. Use the matching repository's `infra/clickhouse/backup.xml`
and `infra/valkey/valkey.conf`, and verify they match the active bundle before
using the tools. Supply the exact live project name, production env file and
both image references (Compose interpolation requires them even for database
operations); verify the target and mounted volumes before any restore. For example,
from the matching source root, after exporting the same two verified image
digests used for deployment:

```sh
BACKUP_DESTINATION=/secure/glasshouse-backups \
BACKUP_SOURCE_ID=production-1 \
BACKUP_SOURCE_COMPOSE_FILE=/path/to/snapshot/compose.yaml \
BACKUP_SOURCE_ENV_FILE=/secure/glasshouse.production.env \
BACKUP_SOURCE_COMPOSE_PROJECT=glasshouse-production \
make backup
```

This does not replace an isolated restore rehearsal; follow the guide's target
checks and current-version restrictions. Do not delete live volumes.
