SHELL := /bin/bash
COMPOSE := docker compose -f infra/compose.yaml
COMPOSE_DEV := docker compose -f infra/compose.yaml -f infra/compose.override.yaml

.PHONY: help dev build down logs ps db-migrate ch-schema valkey-ping codegen openapi-snapshot smoke doctor setup-tools normalize lint typecheck test format install

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install all workspace deps with bun
	bun install

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

build: ## Build all images
	$(COMPOSE) build

down: ## Tear down the stack
	$(COMPOSE) down

logs: ## Tail logs
	$(COMPOSE) logs -f --tail=100

ps: ## List running services
	$(COMPOSE) ps

db-migrate: ## Apply Postgres migrations (idempotent)
	$(COMPOSE) run --rm api bun run db:migrate

ch-schema: ## Apply ClickHouse schema (idempotent)
	@for f in infra/db/clickhouse/*.sql; do \
		echo "Applying $$f..."; \
		$(COMPOSE) exec -T clickhouse clickhouse-client --multiquery < $$f || exit 1; \
	done
	@echo "✓ ClickHouse schema applied."

redis-ping: ## Verify Valkey is up (Redis-compatible)
	$(COMPOSE) exec -T valkey valkey-cli -a "$${VALKEY_PASSWORD}" ping

openapi-snapshot: ## Regenerate openapi.yaml snapshot from running Zod schemas
	cd apps/api && bun run openapi:snapshot

codegen: openapi-snapshot ## Regenerate typed TS + Python clients
	cd apps/api && bun run codegen:ts
	cd apps/api && bun run codegen:py

smoke: ## End-to-end smoke (AC1+AC2+AC9+AC10)
	bash infra/scripts/smoke.sh

doctor: ## Verify env, tools, and runtime readiness
	bash infra/scripts/doctor.sh

lint: ## Lint everything
	bun --filter "*" lint

typecheck: ## Type-check everything
	bun --filter "*" typecheck

test: ## Run all unit tests
	bun --filter "*" test

format: ## Auto-format
	bun --filter "*" format