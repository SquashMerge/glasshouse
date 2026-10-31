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

    def test_app_dockerfiles_copy_workspace_dependencies_from_deps(self):
        for app in ("api", "web"):
            with self.subTest(app=app):
                dockerfile = ROOT / "apps" / app / "Dockerfile"
                self.assertIn(
                    f"COPY --from=deps /app/apps/{app}/node_modules ./apps/{app}/node_modules",
                    dockerfile.read_text().splitlines(),
                )

    def test_publisher_fixtures_cannot_enter_build_context(self):
        self.assertTrue((ROOT / "scripts/fixtures/trivy-v0.69.3-fluentd.cdx.json").is_file())
        patterns = (ROOT / ".dockerignore").read_text().splitlines()
        self.assertIn("scripts/", patterns)
        self.assertFalse(any(line.startswith("!scripts/") for line in patterns))

    def test_production_stages_copy_only_explicit_runtime_inputs(self):
        expected = {
            "api": {
                "COPY --from=build /app/node_modules ./node_modules",
                "COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules",
                "COPY --from=build /app/package.json ./package.json",
                "COPY --from=build /app/apps/api/package.json ./apps/api/package.json",
                "COPY --from=build /app/apps/web/package.json ./apps/web/package.json",
                "COPY --from=build /app/apps/api/src ./apps/api/src",
                "COPY --from=build /app/infra/db/migrations ./infra/db/migrations",
                "COPY --from=build /app/infra/db/clickhouse ./infra/db/clickhouse",
                "COPY --from=build /app/infra/scripts/verify-pg-migration-filenames.ts ./infra/scripts/verify-pg-migration-filenames.ts",
                "COPY --from=build /app/worker/gepa_worker.py ./worker/gepa_worker.py",
                "COPY --from=build /app/worker/dev_cli_llm.py ./worker/dev_cli_llm.py",
                "COPY --from=build /app/worker/__init__.py ./worker/__init__.py",
                "COPY --from=build /app/worker/requirements.lock ./worker/requirements.lock",
            },
            "web": {
                "COPY --from=build /app/node_modules ./node_modules",
                "COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules",
                "COPY --from=build /app/package.json ./package.json",
                "COPY --from=build /app/apps/api/package.json ./apps/api/package.json",
                "COPY --from=build /app/apps/web/package.json ./apps/web/package.json",
                "COPY --from=build /app/apps/web/dist ./apps/web/dist",
                "COPY --from=build /app/apps/web/vite.config.ts ./apps/web/vite.config.ts",
            },
        }
        for app, allowed in expected.items():
            with self.subTest(app=app):
                dockerfile = (ROOT / f"apps/{app}/Dockerfile").read_text()
                production = dockerfile.split(" AS prod\n", 1)[1]
                copies = {line for line in production.splitlines() if line.startswith("COPY ")}
                self.assertEqual(copies, allowed)
                for line in copies:
                    source = line.split()[2]
                    if not source.endswith("node_modules") and not source.endswith("/dist"):
                        self.assertTrue((ROOT / source.removeprefix("/app/")).exists(), source)
        api = (ROOT / "apps/api/Dockerfile").read_text().split(" AS prod\n", 1)[1]
        self.assertIn("util-linux wget", api)
        self.assertIn("--require-hashes -r /app/worker/requirements.lock", api)
        self.assertIn("GEPA_PYTHON=/opt/gepa/bin/python", api)
        self.assertIn('bun run start', api)
        web = (ROOT / "apps/web/Dockerfile").read_text().split(" AS prod\n", 1)[1]
        self.assertIn('bun run preview', web)
        self.assertIn("wget", web)

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
            "scripts/fixtures/trivy-v0.69.3-fluentd.cdx.json",
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
