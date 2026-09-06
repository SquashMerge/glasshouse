SHELL := /bin/bash
COMPOSE := docker compose --project-directory . --env-file infra/.env -f infra/compose.yaml
COMPOSE_DEPS := docker compose --project-directory . --env-file infra/.env -f infra/compose.deps.yaml


.PHONY: help dev build down logs ps db-migrate devcontainer-db-migrate test-db-migrations ch-schema devcontainer-ch-schema valkey-ping codegen openapi-snapshot smoke doctor setup-tools normalize deps-up deps-down deps-logs dev-backend dev-frontend test-api test-api-integration test-web test-e2e test lint typecheck format install seed-traces seed-traces-reset

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install all workspace deps from the committed Bun lockfile
	bun install --frozen-lockfile

setup-tools: ## Install pinned dev tool versions via asdf (reads .tool-versions)
	bash infra/scripts/setup-tools.sh

normalize: ## Strip CRLF line endings from shell scripts (fix Windows checkouts)
	@find infra/scripts Makefile .tool-versions -type f -exec sed -i 's/\r$$//' {} +
	@echo "✓ Line endings normalized to LF."

dev: ## Boot the full stack (5 services) and wait for healthchecks
	@if [ ! -f infra/.env ]; then \
		echo "infra/.env not found. Copy infra/.env.example to infra/.env and edit."; \
		echo "Tip: \`make doctor\` will refuse to start with defaults."; \
		exit 1; \
	fi
	$(COMPOSE) up -d --build --wait
	@echo "✓ All services up. Dashboard: http://localhost:$${WEB_PORT:-5173}  OpenAPI: http://localhost:$${API_PORT:-3000}/reference"

deps-up: ## Boot only Postgres + ClickHouse + Valkey (for running api/web locally via bun)
	@if [ ! -f infra/.env ]; then \
		echo "infra/.env not found. Copy infra/.env.example to infra/.env and edit."; \
		exit 1; \
	fi
	$(COMPOSE_DEPS) up -d --wait
	@echo "✓ Data services up. Run 'make dev-backend' + 'make dev-frontend' in separate terminals."

deps-down: ## Tear down only the data services
	$(COMPOSE_DEPS) down

deps-logs: ## Tail data services logs
	$(COMPOSE_DEPS) logs -f --tail=100

dev-backend: ## Run the Hono API locally via bun (sources infra/.env, talks to deps on localhost)
	bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run dev'

dev-frontend: ## Run the React dashboard locally via bun + Vite (proxies /v1 -> :3000)
	cd apps/web && bun run dev --host 0.0.0.0

build: ## Build all images
	$(COMPOSE) build

down: ## Tear down the full stack
	$(COMPOSE) down

logs: ## Tail logs
	$(COMPOSE) logs -f --tail=100

ps: ## List running services
	$(COMPOSE) ps

db-migrate: ## Apply Postgres migrations and seed the default project (idempotent)
	$(COMPOSE) run --build --rm api sh -c 'cd apps/api && bun run db:migrate'

devcontainer-db-migrate: ## Apply Postgres migrations through the active devcontainer network
	bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run db:migrate'

test-db-migrations: ## Verify SQL migrations against legacy prompt data in PostgreSQL 16
	bash infra/scripts/test-db-migrations.sh

ch-schema: ## Apply ClickHouse schema migrations (idempotent)
	$(COMPOSE) run --build --no-deps --rm --entrypoint sh api -c 'cd apps/api && bun run ch:migrate'

devcontainer-ch-schema: ## Apply ClickHouse schema migrations through the active devcontainer network
	bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run ch:migrate'

valkey-ping: ## Verify Valkey is up (Redis-compatible)
	$(COMPOSE) exec -T valkey valkey-cli -a "$${VALKEY_PASSWORD}" ping

openapi-snapshot: ## Regenerate openapi.yaml snapshot from running Zod schemas
	cd apps/api && bun run openapi:snapshot

codegen: openapi-snapshot ## Regenerate typed TS + Python clients (depends on snapshot)
	cd apps/api && bun run codegen:ts
	cd apps/api && bun run codegen:py

smoke: ## Run smoke checks against an already-running stack
	bash infra/scripts/smoke.sh

doctor: ## Verify env, tools, and runtime readiness
	bash infra/scripts/doctor.sh

lint: ## Lint everything
	bun --filter "*" lint

typecheck: ## Type-check everything
	bun --filter "*" typecheck

test: test-api test-web ## Run all unit tests (api + web)

test-api: ## Run backend unit tests (bun:test)
	cd apps/api && bun run test:unit

test-api-integration: ## Run backend integration tests (requires deps-up and both migration runners)
	bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run test:integration'

test-web: ## Run frontend unit tests (vitest)
	cd apps/web && bun run test

test-e2e: ## Run frontend E2E tests (Playwright; requires deps-up + dev-backend + dev-frontend)
	bash infra/scripts/with-local-env.sh bash -c 'cd apps/web && bun run test:e2e'

format: ## Auto-format
	bun --filter "*" format

seed-traces: ## Seed OTLP traces (default: 100k mixed genai+openinference, last 30 days)
	bash infra/scripts/seed-traces.sh

seed-traces-reset: ## Wipe ClickHouse traces + observations, then seed (100k mixed)
	bash infra/scripts/seed-traces.sh --reset
