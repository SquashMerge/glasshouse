#!/usr/bin/env bash
# Non-publishing hosted CI only. This is a test-mode stack, not a production configuration.
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
cat > "$override" <<'YAML'
services:
  api:
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
address="$("${compose[@]}" port api 3000)"
CANDIDATE_URL="http://$address" CANDIDATE_EXPECT_FAKE_DENIAL=true bun infra/scripts/release-candidate-evaluation.ts
# Only this disposable CI stack is switched to test mode; the bundle stays production-only.
cat >> "$override" <<'YAML'
      NODE_ENV: test
YAML
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
address="$("${compose[@]}" port api 3000)"
CANDIDATE_URL="http://$address" CANDIDATE_STATE_FILE="$RUNNER_TEMP/candidate-evaluation-state.json" bun infra/scripts/release-candidate-evaluation.ts
"${compose[@]}" restart api
"${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 240 api
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")" = "$image"
address="$("${compose[@]}" port api 3000)"
CANDIDATE_URL="http://$address" CANDIDATE_READBACK_FILE="$RUNNER_TEMP/candidate-evaluation-state.json" bun infra/scripts/release-candidate-evaluation.ts
