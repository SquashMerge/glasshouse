#!/usr/bin/env bash

resolve_path() {
	local base="$1"
	local path="$2"
	if [[ "$path" == /* ]]; then
		printf '%s\n' "$path"
	else
		printf '%s/%s\n' "$base" "$path"
	fi
}

require_file() {
	if [[ ! -f "$2" ]]; then
		printf '%s is required.\n' "$1" >&2
		exit 1
	fi
}

compose_service_value() {
	local service="$1"
	local key="$2"
	shift 2
	"$@" config --format json | python3 -c '
import json
import sys

service, key = sys.argv[1:]
data = json.load(sys.stdin)
environment = data.get("services", {}).get(service, {}).get("environment", {})
if isinstance(environment, list):
    environment = dict(item.split("=", 1) for item in environment if "=" in item)
value = environment.get(key)
if value is None or value == "":
    raise SystemExit(f"{key} is not configured for Compose service {service}")
print(value)
' "$service" "$key"
}

inspect_compose_project() {
	docker inspect --format='{{index .Config.Labels "com.docker.compose.project"}}' "$1"
}
