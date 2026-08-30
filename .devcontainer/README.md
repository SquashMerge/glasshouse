# Astraea devcontainer

This Compose-based devcontainer gives each OpenCode workspace its own PostgreSQL 16, ClickHouse 24, and Valkey 8 network. Data-service ports are intentionally **not** published to the host, so concurrent branches do not collide.

## OpenCode

From an Astraea checkout, start an isolated branch environment with:

```sh
/devcontainer <branch-name>
```

The `opencode-devcontainers` plugin clones the branch, copies the ignored `infra/.env` into that clone, and starts this development environment. The plugin assigns the API's external port; databases stay private to the workspace Compose network.

## Inside the devcontainer

`postCreateCommand` installs the frozen Bun workspace dependencies and the isolated GEPA Python environment. `ASTRAEA_CONTAINER_NETWORK=1` intentionally overrides any host-local database URL settings from `infra/.env`, so the normal local-runtime commands connect to the private Compose service DNS names automatically:

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

If the host container engine is unavailable, do not fall back to running Astraea builds or tests on the host; repair the engine first.
