"""Exercise the documented production backup commands without real services."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]

DOCKER_STUB = r'''#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys
import zipfile

args = sys.argv[1:]
expected = ["compose", "--project-directory", os.environ["EXPECTED_ROOT"],
            "--env-file", os.environ["EXPECTED_ENV"], "--project-name",
            os.environ["EXPECTED_PROJECT"], "-f", os.environ["EXPECTED_COMPOSE"]]
if args[:len(expected)] != expected:
    raise SystemExit(f"wrong Compose target: {args!r}")
if (os.environ.get("GLASSHOUSE_API_IMAGE"), os.environ.get("GLASSHOUSE_WEB_IMAGE")) != ("api-production", "web-production"):
    raise SystemExit("production image references were overridden")
with open(os.environ["DOCKER_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
command = args[len(expected):]
if command == ["config", "--format", "json"]:
    print(json.dumps({"services": {
        "postgres": {"environment": {"POSTGRES_USER": "prod_user", "POSTGRES_PASSWORD": "prod_password", "POSTGRES_DB": "prod_db"}},
        "clickhouse": {"environment": {"CLICKHOUSE_USER": "prod_ch_user", "CLICKHOUSE_PASSWORD": "prod_ch_password", "CLICKHOUSE_DB": "prod_ch_db"}}
    }}))
elif command[0] == "cp":
    with zipfile.ZipFile(command[-1], "w") as archive:
        archive.writestr("metadata.txt", "synthetic fixture")
elif "pg_dump" in command:
    if os.environ.get("PGPASSWORD") != "prod_password" or "--username=prod_user" not in command or "prod_db" not in command:
        raise SystemExit("incorrect PostgreSQL credentials or database")
    print("synthetic PostgreSQL dump")
elif "psql" in command:
    print("18.6")
elif any("mktemp /tmp/glasshouse-clickhouse-client." in arg for arg in command):
    print("/tmp/glasshouse-clickhouse-client.fixture123")
elif any("cat >" in arg for arg in command):
    config = sys.stdin.read()
    if "prod_ch_user" not in config or "prod_ch_password" not in config:
        raise SystemExit("incorrect ClickHouse credentials")
elif "--query=SELECT version()" in command:
    print("26.10.2.103")
'''


class ProductionBackupDocumentationTest(unittest.TestCase):
    def test_documented_commands_use_production_target_without_local_env(self):
        examples = (
            ("deploy/snapshot/README.md", "/path/to/snapshot/compose.yaml", "/secure/glasshouse.production.env"),
            ("docs/backup-restore.md", "/srv/glasshouse/infra/compose.production.yaml", "/run/secrets/glasshouse-production.env"),
        )
        for document, compose_example, env_example in examples:
            for local_env in (False, True):
                with self.subTest(document=document, conflicting_local_env=local_env), tempfile.TemporaryDirectory() as temp:
                    base = Path(temp)
                    checkout = base / "checkout"
                    scripts = checkout / "infra/scripts"
                    scripts.mkdir(parents=True)
                    for name in ("backup.sh", "backup-restore-common.sh", "with-local-env.sh", "normalize-env.sh"):
                        shutil.copy2(ROOT / "infra/scripts" / name, scripts / name)
                    shutil.copy2(ROOT / "Makefile", checkout / "Makefile")
                    if local_env:
                        # The local fixture is intentionally conflicting and must remain untouched.
                        (checkout / "infra/.env").write_text(
                            "BACKUP_SOURCE_COMPOSE_PROJECT=wrong-local-project\n"
                            "BACKUP_SOURCE_ENV_FILE=/wrong/local.env\n"
                            "BACKUP_SOURCE_COMPOSE_FILE=/wrong/local.yaml\n"
                            "GLASSHOUSE_API_IMAGE=wrong-local-api\n"
                            "GLASSHOUSE_WEB_IMAGE=wrong-local-web\n"
                            "DATABASE_URL=synthetic\n"
                        )
                    original_local_env = (checkout / "infra/.env").read_bytes() if local_env else None
                    binary = base / "bin"
                    binary.mkdir()
                    docker = binary / "docker"
                    docker.write_text(DOCKER_STUB)
                    docker.chmod(0o755)
                    node = binary / "node"
                    node.write_text("#!/bin/sh\necho 'unexpected node invocation' >&2\nexit 1\n")
                    node.chmod(0o755)
                    compose = base / "snapshot/compose.yaml"
                    compose.parent.mkdir()
                    compose.touch()
                    production_env = base / "production.env"
                    production_env.write_text("synthetic production environment\n")
                    text = (ROOT / document).read_text()
                    blocks = re.findall(r"```sh\n(.*?)\n```", text, re.DOTALL)
                    command = next(block for block in blocks if "BACKUP_DESTINATION=" in block)
                    command = command.replace("/secure/glasshouse-backups", str(base / "backups"))
                    command = command.replace(compose_example, str(compose)).replace(env_example, str(production_env))
                    environment = {
                        "PATH": f"{binary}:/usr/bin:/bin", "HOME": str(base),
                        "GLASSHOUSE_API_IMAGE": "api-production", "GLASSHOUSE_WEB_IMAGE": "web-production",
                        "BACKUP_ID": "fixture", "EXPECTED_ROOT": str(checkout),
                        "EXPECTED_ENV": str(production_env), "EXPECTED_PROJECT": "glasshouse-production",
                        "EXPECTED_COMPOSE": str(compose), "DOCKER_LOG": str(base / "docker.log"),
                    }
                    result = subprocess.run(["bash", "-eu", "-c", command], cwd=checkout, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
                    calls = [json.loads(line) for line in (base / "docker.log").read_text().splitlines()]
                    self.assertTrue(any("pg_dump" in call for call in calls))
                    self.assertTrue(any("cp" in call for call in calls))
                    self.assertTrue(any("BACKUP DATABASE `prod_ch_db`" in arg for call in calls for arg in call))
                    manifest = json.loads((base / "backups/fixture/manifest.json").read_text())
                    self.assertTrue(manifest["complete"])
                    self.assertEqual(manifest["postgres_server_version"], "18.6")
                    self.assertEqual(manifest["clickhouse_server_version"], "26.10.2.103")
                    if local_env:
                        self.assertEqual((checkout / "infra/.env").read_bytes(), original_local_env)
                    else:
                        self.assertFalse((checkout / "infra/.env").exists())


if __name__ == "__main__":
    unittest.main()
