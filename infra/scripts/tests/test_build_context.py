import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


class DockerBuildContextTests(unittest.TestCase):
    def test_app_dockerfiles_share_the_root_ignore_policy(self):
        self.assertTrue((ROOT / ".dockerignore").is_file())
        for app in ("api", "web"):
            dockerfile = ROOT / "apps" / app / "Dockerfile"
            self.assertFalse(dockerfile.with_name("Dockerfile.dockerignore").exists())
            self.assertIn("COPY . .", dockerfile.read_text())

    @unittest.skipUnless(
        os.environ.get("GLASSHOUSE_TEST_DOCKER_CONTEXT") == "1",
        "set GLASSHOUSE_TEST_DOCKER_CONTEXT=1 for the Docker/BuildKit context check",
    )
    def test_docker_excludes_synthetic_secrets_and_retains_build_inputs(self):
        required = [
            "package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json",
            "apps/api/src/index.ts", "apps/api/tsconfig.json", "apps/web/tsconfig.json",
            "apps/web/src/main.tsx", "apps/web/index.html", "apps/web/vite.config.ts",
            "worker/gepa_worker.py", "worker/requirements.lock",
            "infra/clickhouse/backup.xml", "infra/scripts/verify-pg-migration-filenames.ts",
        ]
        required.extend(
            str(path.relative_to(ROOT))
            for directory in ("infra/db/migrations", "infra/db/clickhouse")
            for path in sorted((ROOT / directory).rglob("*.sql"))
        )
        excluded = [
            "infra/.env", ".env.production", "apps/api/.env.local",
            "operator.production.env", "infra/credentials.pem", "infra/server.key",
            "backups/snapshot/data", "infra/backups/snapshot/data",
            "infra/db/backups/snapshot.sql", "infra/db/.env.secret.sql",
            "arbitrary/database.dump", "arbitrary/database.sql", "arbitrary/db.sql.gz",
            "arbitrary/dump/trace.sql", "arbitrary/dump/trace.json",
            "arbitrary/snapshot.zip", "arbitrary/config.bak", "infra/.env.tmp",
            ".git/config", "node_modules/package/index.js",
            "apps/web/node_modules/package/index.js", "worker/.venv/lib/dependency.py",
            ".venv-gepa/lib/dependency.py", "worker/__pycache__/worker.pyc",
            ".cache/state", "apps/web/dist/index.html", "logs/api.log",
            ".opencode/factory/state.json", ".ci-backup-restore/source.env",
        ]
        with tempfile.TemporaryDirectory(prefix="glasshouse-build-context-") as directory:
            directory = Path(directory)
            context = directory / "context"
            context.mkdir()
            shutil.copy2(ROOT / ".dockerignore", context / ".dockerignore")
            for name in required:
                source = ROOT / name
                self.assertTrue(source.is_file(), f"missing required build input: {name}")
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            for name in excluded:
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("synthetic-build-context-secret\n")
            dockerfile = directory / "Dockerfile"
            dockerfile.write_text("FROM scratch\nCOPY . /\n")
            output = directory / "output"
            result = subprocess.run(
                ["docker", "build", "--no-cache", "--progress=plain", "--file", str(dockerfile),
                 "--output", f"type=local,dest={output}", str(context)],
                capture_output=True, text=True, timeout=180,
            )
            self.assertEqual(result.returncode, 0, "synthetic BuildKit context export failed")
            for name in required:
                self.assertTrue((output / name).is_file(), f"excluded build input: {name}")
            for name in excluded:
                self.assertFalse((output / name).exists(), f"local artifact reached context: {name}")
