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

    def test_api_uses_a_fresh_frozen_production_dependency_stage(self):
        dockerfile = (ROOT / "apps/api/Dockerfile").read_text()
        self.assertIn("FROM base AS prod-deps\n", dockerfile)
        stage = dockerfile.split("FROM base AS prod-deps\n", 1)[1].split("\nFROM ", 1)[0]
        self.assertIn('RUN bun install --frozen-lockfile --production --filter "glasshouse" --filter "@glasshouse/api"', stage)
        self.assertNotIn("COPY --from=", stage)
        production = dockerfile.split(" AS prod\n", 1)[1]
        self.assertIn("COPY --from=prod-deps /app/node_modules ./node_modules", production)
        self.assertIn("COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules", production)
        self.assertNotIn("COPY --from=build /app/node_modules", production)

    @unittest.skipUnless(
        os.environ.get("GLASSHOUSE_TEST_PRODUCTION_INSTALL") == "1",
        "set GLASSHOUSE_TEST_PRODUCTION_INSTALL=1 to exercise the frozen install",
    )
    def test_api_frozen_production_install_has_runtime_but_no_web_dev_dependencies(self):
        stage = (ROOT / "apps/api/Dockerfile").read_text().split("FROM base AS prod-deps\n", 1)[1].split("\nFROM ", 1)[0]
        install = next(line.removeprefix("RUN ") for line in stage.splitlines() if line.startswith("RUN bun install "))
        with tempfile.TemporaryDirectory(prefix="glasshouse-prod-deps-") as directory:
            root = Path(directory)
            for name in ("package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            subprocess.run(install, cwd=root, shell=True, check=True, timeout=180)
            # Replicate the final-stage COPYs, including Bun's relative symlinks.
            runtime = root / "runtime"
            shutil.copytree(root / "node_modules", runtime / "node_modules", symlinks=True)
            shutil.copytree(root / "apps/api/node_modules", runtime / "apps/api/node_modules", symlinks=True)
            for name in ("package.json", "apps/api/package.json", "apps/web/package.json"):
                target = runtime / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            for name in ("jsdom", "undici", "source-map-js", "vite", "typescript", "@typescript+typescript-linux-x64"):
                self.assertFalse(list((runtime / "node_modules/.bun").glob(f"{name}@*")), name)
            for location in (runtime / "node_modules", runtime / "apps/api/node_modules"):
                for link in location.rglob("*"):
                    if link.is_symlink():
                        self.assertTrue(link.exists(), f"broken runtime dependency symlink: {link}")
            for cwd, packages in (
                (runtime, ("config", "dotenv", "dotenv-expand")),
                (runtime / "apps/api", ("pg", "node-pg-migrate", "@clickhouse/client", "hono", "js-yaml")),
            ):
                program = "for (const p of " + repr(list(packages)) + ") { await import(p); }"
                subprocess.run(["bun", "-e", program], cwd=cwd, check=True, timeout=60)
            shutil.copytree(ROOT / "apps/api/src", runtime / "apps/api/src")
            for name in ("migrations", "clickhouse"):
                shutil.copytree(ROOT / "infra/db" / name, runtime / "infra/db" / name)
            (runtime / "infra/scripts").mkdir(parents=True)
            shutil.copy2(ROOT / "infra/scripts/verify-pg-migration-filenames.ts", runtime / "infra/scripts")
            env = {
                "PATH": os.environ["PATH"],
                "HOME": str(root),
                "NODE_ENV": "production",
                "SUPPRESS_NO_CONFIG_WARNING": "true",
                "DATABASE_URL": "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
                "CLICKHOUSE_URL": "http://127.0.0.1:1",
            }
            subprocess.run(["bun", "build", "src/index.ts", "--target=bun", "--outdir", str(root / "dist")],
                           cwd=runtime / "apps/api", env=env, check=True, timeout=60)
            result = subprocess.run(["bun", "run", "start"], cwd=runtime / "apps/api", env=env,
                                    text=True, capture_output=True, timeout=30)
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0, "startup unexpectedly connected to a datastore")
            self.assertIn("ECONNREFUSED", output)
            self.assertNotIn("Cannot find module", output)
            self.assertNotIn("ModuleNotFound", output)

    def test_ci_exercises_the_frozen_production_install(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("GLASSHOUSE_TEST_PRODUCTION_INSTALL=1", ci)

    def test_runtime_stages_upgrade_alpine_packages(self):
        for app in ("api", "web"):
            with self.subTest(app=app):
                production = (ROOT / f"apps/{app}/Dockerfile").read_text().split(" AS prod\n", 1)[1]
                self.assertIn("apk upgrade --no-cache", production)

    def test_publisher_fixtures_cannot_enter_build_context(self):
        self.assertTrue((ROOT / "scripts/fixtures/trivy-v0.69.3-fluentd.cdx.json").is_file())
        patterns = (ROOT / ".dockerignore").read_text().splitlines()
        self.assertIn("scripts/", patterns)
        self.assertFalse(any(line.startswith("!scripts/") for line in patterns))

    def test_production_stages_copy_only_explicit_runtime_inputs(self):
        expected = {
            "api": {
                "COPY --from=prod-deps /app/node_modules ./node_modules",
                "COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules",
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
