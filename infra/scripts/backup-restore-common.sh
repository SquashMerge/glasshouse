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

create_clickhouse_client_config() {
	local service="$1"
	local user="$2"
	local password="$3"
	shift 3
	local path
	path="$("$@" exec -T "$service" sh -ec 'umask 077; mktemp /tmp/glasshouse-clickhouse-client.XXXXXX')"
	if [[ ! "$path" =~ ^/tmp/glasshouse-clickhouse-client\.[A-Za-z0-9]+$ ]]; then
		printf 'Failed to create a private ClickHouse client config.\n' >&2
		return 1
	fi
	if ! printf '%s\0%s' "$user" "$password" | python3 -c '
import sys
from xml.sax.saxutils import escape

user, password = sys.stdin.buffer.read().decode().split("\0", 1)
sys.stdout.write(f"<clickhouse><user>{escape(user)}</user><password>{escape(password)}</password></clickhouse>\n")
' | "$@" exec -T "$service" sh -ec 'cat > "$1"; chmod 600 "$1"' sh "$path"; then
		"$@" exec -T "$service" sh -ec 'rm -f -- "$1"' sh "$path" >/dev/null 2>&1 || true
		return 1
	fi
	printf '%s\n' "$path"
}

remove_clickhouse_client_config() {
	local service="$1"
	local path="$2"
	shift 2
	[[ "$path" =~ ^/tmp/glasshouse-clickhouse-client\.[A-Za-z0-9]+$ ]] || return 0
	"$@" exec -T "$service" sh -ec 'rm -f -- "$1"' sh "$path" >/dev/null 2>&1 || true
}

inspect_compose_project() {
	docker inspect --format='{{index .Config.Labels "com.docker.compose.project"}}' "$1"
}
