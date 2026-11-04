#!/usr/bin/env bash
# Hosted CI only: disposable test-mode stack used by candidate and publisher checks.
set -euo pipefail
: "${GITHUB_ACTIONS:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}" "${VERSION:?}" "${CANDIDATE_SHA:?}"
[[ "$GITHUB_ACTIONS" == true && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ "$VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$ && "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
bundle="$RUNNER_TEMP/glasshouse-candidate-bundle"
test -f "$bundle/test.env"
image="$(docker image inspect --format '{{.Id}}' "glasshouse:$VERSION")"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$CANDIDATE_SHA"
test "$(python3 -c 'import sys; x=[s.strip().split("=",1)[1] for s in open(sys.argv[1]) if s.startswith("GLASSHOUSE_IMAGE=")]; assert len(x)==1; print(x[0])' "$bundle/test.env")" = "$image"
project="release-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-evaluation"
override="$RUNNER_TEMP/candidate-evaluation-override.yaml"
export FIXTURE_PATH="$PWD/infra/scripts/release-candidate-openai-fixture.py"
export CANDIDATE_SCRIPTS="$PWD/infra/scripts"
export CANDIDATE_STATE_DIR="$RUNNER_TEMP/candidate-lifecycle-state"
mkdir -p "$CANDIDATE_STATE_DIR"
cat > "$override" <<'YAML'
networks:
  default:
    internal: true
services:
  fixture:
    image: ${GLASSHOUSE_IMAGE}
    entrypoint: ["/opt/gepa/bin/python", "/fixture/provider.py"]
    volumes:
      - ${FIXTURE_PATH}:/fixture/provider.py:ro
    restart: "no"
  api:
    volumes:
      - ${CANDIDATE_SCRIPTS}:/candidate-scripts:ro
      - ${CANDIDATE_STATE_DIR}:/candidate-state
    environment:
      GLASSHOUSE_EVAL_LLM_PROVIDER: fake
      OPENAI_MODEL: deterministic
      EVALUATION_ALLOWED_MODELS: fake/deterministic
      OPENAI_API_KEY: ""
      OPENAI_API_BASE: ""
      ANTHROPIC_API_KEY: ""
      GEMINI_API_KEY: ""
      LITELLM_API_KEY: ""
YAML
compose=(docker compose --project-directory "$bundle" --env-file "$bundle/test.env" --project-name "$project" -f "$bundle/compose.yaml" -f "$override")
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then "${compose[@]}" ps --all || true; "${compose[@]}" logs --no-color --tail=100 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
probe=(exec -T --user root -e CANDIDATE_URL=http://127.0.0.1:3000)
"${compose[@]}" "${probe[@]}" -e CANDIDATE_EXPECT_FAKE_DENIAL=true api bun /candidate-scripts/release-candidate-evaluation.ts
# Only this disposable CI stack is switched to test mode; the bundle stays production-only.
cat >> "$override" <<'YAML'
      NODE_ENV: test
      GEPA_WORKER_MODE: fake
YAML
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
"${compose[@]}" "${probe[@]}" -e CANDIDATE_STATE_FILE=/candidate-state/evaluation.json api bun /candidate-scripts/release-candidate-evaluation.ts
"${compose[@]}" "${probe[@]}" -e CANDIDATE_STATE_FILE=/candidate-state/gepa.json api bun /candidate-scripts/release-candidate-gepa.ts
real_override="$RUNNER_TEMP/candidate-gepa-real-override.yaml"
cat > "$real_override" <<'YAML'
services:
  api:
    environment:
      GEPA_WORKER_MODE: gepa
      OPENAI_API_KEY: synthetic-gepa-key
      OPENAI_API_BASE: http://fixture:8080/v1
      NO_PROXY: fixture,localhost,127.0.0.1
      no_proxy: fixture,localhost,127.0.0.1
YAML
compose+=(-f "$real_override")
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api fixture
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
"${compose[@]}" "${probe[@]}" -e CANDIDATE_REAL_GEPA=true -e CANDIDATE_STATE_FILE=/candidate-state/gepa-real.json api bun /candidate-scripts/release-candidate-gepa.ts
"${compose[@]}" exec -T fixture /opt/gepa/bin/python -c 'import json,urllib.request; s=json.load(urllib.request.urlopen("http://localhost:8080/stats")); print("Synthetic provider call counts:", s); assert s["task_seed"] > 0 and s["task_candidate"] > 0 and s["reflection"] > 0 and s["rejected"] == 0'
"${compose[@]}" restart api
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 240 api
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
"${compose[@]}" "${probe[@]}" -e CANDIDATE_READBACK_FILE=/candidate-state/evaluation.json api bun /candidate-scripts/release-candidate-evaluation.ts
"${compose[@]}" "${probe[@]}" -e CANDIDATE_READBACK_FILE=/candidate-state/gepa.json api bun /candidate-scripts/release-candidate-gepa.ts
"${compose[@]}" "${probe[@]}" -e CANDIDATE_REAL_GEPA=true -e CANDIDATE_READBACK_FILE=/candidate-state/gepa-real.json api bun /candidate-scripts/release-candidate-gepa.ts
