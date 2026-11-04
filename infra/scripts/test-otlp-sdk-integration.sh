#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$root"

release=false
if [[ "${1:-}" == --release-candidate && $# == 1 ]]; then
  release=true
  [[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || {
    printf '%s\n' 'Release proof is restricted to GitHub Actions.' >&2; exit 2;
  }
elif (($#)); then
  printf '%s\n' 'Usage: test-otlp-sdk-integration.sh [--release-candidate]' >&2
  exit 2
fi
if [[ -v OTLP_SDK_PROJECT ]]; then
  printf '%s\n' 'OTLP_SDK_PROJECT must not be set; the harness generates its own project name.' >&2
  exit 2
fi
for variable in $(compgen -v COMPOSE_); do
  printf '%s\n' "$variable must not be set; the harness rejects Compose environment overrides." >&2
  exit 2
done

project="otlp-sdk-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
ownership_marker="otlp-sdk-ownership-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
harness_home="$(mktemp -d)"
venv="$(mktemp -d)"
build_context="$(mktemp -d)"
compose_env="$harness_home/compose.env"
compose_override="$harness_home/ownership.yaml"
touch "$compose_env"
up_attempted=false
cleanup_failed=false
declare -a owned_container_ids=()
declare -a owned_network_ids=()

docker_safe() {
  env -i PATH="$PATH" HOME="$harness_home" DOCKER_CONFIG="$harness_home/docker" docker "$@"
}

bash "$root/infra/scripts/stage-build-context.sh" "$build_context"
if "$release"; then
  # The release archive and image are assembled from the immutable checkout, never published.
  sha="$(git rev-parse HEAD)"
  [[ "$sha" == "${GITHUB_SHA:-}" ]] || { printf '%s\n' 'Checkout does not match the workflow SHA.' >&2; exit 1; }
  image="glasshouse:${project}"
  test -z "$(docker_safe image ls -q "$image")" || { printf '%s\n' 'Image tag collision.' >&2; exit 1; }
  python3 infra/scripts/make-release-bundle.py v0.0.0-rc.1 "$harness_home/original"
  tar -czf "$harness_home/bundle.tar.gz" -C "$harness_home" original
  mkdir "$harness_home/extracted"
  tar -xzf "$harness_home/bundle.tar.gz" -C "$harness_home/extracted"
  bundle="$harness_home/extracted/original"
  test -f "$bundle/compose.otlp-grpc.yaml"
  docker_safe build --platform linux/amd64 --label "org.opencontainers.image.revision=$sha" -f "$build_context/apps/api/Dockerfile.single" -t "$image" "$build_context"
  image_id="$(docker_safe image inspect --format '{{.Id}}' "$image")"
  env -i PATH="$PATH" HOME="$harness_home" DOCKER_CONFIG="$harness_home/docker" python3 infra/scripts/export-release-image.py "$image" "$harness_home/image.tar.gz"
  docker_safe image rm "$image"
  docker_safe load -i "$harness_home/image.tar.gz"
  test "$(docker_safe image inspect --format '{{.Id}}' "$image")" = "$image_id"
  test "$(docker_safe image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$sha"
  cat > "$compose_env" <<EOF
GLASSHOUSE_IMAGE=$image_id
POSTGRES_USER=otlp_test
POSTGRES_PASSWORD=otlp-test-password
POSTGRES_DB=glasshouse
CLICKHOUSE_USER=otlp_test
CLICKHOUSE_PASSWORD=otlp-test-password
CLICKHOUSE_DB=glasshouse
VALKEY_PASSWORD=otlp-test-password
UI_USERNAME=otlp-sdk
UI_PASSWORD=otlp-sdk-password
GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=otlp-sdk
GLASSHOUSE_PUBLIC_ORIGIN=https://127.0.0.1:34443
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini
API_PORT=0
OTLP_GRPC_HOST_PORT=0
EOF
  chmod 600 "$compose_env"
  base_compose=(docker_safe compose --project-directory "$bundle" --project-name "$project" --env-file "$compose_env" -f "$bundle/compose.yaml" -f "$bundle/compose.otlp-grpc.yaml")
else
  base_compose=(docker_safe compose --project-directory "$build_context" --project-name "$project" --env-file "$compose_env" -f "$build_context/.github/compose.otlp-sdk-integration.yaml")
fi
services=""
networks=""
volumes=""

validate_effective_fixture() {
  local config
  if ! config="$("${base_compose[@]}" config --format json)"; then
    printf '%s\n' 'OTLP SDK harness could not render the effective Compose fixture; refusing to start.' >&2
    exit 1
  fi
  if ! CONFIG="$config" PROJECT="$project" python3 - <<'PY'
import json
import os
import sys

config = json.loads(os.environ["CONFIG"])
for service in config.get("services", {}).values():
    if service.get("container_name"):
        sys.exit("fixture has a fixed container name")
    for port in service.get("ports", []):
        if isinstance(port, dict) and port.get("published") not in (None, "", 0, "0"):
            sys.exit("fixture has a fixed published port")
project = os.environ["PROJECT"]
for kind, resources in (("network", config.get("networks", {})), ("volume", config.get("volumes", {}))):
    for key, resource in resources.items():
        if resource.get("external"):
            sys.exit(f"fixture has an external {kind}")
        if resource.get("name") != f"{project}_{key}":
            sys.exit(f"fixture has an unexpected {kind} name")
PY
  then
    printf '%s\n' 'OTLP SDK harness effective Compose fixture is unsafe; refusing to start.' >&2
    exit 1
  fi
}

load_compose_resources() {
  if ! services="$("${base_compose[@]}" config --services)"; then
    printf '%s\n' 'OTLP SDK harness could not list Compose services; refusing to start.' >&2
    exit 1
  fi
  if ! networks="$("${base_compose[@]}" config --networks)"; then
    printf '%s\n' 'OTLP SDK harness could not list Compose networks; refusing to start.' >&2
    exit 1
  fi
  if ! volumes="$("${base_compose[@]}" config --volumes)"; then
    printf '%s\n' 'OTLP SDK harness could not list Compose volumes; refusing to start.' >&2
    exit 1
  fi
}

write_ownership_override() {
  local service network
  {
    printf 'services:\n'
    while IFS= read -r service; do
      [[ -n "$service" ]] || continue
      printf '  %s:\n    labels:\n      io.glasshouse.otlp-sdk-run: %s\n' "$service" "$ownership_marker"
    done <<< "$services"
    printf 'networks:\n'
    printf '  default:\n    labels:\n      io.glasshouse.otlp-sdk-run: %s\n' "$ownership_marker"
    while IFS= read -r network; do
      [[ -n "$network" && "$network" != "default" ]] || continue
      printf '  %s:\n    labels:\n      io.glasshouse.otlp-sdk-run: %s\n' "$network" "$ownership_marker"
    done <<< "$networks"
  } > "$compose_override"
}

compose=("${base_compose[@]}" -f "$compose_override")

inventory() {
  local kind="$1"
  case "$kind" in
    containers) docker_safe ps -aq --no-trunc --filter "label=com.docker.compose.project=$project" ;;
    networks) docker_safe network ls -q --no-trunc --filter "label=com.docker.compose.project=$project" ;;
    volumes) docker_safe volume ls -q --filter "label=com.docker.compose.project=$project" ;;
    *) return 2 ;;
  esac
}

expected_name_is_absent() {
  local kind="$1" name="$2" entries
  case "$kind" in
    containers) entries="$(docker_safe ps -a --format '{{.ID}} {{.Names}}')" ;;
    networks) entries="$(docker_safe network ls --format '{{.ID}} {{.Name}}')" ;;
    volumes) entries="$(docker_safe volume ls --format '{{.Name}}')" ;;
    *) return 2 ;;
  esac || return 1
  while IFS= read -r entry; do
    [[ "$entry" == "$name" || "$entry" == *" $name" ]] && return 1
  done <<< "$entries"
  return 0
}

