#!/usr/bin/env bash
set -euo pipefail

function_source="$(python3 - <<'PY'
from pathlib import Path

lines = Path("infra/scripts/doctor.sh").read_text().splitlines()
start = next(i for i, line in enumerate(lines) if line.startswith("version_at_least()"))
depth = 0
selected = []
for line in lines[start:]:
    selected.append(line)
    depth += line.count("{") - line.count("}")
    if depth == 0:
        break
print("\n".join(selected))
PY
)"

assert_version() {
	local actual="$1" required="$2" expected="$3" result
	if bash -c "$function_source; version_at_least \"\$1\" \"\$2\"" -- "$actual" "$required"; then
		result="pass"
	else
		result="fail"
	fi
	if [ "$result" != "$expected" ]; then
		printf 'expected %s >= %s to %s, got %s\n' "$actual" "$required" "$expected" "$result" >&2
		exit 1
	fi
}

assert_version "1.3.14" "1.3.14" pass
assert_version "1.3.15" "1.3.14" pass
assert_version "1.3.13" "1.3.14" fail
assert_version "22.12.0" "22.12.0" pass
assert_version "22.11.99" "22.12.0" fail
assert_version "1.3.14-canary.1" "1.3.14" fail
assert_version "22.12.0-rc.1" "22.12.0" fail
assert_version "not-a-version" "1.3.14" fail

bash -n infra/scripts/doctor.sh
