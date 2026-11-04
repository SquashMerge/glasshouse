#!/usr/bin/env bash
# Hosted CI only: recover the running candidate via its assembled bundle.
set -euo pipefail
umask 077
: "${GITHUB_ACTIONS:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}"
[[ "$GITHUB_ACTIONS" == true && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
bundle="${1:?bundle required}"
project="${2:?project required}"
[[ "$bundle" == "$RUNNER_TEMP/glasshouse-candidate-bundle" && "$project" == "release-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" ]]
target_project="${project}-restore"
target="$(mktemp -d "$RUNNER_TEMP/release-recovery.XXXXXXXX")"
cp -a "$bundle/." "$target/"
source_compose=(docker compose --project-directory "$bundle" --env-file "$bundle/test.env" --project-name "$project" -f "$bundle/compose.yaml")
target_compose=(docker compose --project-directory "$target" --env-file "$target/test.env" --project-name "$target_project" -f "$target/compose.yaml")
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${target_compose[@]}" ps --all || true
    "${target_compose[@]}" logs --no-color --tail=100 || true
  fi
  "${target_compose[@]}" down --volumes --remove-orphans || true
  rm -rf -- "$target"
  exit "$status"
}
trap cleanup EXIT

# Both probes and all volumes belong exclusively to this run's disposable stack.
"${source_compose[@]}" stop api
"${source_compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U glasshouse_ci -d glasshouse_ci -c "CREATE TABLE release_recovery_probe (organization_id text NOT NULL, project_id text NOT NULL, payload text NOT NULL); INSERT INTO release_recovery_probe VALUES ('org-ci', 'project-ci', 'pg-ci');"
"${source_compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --multiquery --query "CREATE TABLE release_recovery_probe (organization_id String, project_id String, payload String) ENGINE=MergeTree ORDER BY (organization_id, project_id); INSERT INTO release_recovery_probe VALUES ('org-ci', 'project-ci', 'ch-ci');"
"${target_compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 postgres clickhouse
export BACKUP_SOURCE_COMPOSE_FILE="$bundle/compose.yaml" BACKUP_SOURCE_ENV_FILE="$bundle/test.env" BACKUP_SOURCE_COMPOSE_PROJECT="$project"
export BACKUP_DESTINATION="$target/artifacts" BACKUP_SOURCE_ID=release-ci BACKUP_ID=release-recovery
(cd "$bundle" && bash infra/scripts/backup.sh)
export BACKUP_ARTIFACT="$target/artifacts/release-recovery"
(cd "$bundle" && bash infra/scripts/restore.sh --validate-only)
export RESTORE_TARGET_ID=release-recovery RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO release-recovery'
export RESTORE_TARGET_LIVE=false RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP'
export RESTORE_TARGET_DIRECTORY="$target" RESTORE_TARGET_COMPOSE_FILE="$target/compose.yaml"
export RESTORE_TARGET_ENV_FILE="$target/test.env" RESTORE_TARGET_COMPOSE_PROJECT="$target_project"
(cd "$bundle" && bash infra/scripts/restore.sh)
[[ "$("${target_compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc "SELECT payload FROM release_recovery_probe WHERE organization_id='org-ci' AND project_id='project-ci'")" == pg-ci ]]
[[ "$("${target_compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query "SELECT payload FROM release_recovery_probe WHERE organization_id='org-ci' AND project_id='project-ci'")" == ch-ci ]]
"${target_compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api
address="$("${target_compose[@]}" port api 3000)"
curl --fail --silent --show-error --user synthetic-owner:synthetic-ui-9b412e8cfa "http://$address/v1/projects" | python3 -c 'import json,sys; assert any(p["slug"] == "default" for p in json.load(sys.stdin)["items"])'
printf 'Standalone bundle backup, isolated restore, scoped probes and recovered API passed\n'
