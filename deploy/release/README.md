# Glasshouse release bundle

This bundle runs one Glasshouse API and UI image alongside separate PostgreSQL,
ClickHouse, and Valkey services. It supports Linux amd64 and Docker Compose v2.
Use only a release you trust: checksums detect accidental corruption, not a
malicious publisher or compromised maintainer account.

From the directory containing the three release assets, verify and load the
image, then extract the bundle:

```sh
sha256sum -c SHA256SUMS
gzip -dc glasshouse-image.tar.gz | docker load
mkdir glasshouse && tar -xzf glasshouse-compose.tar.gz -C glasshouse
cd glasshouse
cp production.env.example production.env
chmod 600 production.env
# Edit production.env: replace every placeholder with a unique strong secret,
# set GLASSHOUSE_PUBLIC_ORIGIN to the exact HTTPS origin, and review model settings.
docker compose --env-file production.env -f compose.yaml up -d --no-build --wait
```

Keep the image reference supplied in the release's `production.env.example`.
The application listens on 127.0.0.1:3000 by default. Put an HTTPS reverse
proxy in front of it; forward Authorization and preserve streaming with proxy
buffering disabled for SSE. The API and UI share the same origin. Never expose
database services publicly. Protect environment files and rotate credentials.
The database URL requires URL-unreserved PostgreSQL credentials and identifiers.

## First browser Admin

For a fresh installation, the bundle defaults to local bootstrap. The `UI_USERNAME`
/ `UI_PASSWORD` pair is a separate Basic recovery identity, not browser login
credentials; keep its owner username equal to `GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME`.
Before opening setup, provision a single-use secret in an operator-only file:

```sh
umask 077
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > glasshouse-setup.token
docker compose --env-file production.env -f compose.yaml exec -T app sh -c '
  set -eu; umask 077
  trap "rm -f /tmp/glasshouse-setup.token" EXIT
  cat > /tmp/glasshouse-setup.token
  cd /app/apps/api
  GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE=/tmp/glasshouse-setup.token bun run auth:provision-bootstrap
' < glasshouse-setup.token
```

Through the configured HTTPS origin, open the UI, enter the setup secret and choose
a distinct local Admin username and password, then sign in. Remove the operator
file after setup; it expires after 24 hours and is single-use. Setup is permanently
closed once an Admin exists; changing bootstrap mode cannot reopen an existing
installation. Follow the matching source revision's local-credentials runbook
for token replacement and recovery. Do not switch existing installations to Basic
bootstrap merely to obtain a browser login.

Keep the Compose project name and named data volumes stable across upgrades.
Back up and verify PostgreSQL and ClickHouse before upgrading. Application
startup applies migrations, which may prevent rollback; cross-version datastore
restore is unsupported. Do not remove data volumes during routine deployment.
See the matching source revision's self-hosting and backup documentation.