require_empty_inventory() {
  local kind="$1" ids
  if ! ids="$(inventory "$kind")"; then
    printf 'OTLP SDK harness could not inventory %s; refusing to start.\n' "$kind" >&2
    exit 1
  fi
  if [[ -n "$ids" ]]; then
    printf 'OTLP SDK harness project %s already has labeled resources; refusing to start.\n' "$project" >&2
    exit 1
  fi
}

capture_owned_resources() {
  local kind ids id labels
  local -a captured_container_ids=()
  local -a captured_network_ids=()
  for kind in containers networks; do
    if ! ids="$(inventory "$kind")"; then
      return 1
    fi
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      if [[ "$kind" == containers ]]; then
        labels="$(docker_safe container inspect --format '{{.Id}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "io.glasshouse.otlp-sdk-run"}}' "$id")" || return 1
      else
        labels="$(docker_safe network inspect --format '{{.Id}} {{index .Labels "com.docker.compose.project"}} {{index .Labels "io.glasshouse.otlp-sdk-run"}}' "$id")" || return 1
      fi
      [[ "$labels" == "$id $project $ownership_marker" ]] || return 1
      if [[ "$kind" == containers ]]; then captured_container_ids+=("$id"); else captured_network_ids+=("$id"); fi
    done <<< "$ids"
  done
  owned_container_ids=("${captured_container_ids[@]}")
  owned_network_ids=("${captured_network_ids[@]}")
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if "$up_attempted" && ! capture_owned_resources; then
    printf '%s\n' 'OTLP SDK harness ownership is unproven; refusing cleanup.' >&2
    cleanup_failed=true
  fi
  local id labels
  if (( status != 0 )) && "$release" && ! "$cleanup_failed"; then
    for id in "${owned_container_ids[@]}"; do
      docker_safe logs --tail 100 "$id" 2>&1 || true
    done
  fi
  for id in "${owned_container_ids[@]}"; do
    labels="$(docker_safe container inspect --format '{{.Id}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "io.glasshouse.otlp-sdk-run"}}' "$id")" || { cleanup_failed=true; continue; }
    [[ "$labels" == "$id $project $ownership_marker" ]] || { cleanup_failed=true; continue; }
    docker_safe container stop "$id" >/dev/null && docker_safe container rm "$id" >/dev/null || cleanup_failed=true
  done
  for id in "${owned_network_ids[@]}"; do
    labels="$(docker_safe network inspect --format '{{.Id}} {{index .Labels "com.docker.compose.project"}} {{index .Labels "io.glasshouse.otlp-sdk-run"}}' "$id")" || { cleanup_failed=true; continue; }
    [[ "$labels" == "$id $project $ownership_marker" ]] || { cleanup_failed=true; continue; }
    docker_safe network rm "$id" >/dev/null || cleanup_failed=true
  done
  if "$cleanup_failed"; then
    printf '%s\n' 'OTLP SDK harness cleanup was incomplete; unverified resources were left untouched.' >&2
    status=1
  fi
  rm -rf -- "$venv" "$harness_home" "$build_context"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

validate_effective_fixture
load_compose_resources
write_ownership_override
require_empty_inventory containers
require_empty_inventory networks
require_empty_inventory volumes
while IFS= read -r service; do
  [[ -n "$service" ]] || continue
  expected_name_is_absent containers "${project}-${service}-1" || { printf '%s\n' 'OTLP SDK harness expected container name already exists; refusing to start.' >&2; exit 1; }
done <<< "$services"
expected_name_is_absent networks "${project}_default" || { printf '%s\n' 'OTLP SDK harness expected network name already exists; refusing to start.' >&2; exit 1; }
while IFS= read -r network; do
  [[ "$network" == "default" ]] && continue
  expected_name_is_absent networks "${project}_${network}" || { printf '%s\n' 'OTLP SDK harness expected network name already exists; refusing to start.' >&2; exit 1; }
done <<< "$networks"
while IFS= read -r volume; do
  [[ -n "$volume" ]] || continue
  expected_name_is_absent volumes "${project}_${volume}" || { printf '%s\n' 'OTLP SDK harness expected volume name already exists; refusing to start.' >&2; exit 1; }
done <<< "$volumes"

up_attempted=true
if "$release"; then
  "${compose[@]}" pull postgres clickhouse valkey
  "${compose[@]}" up --no-build --pull never --detach --wait --wait-timeout 240
  test "$(docker_safe inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image_id"
  printf 'Running extracted bundle with reloaded image %s at source %s\n' "$image_id" "$sha"
else
  "${compose[@]}" up --build --detach --wait --wait-timeout 180
fi

api_port="$("${compose[@]}" port api 3000 | awk -F: '{print $NF}')"
grpc_port="$("${compose[@]}" port api 4317 | awk -F: '{print $NF}')"
project_id="$("${compose[@]}" exec -T postgres psql -U otlp_test -d glasshouse -Atqc "SELECT id FROM projects WHERE slug = 'default' LIMIT 1")"
organization_id="$("${compose[@]}" exec -T postgres psql -U otlp_test -d glasshouse -Atqc "SELECT organization_id FROM projects WHERE id = '${project_id}' LIMIT 1")"
test -n "$project_id"
test -n "$organization_id"
wrong_project_slug="sdk-denied-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
wrong_project_json="$(curl --fail --silent --show-error --user 'otlp-sdk:otlp-sdk-password' --header 'content-type: application/json' --data "{\"name\":\"SDK denied Project\",\"slug\":\"${wrong_project_slug}\"}" "http://127.0.0.1:${api_port}/v1/projects")"
wrong_project_id="$(RESULT="$wrong_project_json" python3 -c 'import json, os; print(json.loads(os.environ["RESULT"])["id"])')"
ingest_credential_json="$(curl --fail --silent --show-error --user 'otlp-sdk:otlp-sdk-password' --header 'content-type: application/json' --data "{\"project_id\":\"${project_id}\",\"name\":\"SDK interoperability\"}" "http://127.0.0.1:${api_port}/v1/admin/otlp-credentials")"
ingest_token="$(RESULT="$ingest_credential_json" python3 -c 'import json, os; print(json.loads(os.environ["RESULT"])["secret"])')"
test -n "$wrong_project_id"
test -n "$ingest_token"

env -i PATH="$PATH" HOME="$harness_home" PIP_CONFIG_FILE=/dev/null \
  python3 -m venv "$venv"
env -i PATH="$PATH" HOME="$harness_home" PIP_CONFIG_FILE=/dev/null \
  "$venv/bin/pip" install --disable-pip-version-check --no-input --require-hashes --no-deps -r infra/otlp-sdk-requirements.txt
env -i PATH="$PATH" HOME="$harness_home" PIP_CONFIG_FILE=/dev/null \
  "$venv/bin/pip" check
transports=(http grpc)
if "$release"; then transports=(grpc); fi
for transport in "${transports[@]}"; do
  result_file="$(mktemp)"
  env -i PATH="$PATH" HOME="$harness_home" "$venv/bin/python" infra/scripts/otlp-sdk-integration.py \
    --transport "$transport" \
    --api-endpoint "http://127.0.0.1:$api_port" \
    --grpc-endpoint "http://127.0.0.1:$grpc_port" \
    --username otlp-sdk --password otlp-sdk-password --ingest-token "$ingest_token" \
    --project-id "$project_id" --wrong-project-id "$wrong_project_id" \
    --result-file "$result_file"
  read -r trace_ids observation_ids denied_trace_ids denied_observation_ids < <(env -i PATH="$PATH" HOME="$harness_home" python3 - "$result_file" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
print(*("','".join(result[key]) for key in ("trace_ids", "observation_ids", "denied_trace_ids", "denied_observation_ids")))
PY
)
  trace_count="$("${compose[@]}" exec -T clickhouse clickhouse-client --user otlp_test --password otlp-test-password --database glasshouse --query "SELECT count() FROM traces WHERE organization_id = '${organization_id}' AND project_id = '${project_id}' AND trace_id IN ('${trace_ids}')")"
  observation_count="$("${compose[@]}" exec -T clickhouse clickhouse-client --user otlp_test --password otlp-test-password --database glasshouse --query "SELECT count() FROM observations WHERE organization_id = '${organization_id}' AND project_id = '${project_id}' AND observation_id IN ('${observation_ids}')")"
  denied_trace_count="$("${compose[@]}" exec -T clickhouse clickhouse-client --user otlp_test --password otlp-test-password --database glasshouse --query "SELECT count() FROM traces WHERE trace_id IN ('${denied_trace_ids}')")"
  denied_observation_count="$("${compose[@]}" exec -T clickhouse clickhouse-client --user otlp_test --password otlp-test-password --database glasshouse --query "SELECT count() FROM observations WHERE observation_id IN ('${denied_observation_ids}')")"
  expected_trace_count="1"
  expected_observation_count="2"
  if [[ "$transport" == "http" ]]; then
    expected_trace_count="2"
    expected_observation_count="4"
  fi
  test "$trace_count" = "$expected_trace_count"
  test "$observation_count" = "$expected_observation_count"
  test "$denied_trace_count" = "0"
  test "$denied_observation_count" = "0"
  printf '%s exporter: %s authorized traces, %s observations; denied writes: %s/%s\n' "$transport" "$trace_count" "$observation_count" "$denied_trace_count" "$denied_observation_count"
  rm -f -- "$result_file"
done

if "$release"; then
  api_id="$("${compose[@]}" ps -q api)"
  started=$SECONDS
  docker_safe stop --time 20 "$api_id" >/dev/null
  elapsed=$((SECONDS - started))
  exit_code="$(docker_safe inspect --format '{{.State.ExitCode}}' "$api_id")"
  test "$exit_code" != 137
  test "$elapsed" -lt 20
  env -i PATH="$PATH" HOME="$harness_home" python3 - "$api_port" "$grpc_port" <<'PY'
import socket
import sys
for port in map(int, sys.argv[1:]):
    with socket.socket() as connection:
        connection.settimeout(2)
        if connection.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(f"listener {port} still accepts connections after stop")
print("Both API and gRPC listener ports closed after container stop")
PY
  printf 'Container stopped in %ss, exit code %s (not a proof of graceful draining).\n' "$elapsed" "$exit_code"
fi
