# Glasshouse devcontainer

This Compose-based devcontainer gives each OpenCode workspace its own PostgreSQL 18.6, ClickHouse 26.10.2.103, and Valkey 9.1.3 network. Data-service ports are intentionally **not** published to the host, so concurrent branches do not collide.

Before rebuilding an existing PG16 workspace, follow [the datastore upgrade runbook](../docs/datastore-upgrades.md). PG18 mounts `/var/lib/postgresql` and refuses an unmigrated old store; preserve its volume and migrate into a separately provisioned workspace. Never delete volumes to make startup pass. ClickHouse mounts the same restricted backup configuration as production.

## OpenCode

From an Glasshouse checkout, start an isolated branch environment with:

```sh
/devcontainer <branch-name>
```

The `opencode-devcontainers` plugin clones the branch, copies the ignored `infra/.env` into that clone, and starts this development environment. The plugin assigns the API's external port; databases stay private to the workspace Compose network.

## Inside the devcontainer

`postCreateCommand` installs the frozen Bun workspace dependencies and the isolated GEPA Python environment. `GLASSHOUSE_CONTAINER_NETWORK=1` intentionally overrides any host-local database URL settings from `infra/.env`, so the normal local-runtime commands connect to the private Compose service DNS names automatically:

```sh
make dev-backend
make dev-frontend
make test
make typecheck
```

For migrations inside the devcontainer, use the `devcontainer-*` targets rather than the host-Docker `db-migrate` / `ch-schema` targets:

```sh
make devcontainer-db-migrate
make devcontainer-ch-schema
```

The repo needs a valid, gitignored `infra/.env`. Create it from `infra/.env.example` and replace all `CHANGE_ME` values before starting a workspace. Never commit that file.

## Lifecycle

- `/devcontainer` reports the active workspace state.
- `/devcontainer off` stops routing OpenCode shell work into the container.
- `/devcontainer rm <branch-name>` removes that branch's container and clone after you no longer need it.

If the host container engine is unavailable, do not fall back to running Glasshouse builds or tests on the host; repair the engine first.
