#!/usr/bin/env bash
# Build once, then test the exported image and extracted deployment archive.
set -euo pipefail
: "${VERSION:?}" "${CANDIDATE_SHA:?}" "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_ACTIONS:?}"
[[ "$GITHUB_ACTIONS" == true && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ "$VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$ ]]
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
image="glasshouse:$VERSION"
asset="$RUNNER_TEMP/glasshouse-image.tar.gz"
bundle="$RUNNER_TEMP/glasshouse-candidate-bundle"
project="release-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
python3 infra/scripts/make-release-bundle.py "$VERSION" "$bundle"
tar -czf "$RUNNER_TEMP/glasshouse-bundle.tar.gz" -C "$RUNNER_TEMP" glasshouse-candidate-bundle
(cd "$RUNNER_TEMP" && sha256sum glasshouse-bundle.tar.gz > bundle-before.SHA256SUMS)
mv "$bundle" "$RUNNER_TEMP/glasshouse-original-bundle"
tar -xzf "$RUNNER_TEMP/glasshouse-bundle.tar.gz" -C "$RUNNER_TEMP"
docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$CANDIDATE_SHA" -f apps/api/Dockerfile.single -t "$image" .
before="$(docker image inspect --format '{{.Id}}' "$image")"
python3 infra/scripts/export-release-image.py "$image" "$asset"
python3 infra/scripts/check-release-asset.py "$asset" > "$RUNNER_TEMP/image-before.SHA256SUMS"
(cd "$RUNNER_TEMP" && sha256sum --check image-before.SHA256SUMS)
docker image rm "$image"
docker load -i "$asset"
test "$(docker image inspect --format '{{.Id}}' "$image")" = "$before"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$CANDIDATE_SHA"
python3 infra/scripts/release-image-scan.py "$image" "$before" "$RUNNER_TEMP/candidate-sbom.json"
docker run --rm --entrypoint /opt/gepa/bin/python "$before" /app/worker/gepa_worker.py --smoke
printf '%s\n' '{"source":"Summarize tasks","target":"system","evaluator":{"type":"default_adapter"},"dataset":{"version":1,"rubric":"Be accurate","training_examples":[{"input":"alpha","answer":"one"}],"validation_examples":[{"input":"zulu","answer":"two"}]},"model_config":{"task_lm":"openai/gpt-4o-mini","reflection_lm":"openai/gpt-4o-mini"},"provider_dispatch_key":"release_ci_worker","budget":{"max_metric_calls":2}}' | docker run --rm -i -e GEPA_WORKER_MODE=fake -e GEPA_ALLOWED_MODELS=openai/gpt-4o-mini --entrypoint /opt/gepa/bin/python "$before" /app/worker/gepa_worker.py | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["candidate"] == "Summarize tasks\n\nOptimize for clear, accurate answers."; assert x["metric_calls_used"] == 0'
cat > "$bundle/test.env" <<'EOF'
POSTGRES_USER=glasshouse_ci
POSTGRES_PASSWORD=synthetic-postgres-4f61cba90d
POSTGRES_DB=glasshouse_ci
CLICKHOUSE_USER=glasshouse_ci
CLICKHOUSE_PASSWORD=synthetic-clickhouse-6c70a4ed
CLICKHOUSE_DB=glasshouse_ci
VALKEY_PASSWORD=synthetic-valkey-8f71b2c0ad
UI_USERNAME=synthetic-owner
UI_PASSWORD=synthetic-ui-9b412e8cfa
GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=synthetic-owner
GLASSHOUSE_PUBLIC_ORIGIN=https://127.0.0.1:34443
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini
API_PORT=0
EOF
chmod 600 "$bundle/test.env"
printf 'GLASSHOUSE_IMAGE=%s\n' "$before" >> "$bundle/test.env"
compose=(docker compose --project-directory "$bundle" --env-file "$bundle/test.env" --project-name "$project" -f "$bundle/compose.yaml")
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then "${compose[@]}" ps --all || true; "${compose[@]}" logs --no-color --tail=100 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT
"${compose[@]}" config --quiet
"${compose[@]}" pull postgres clickhouse valkey
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240
bash infra/scripts/test-release-upgrade.sh "$bundle" "$project" "$before"
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$before"
address="$("${compose[@]}" port api 3000)"
CANDIDATE_URL="http://$address" bun apps/web/tests/release-candidate-browser.ts
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U glasshouse_ci -d glasshouse_ci -c "WITH o AS (INSERT INTO organizations(id, name, slug, default_project_id) VALUES ('d0000000-0000-4000-8000-000000000001', 'Foreign organization', 'foreign-org-ci', 'd0000000-0000-4000-8000-000000000002') RETURNING id) INSERT INTO projects(id, organization_id, name, slug) SELECT 'd0000000-0000-4000-8000-000000000002', id, 'Foreign project', 'foreign-project' FROM o"
"${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query "INSERT INTO traces (trace_id, organization_id, project_id, name, start_time, input_text) VALUES ('d0000000000040008000000000000003', 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'foreign-secret-trace', now64(3), 'foreign-private-data')"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$RUNNER_TEMP/candidate.key" -out "$RUNNER_TEMP/candidate.crt" -days 1 -subj '/CN=127.0.0.1' >/dev/null 2>&1
CANDIDATE_URL="http://$address" CANDIDATE_TLS_KEY="$RUNNER_TEMP/candidate.key" CANDIDATE_TLS_CERT="$RUNNER_TEMP/candidate.crt" bun apps/web/tests/release-candidate-authenticated.ts
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://$address/v1/projects")" = 401
curl --fail --silent --show-error --user synthetic-owner:synthetic-ui-9b412e8cfa "http://$address/v1/projects" > "$RUNNER_TEMP/projects.json"
project_id="$(python3 -c 'import json,sys; p=[x["id"] for x in json.load(open(sys.argv[1]))["items"] if x["slug"] == "default"]; assert len(p) == 1; print(p[0])' "$RUNNER_TEMP/projects.json")"
[[ "$project_id" =~ ^[0-9a-f-]{36}$ ]]
set +e
curl --fail --silent --show-error --no-buffer --max-time 8 --user synthetic-owner:synthetic-ui-9b412e8cfa "http://$address/v1/traces/events?project_id=$project_id" > "$RUNNER_TEMP/candidate-stream"
stream_status=$?
set -e
test "$stream_status" = 28
grep -q ':ok' "$RUNNER_TEMP/candidate-stream"
expected_pg="$(find infra/db/migrations -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')"
expected_ch="$(find infra/db/clickhouse -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')"
migrations() {
  pg="$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc 'SELECT count(*) FROM pgmigrations')"
  ch="$("${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query 'SELECT count() FROM glasshouse_schema_migrations')"
  test "$pg" = "$expected_pg"
  test "$ch" = "$expected_ch"
  "${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc 'SELECT name FROM pgmigrations ORDER BY name'
  "${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query 'SELECT * FROM glasshouse_schema_migrations ORDER BY 1 FORMAT TabSeparated'
}
migrations > "$RUNNER_TEMP/migrations-before"
"${compose[@]}" restart api
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 240 api
migrations > "$RUNNER_TEMP/migrations-after"
cmp "$RUNNER_TEMP/migrations-before" "$RUNNER_TEMP/migrations-after"
address="$("${compose[@]}" port api 3000)"
curl --fail --silent --show-error "http://$address/v1/health" >/dev/null
bash infra/scripts/test-release-recovery.sh "$bundle" "$project" "$before"
(cd "$RUNNER_TEMP" && sha256sum --check image-before.SHA256SUMS && sha256sum --check bundle-before.SHA256SUMS && sha256sum glasshouse-image.tar.gz glasshouse-bundle.tar.gz > SHA256SUMS)
