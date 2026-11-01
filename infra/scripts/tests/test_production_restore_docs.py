"""Run the documented restore command against isolated, fake Docker services."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[3]

DOCKER = r'''#!/usr/bin/python3
import json
import os
import posixpath
import sys

args = sys.argv[1:]
with open(os.environ["DOCKER_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
if args[0] == "inspect":
    if args[1:3] == ["--format", "{{.Id}}"] and args[3] in ("target-postgres", "target-clickhouse"):
        print(args[3])
    elif args[1].startswith("--format=") and args[2] == "source-postgres":
        print("glasshouse-production")
    elif args[1:] == ["source-postgres", "source-clickhouse", "target-postgres", "target-clickhouse"]:
        names = ["source-pg", "source-ch", "target-pg", "target-ch"]
        if os.environ.get("OVERLAP") == "1":
            names[2] = names[0]
        print(json.dumps([{"Mounts": [{"Type": "volume", "Name": n, "Source": "/fake/volumes/" + n}]} for n in names]))
    elif args[1:] == ["target-postgres", "target-clickhouse"]:
        print(json.dumps([{"Id": "target-" + service, "State": {"Running": True},
            "Config": {"Labels": {"com.docker.compose.project": os.environ.get("TARGET_PROJECT", "glasshouse-restore-20261027"), "com.docker.compose.service": service}},
            "Mounts": [{"Type": "volume", "Name": "target-" + suffix, "Destination": dest, "RW": True}]}
            for service, suffix, dest in (("postgres", "pg", "/var/lib/postgresql"), ("clickhouse", "ch", "/var/lib/clickhouse"))]))
    else:
        raise SystemExit("unexpected inspect: " + repr(args))
    raise SystemExit(0)
if args == ["context", "show"]:
    print("default")
    raise SystemExit(0)
if args == ["context", "inspect", "default"]:
    print(json.dumps([{"Endpoints": {"docker": {"Host": "unix:///var/run/docker.sock"}}}]))
    raise SystemExit(0)
if args == ["ps", "-aq", "--no-trunc"]:
    print("target-postgres target-clickhouse")
    raise SystemExit(0)
if args == ["volume", "inspect", "target-pg", "target-ch"]:
    print(json.dumps([{"Name": n, "Driver": "local", "Options": None, "Mountpoint": "/fake/volumes/" + n} for n in ("target-pg", "target-ch")]))
    raise SystemExit(0)
if args[:1] == ["exec"]:
    if args[1:3] in (["target-postgres", "sh"], ["target-clickhouse", "sh"]):
        print(posixpath.normpath(args[-1]))
    elif len(args) == 4 and args[1] in ("target-postgres", "target-clickhouse") and args[2:] == ["cat", "/proc/self/mountinfo"]:
        dest = "/var/lib/postgresql" if args[1] == "target-postgres" else "/var/lib/clickhouse"
        print("1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / " + dest + " rw - ext4 /dev/x rw")
    elif args[:5] == ["exec", "-i", "-e", "PGPASSWORD", "target-postgres"]:
        if os.environ.get("PGPASSWORD") != "target_pw":
            raise SystemExit("wrong target PostgreSQL credentials")
        if "psql" in args:
            if "--username=target_user" not in args or "--dbname=prod_db" not in args:
                raise SystemExit("wrong target PostgreSQL identity")
            query = next((a for a in args if a.startswith("--command=")), "")
            if "server_version" in query: print("18.6")
            elif "SHOW data_directory" in query: print("/var/lib/postgresql/data")
            elif "pg_tablespace" in query: print("0")
            elif "pg_namespace" in query: print("1" if os.environ.get("NONEMPTY_PG") == "1" else "0")
            else: raise SystemExit("unexpected PostgreSQL query")
        elif "pg_restore" in args:
            if sys.stdin.read() != "synthetic dump": raise SystemExit("wrong PostgreSQL restore data")
            if "--file=-" not in args and ("--single-transaction" not in args or "--dbname=prod_db" not in args):
                raise SystemExit("wrong restore options")
        else: raise SystemExit("unexpected PostgreSQL command")
    else:
        raise SystemExit("unexpected exec: " + repr(args))
    raise SystemExit(0)

source = ["compose", "--project-directory", os.environ["SOURCE_ROOT"], "--env-file", os.environ["SOURCE_ENV"], "--project-name", "glasshouse-production", "-f", os.environ["SOURCE_COMPOSE"]]
target = ["compose", "--project-directory", os.environ["TARGET_ROOT"], "--env-file", os.environ["TARGET_ENV"], "--project-name", os.environ.get("TARGET_PROJECT", "glasshouse-restore-20261027"), "-f", os.environ["TARGET_COMPOSE"]]
if args[:len(source)] == source:
    side, command = "source", args[len(source):]
elif args[:len(target)] == target:
    side, command = "target", args[len(target):]
else:
    raise SystemExit("unexpected Compose routing: " + repr(args))
if command[:2] == ["ps", "-q"]:
    if side == "source" and os.environ.get("SOURCE_DOWN") == "1":
        raise SystemExit(0)
    print(side + "-" + command[2])
elif side == "source":
    raise SystemExit("source may only be inspected, not modified")
elif command == ["config", "--format", "json"]:
    print(json.dumps({"services": {
        "postgres": {"environment": {"POSTGRES_USER": "target_user", "POSTGRES_PASSWORD": "target_pw", "POSTGRES_DB": "prod_db"}},
        "clickhouse": {"environment": {"CLICKHOUSE_USER": "target_ch", "CLICKHOUSE_PASSWORD": "target_ch_pw", "CLICKHOUSE_DB": "fixture"}}
    }, "volumes": {"pg": {"name": "target-pg", "external": os.environ.get("EXTERNAL_VOLUME") == "1"}, "ch": {"name": "target-ch"}}}))
elif any("mktemp /tmp/glasshouse-clickhouse-client." in s for s in command):
    print("/tmp/glasshouse-clickhouse-client.fixture123")
elif any("cat >" in s for s in command):
    data = sys.stdin.read()
    if "target_ch" not in data or "target_ch_pw" not in data:
        raise SystemExit("wrong target credentials")
elif "--query=SELECT version()" in command:
    print("26.10.2.103")
elif any("system.server_settings" in s for s in command):
    print("/var/lib/clickhouse/")
elif any("system.disks" in s for s in command):
    print(json.dumps({"name": "default", "path": "/var/lib/clickhouse/", "type": "Local"}))
elif any("SELECT count() FROM system.tables" in s for s in command):
    print("1" if os.environ.get("NONEMPTY_CH") == "1" else "0")
elif command[0] == "cp" or any("RESTORE DATABASE" in s for s in command) or any("rm -f --" in s or "chown clickhouse" in s for s in command):
    pass
else:
    raise SystemExit("unexpected Docker command: " + repr(command))
'''


class ProductionRestoreDocumentationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.checkout = self.base / "checkout"
        scripts = self.checkout / "infra/scripts"
        scripts.mkdir(parents=True)
        for name in ("restore.sh", "backup-restore-common.sh", "check-restore-mounts.py", "check-isolated-target.py", "check-clickhouse-backup.py"):
            shutil.copy2(ROOT / "infra/scripts" / name, scripts / name)
        shutil.copy2(ROOT / "Makefile", self.checkout / "Makefile")
        # A conflicting development env must neither be sourced nor modified.
        self.local_env = self.checkout / "infra/.env"
        self.local_env.write_text("BACKUP_SOURCE_COMPOSE_PROJECT=wrong-local-project\n")
        source = self.base / "snapshot/compose.yaml"
        target = self.base / "target/infra/compose.production.yaml"
        source.parent.mkdir()
        target.parent.mkdir(parents=True)
        source.touch()
        target.touch()
        source_env = self.base / "source.env"
        target_env = self.base / "target.env"
        source_env.write_text("fixture source\n")
        target_env.write_text("fixture target\n")
        artifact = self.base / "artifact"
        artifact.mkdir(mode=0o700)
        (artifact / "manifest.json").write_text(json.dumps({"format": "glasshouse-backup-v1", "complete": True, "source_id": "production-eu-1", "stores": ["postgresql", "clickhouse"], "postgres_server_version": "18.6", "clickhouse_server_version": "26.10.2.103"}))
        (artifact / "postgres.dump").write_text("synthetic dump")
        with zipfile.ZipFile(artifact / "clickhouse.zip", "w") as archive:
            archive.writestr('metadata/fixture.sql', 'CREATE DATABASE fixture')
            archive.writestr('.backup', '<config><version>1</version><timestamp>2026-10-30 00:00:00</timestamp><uuid>00000000-0000-0000-0000-000000000001</uuid><contents><file><name>metadata/fixture.sql</name><size>23</size><checksum>40335961bc46f9a0b4d2eac29708fba9</checksum></file></contents></config>')
        (artifact / "SHA256SUMS").write_text("".join(f"{hashlib.sha256((artifact / n).read_bytes()).hexdigest()}  {n}\n" for n in ("postgres.dump", "clickhouse.zip")))
        for item in artifact.iterdir():
            item.chmod(0o600)
        binary = self.base / "bin"
        binary.mkdir()
        docker = binary / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o755)
        self.log = self.base / "docker.log"
        self.env = {"PATH": f"{binary}:/usr/bin:/bin", "HOME": str(self.base),
                    "SOURCE_ROOT": str(self.checkout), "SOURCE_ENV": str(source_env), "SOURCE_COMPOSE": str(source),
                    "TARGET_ROOT": str(target.parent.parent), "TARGET_ENV": str(target_env), "TARGET_COMPOSE": str(target), "DOCKER_LOG": str(self.log)}
        text = (ROOT / "docs/backup-restore.md").read_text()
        self.command = next(b for b in re.findall(r"```sh\n(.*?)\n```", text, re.DOTALL) if "RESTORE_CONFIRMATION=" in b and "make restore" in b)
        for old, new in (("/secure/glasshouse-backups/20261027T120000Z-1234", artifact),
                         ("/srv/glasshouse/infra/compose.production.yaml", source),
                         ("/run/secrets/glasshouse-production.env", source_env),
                         ("/srv/glasshouse-restore/infra/compose.production.yaml", target),
                         ("/srv/glasshouse-restore", target.parent.parent),
                         ("/run/secrets/glasshouse-restore.env", target_env)):
            self.command = self.command.replace(old, str(new))

    def run_restore(self, command=None, **extra_env):
        self.log.unlink(missing_ok=True)
        result = subprocess.run(["bash", "-eu", "-c", command or self.command], cwd=self.checkout,
                                env={**self.env, **extra_env}, capture_output=True, text=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_documented_restore_routes_live_source_and_isolated_target(self):
        result, calls = self.run_restore()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        source_calls = [c for c in calls if "glasshouse-production" in c]
        target_calls = [c for c in calls if "glasshouse-restore-20261027" in c]
        self.assertEqual([c[-1] for c in source_calls], ["postgres", "clickhouse"])
        self.assertTrue(any("pg_restore" in c and "--single-transaction" in c for c in calls))
        self.assertTrue(any(any("RESTORE DATABASE" in a for a in c) for c in target_calls))
        self.assertEqual(self.local_env.read_text(), "BACKUP_SOURCE_COMPOSE_PROJECT=wrong-local-project\n")

    def test_omitting_source_settings_fails_before_docker(self):
        old_command = re.sub(r"^BACKUP_SOURCE_(?:COMPOSE_FILE|ENV_FILE|COMPOSE_PROJECT)=.*\\\n", "", self.command, flags=re.MULTILINE)
        result, calls = self.run_restore(old_command)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BACKUP_SOURCE_COMPOSE_FILE", result.stderr)
        self.assertEqual(calls, [])

    def test_same_source_project_and_bad_confirmation_refuse_writes(self):
        cases = ((self.command.replace("RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-restore-20261027", "RESTORE_TARGET_COMPOSE_PROJECT=glasshouse-production"),
                  {"TARGET_PROJECT": "glasshouse-production"}, "target Compose project is the live/source project"),
                 (self.command.replace("RESTORE GLASSHOUSE TO restore-drill-2026-10-27", "incorrect"),
                  {}, "exact RESTORE_CONFIRMATION is required"),
                 (self.command.replace("RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP'", "RESTORE_TRUSTED_ARTIFACT=''"),
                  {}, "verify provenance"))
        for command, env, reason in cases:
            with self.subTest(reason=reason):
                result, calls = self.run_restore(command, **env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)
                self.assertFalse(any(("pg_restore" in c and "--single-transaction" in c) or any("RESTORE DATABASE" in a for a in c) or "cp" in c for c in calls))

    def test_fail_closed_before_restore_writes(self):
        for env, reason in (({"SOURCE_DOWN": "1"}, "services must already be running"),
                            ({"OVERLAP": "1"}, "storage mounts overlap"),
                            ({"EXTERNAL_VOLUME": "1"}, "data volume must be declared non-external"),
                            ({"NONEMPTY_PG": "1"}, "target data stores are not empty"),
                            ({"NONEMPTY_CH": "1"}, "target data stores are not empty")):
            with self.subTest(env=env):
                result, calls = self.run_restore(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)
                self.assertFalse(any(("pg_restore" in c and "--single-transaction" in c) or any("RESTORE DATABASE" in a for a in c) or "cp" in c for c in calls))


if __name__ == "__main__":
    unittest.main()
