#!/usr/bin/env bash
# Hosted CI only: upgrade a real historical application in this disposable stack.
set -euo pipefail
: "${GITHUB_ACTIONS:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}"
[[ "$GITHUB_ACTIONS" == true && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
bundle="${1:?bundle required}"
base_project="${2:?project required}"
candidate_id="${3:?candidate image ID required}"
[[ "$bundle" == "$RUNNER_TEMP/glasshouse-candidate-bundle" && "$base_project" == "release-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" && "$candidate_id" =~ ^sha256:[0-9a-f]{64}$ ]]
project="${base_project}-upgrade"
prior=0551b652966ea82c018b8413d576efc0ac93c655
# This immutable main ancestor predates the single-image bundle. Change only in
# a reviewed PR; a caller-selected image would not establish an upgrade path.
git merge-base --is-ancestor "$prior" HEAD
prior_dir="$(mktemp -d "$RUNNER_TEMP/release-prior.XXXXXXXX")"
prior_image="glasshouse-prior:${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
compose=(docker compose --project-directory "$bundle" --env-file "$bundle/test.env" --project-name "$project" -f "$bundle/compose.yaml")
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail=100 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans || true
  docker image rm "$prior_image" >/dev/null 2>&1 || true
  rm -rf -- "$prior_dir"
  exit "$status"
}
trap cleanup EXIT
git archive "$prior" | tar -x -C "$prior_dir"
docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$prior" -f "$prior_dir/apps/api/Dockerfile" -t "$prior_image" "$prior_dir"
prior_id="$(docker image inspect --format '{{.Id}}' "$prior_image")"
GLASSHOUSE_IMAGE="$prior_image" "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$prior_id"
address="$("${compose[@]}" port api 3000)"
curl --fail --silent --show-error --user synthetic-owner:synthetic-ui-9b412e8cfa "http://$address/v1/projects" >/dev/null
organization="$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc "SELECT organization_id FROM projects WHERE slug='default'")"
project_id="$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc "SELECT id FROM projects WHERE slug='default'")"
[[ "$organization" =~ ^[0-9a-f-]{36}$ && "$project_id" =~ ^[0-9a-f-]{36}$ ]]
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U glasshouse_ci -d glasshouse_ci -c "UPDATE projects SET name='Release upgrade fixture' WHERE id='$project_id' AND organization_id='$organization'"
"${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query "INSERT INTO traces (trace_id, organization_id, project_id, name, start_time, input_text) VALUES ('43000000000040008000000000000003', '$organization', '$project_id', 'release-upgrade', now64(3), 'prior-version-data')"
# Replace only the application container. The same datastore volumes and data
# remain mounted; the next boot executes the candidate migration runners.
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$candidate_id"
[[ "$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc "SELECT name FROM projects WHERE id='$project_id' AND organization_id='$organization'")" == 'Release upgrade fixture' ]]
[[ "$("${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query "SELECT count() FROM traces WHERE trace_id='43000000000040008000000000000003' AND organization_id='$organization' AND project_id='$project_id' AND input_text='prior-version-data'")" == 1 ]]
printf 'Historical application upgraded to the reloaded candidate with PostgreSQL and ClickHouse data retained\n'
