# Self-hosted production

This is the supported production path for a single Glasshouse host. It is
separate from the development workflow: `make dev`, `infra/compose.yaml`, and
`infra/compose.deps.yaml` remain local-development-only.

## Topology

Run `infra/compose.production.yaml` from the repository root with a deployment
environment file. PostgreSQL, ClickHouse, and Valkey have no host port
bindings. They share Compose's private default network with the other services;
the API is configured to use them, though any container on that network can
reach their service ports. The ClickHouse service mounts
`infra/clickhouse/backup.xml`, which restricts the local `File()` backup backend
to `/var/lib/clickhouse/backup/` inside its data volume. Keep that configuration
file alongside the Compose deployment; custom ClickHouse deployments need the
equivalent `backups.allowed_disk` and `backups.allowed_path` settings.
The API and web server bind to `127.0.0.1` by default; they are not published
to all host interfaces. Place an operator-managed TLS reverse proxy in front
of those loopback ports and expose only the intended HTTPS origin.

The proxy must route `/` to the web service and `/v1`, `/health`, and any
OpenAPI/reference routes that operators choose to expose to the API. Do not
expose database, ClickHouse, or Valkey ports. This repository does not ship or
support a specific proxy, certificate issuer, HTTP/2 policy, or firewall.

## Configuration and startup

Copy `infra/production.env.example` into an operator-controlled secret location
and replace every placeholder with independently generated secrets. Use only
URL-unreserved ASCII characters in `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB`, because Compose embeds them in `DATABASE_URL`; PostgreSQL user
and database names must also be at most 63 ASCII characters. Generate
`POSTGRES_PASSWORD` with an unreserved alphabet (for example, `openssl rand -hex 32`).
Start with:

```sh
docker compose --project-directory . --env-file /secure/glasshouse.production.env \
  -f infra/compose.production.yaml up -d --build --wait
```

The API fails before serving if `NODE_ENV` is not exactly `production`, the
public origin is not HTTPS, required credentials are weak/placeholders, or
`GEPA_WORKER_MODE=cli`/`GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION=true` is enabled. Production
must use a provider-backed GEPA worker; the local authenticated CLI adapter is
development-only. Keep provider credentials in the deployment secret store.

The API also bounds concurrently active GEPA jobs independently of each job's
metric-call budget. `GEPA_MAX_ACTIVE_JOBS_PER_PROJECT` defaults to `3` and
`GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER` defaults to `1`; set either explicitly in
the protected production environment file to override it. Both accept integers
from `1` through `1000`. A start request above either active-job limit receives
HTTP `429`; queued, preparing, optimizing, and evaluating jobs count toward the
limit. The requester limit counts the same durable Actor across all Projects,
including equivalent Basic username spellings, with concurrent admissions
serialized transactionally. Stored requester provenance retains its original
spelling. Replaying an already-active job returns that job even when either
limit is reached. See
`infra/production.env.example` for the variable names.

Every API start applies PostgreSQL and ClickHouse migrations before accepting
traffic. A failed migration keeps the API unavailable. Review the migration
output and application health before allowing the proxy to send traffic.

## TLS, headers, and credentials

Terminate TLS at the proxy and redirect HTTP to HTTPS. Set
`GLASSHOUSE_PUBLIC_ORIGIN` to the exact external origin, without a path or
trailing slash. Forwarded headers must not be used to choose that origin unless
the proxy is trusted and overwrites them; preserve the external HTTPS scheme
for generated links and WebSocket/SSE compatibility. Exclude `Authorization`,
`Cookie`, `Set-Cookie`, auth bodies, OTLP payloads, and provider credentials
from proxy, APM, and access logs.

The API emits baseline security headers, but operators must verify that the
proxy does not remove them and should add HSTS only after HTTPS is permanent.
Configure proxy request-size, rate, timeout, and connection limits. Basic Auth
and OTLP credentials are bearer credentials and must never cross an unencrypted
connection.

## Health, upgrades, and recovery

Use `/health` or `/v1/health` for a public liveness check. The Compose health
checks also gate API startup on all three data services. Do not use health
success as evidence that backups exist or that an upgrade is recoverable.

For an upgrade, stop traffic, take an operator-verified database backup, deploy
the new image, and let the normal API startup migration complete. Confirm
`/health`, logs, and representative authenticated reads before reopening the
proxy. Never edit an applied migration; rollback the application only when its
schema contract supports the already-applied migrations.

Backups, restore testing, retention, encryption, and point-in-time recovery
remain operator responsibilities and are intentionally specified by the
backup/restore work tracked separately in issue #7. Restore PostgreSQL,
ClickHouse, and Valkey according to their own documented procedures, then run
the same production deployment and migration path above; do not restore into a
development stack or guess tenant/project provenance.
