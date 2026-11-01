import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
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

    def test_web_uses_a_fresh_frozen_production_dependency_stage(self):
        dockerfile = (ROOT / "apps/web/Dockerfile").read_text()
        self.assertIn("FROM base AS prod-deps\n", dockerfile)
        stage = dockerfile.split("FROM base AS prod-deps\n", 1)[1].split("\nFROM ", 1)[0]
        self.assertIn('RUN bun install --frozen-lockfile --production --filter "glasshouse" --filter "@glasshouse/web"', stage)
        self.assertNotIn("COPY --from=", stage)
        production = dockerfile.split(" AS prod\n", 1)[1]
        self.assertIn("COPY --from=prod-deps /app/node_modules ./node_modules", production)
        self.assertIn("COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules", production)
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

    @unittest.skipUnless(
        os.environ.get("GLASSHOUSE_TEST_PRODUCTION_INSTALL") == "1",
        "set GLASSHOUSE_TEST_PRODUCTION_INSTALL=1 to exercise the frozen install",
    )
    def test_web_frozen_production_preview_contract(self):
        stage = (ROOT / "apps/web/Dockerfile").read_text().split("FROM base AS prod-deps\n", 1)[1].split("\nFROM ", 1)[0]
        install = next(line.removeprefix("RUN ") for line in stage.splitlines() if line.startswith("RUN bun install "))
        subprocess.run(["bun", "--filter", "@glasshouse/web", "build"], cwd=ROOT, check=True, timeout=180)

        release = threading.Event()

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if self.path == "/v1/events" else "text/plain")
                self.end_headers()
                self.wfile.write(b"data: live\n\n" if self.path == "/v1/events" else self.path.encode())
                self.wfile.flush()
                if self.path == "/v1/events":
                    # Keep upstream open to prove the first SSE frame is not buffered.
                    release.wait(10)

            def log_message(self, format, *args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        upstream.daemon_threads = True
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        self.addCleanup(release.set)
        with tempfile.TemporaryDirectory(prefix="glasshouse-web-prod-deps-") as directory:
            root = Path(directory)
            for name in ("package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            subprocess.run(install, cwd=root, shell=True, check=True, timeout=180)
            runtime = root / "runtime"
            for name in ("node_modules", "apps/web/node_modules"):
                shutil.copytree(root / name, runtime / name, symlinks=True)
            for name in ("package.json", "apps/api/package.json", "apps/web/package.json", "apps/web/vite.config.ts"):
                target = runtime / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            shutil.copytree(ROOT / "apps/web/dist", runtime / "apps/web/dist")
            for name in ("jsdom", "undici", "typescript", "@typescript+typescript-linux-x64"):
                self.assertFalse(list((runtime / "node_modules/.bun").glob(f"{name}@*")), name)
            source_maps = []
            for location in (runtime / "node_modules", runtime / "apps/web/node_modules"):
                for directory, _, files in os.walk(location, followlinks=False):
                    if "package.json" in files:
                        manifest = Path(directory) / "package.json"
                        package = json.loads(manifest.read_text())
                        if package.get("name") == "source-map-js":
                            source_maps.append((manifest, package.get("version")))
            self.assertTrue(source_maps, "production install must include source-map-js")
            for manifest, version in source_maps:
                self.assertEqual(version, "1.2.2", str(manifest))
            for location in (runtime / "node_modules", runtime / "apps/web/node_modules"):
                for link in location.rglob("*"):
                    if link.is_symlink():
                        self.assertTrue(link.exists(), f"broken runtime dependency symlink: {link}")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = {"PATH": os.environ["PATH"], "HOME": str(root), "NODE_ENV": "production",
                   "VITE_API_PROXY": f"http://127.0.0.1:{upstream.server_port}"}
            preview = subprocess.Popen(["bun", "run", "preview", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
                                       cwd=runtime / "apps/web", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
            try:
                deadline = time.monotonic() + 20
                while True:
                    try:
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                        connection.request("GET", "/")
                        response = connection.getresponse()
                        html = response.read()
                        break
                    except OSError:
                        if preview.poll() is not None or time.monotonic() >= deadline:
                            self.fail(f"Vite preview failed to start (exit {preview.poll()})")
                        time.sleep(0.1)
                self.assertEqual(response.status, 200)
                self.assertIn(b'<div id="root"></div>', html)
                csp = response.getheader("Content-Security-Policy", "")
                self.assertIn("default-src 'self'", csp)
                self.assertIn("frame-ancestors 'none'", csp)
                self.assertNotIn("script-src 'self' 'unsafe-inline'", csp)
                self.assertEqual(response.getheader("Cross-Origin-Opener-Policy"), "same-origin")
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                connection.close()
                for path in ("/projects/deep-link", "/v1/health", "/health", "/openapi.json", "/reference"):
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                    connection.request("GET", path, headers={"Accept": "text/html"})
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, 200, path)
                    self.assertIn(b'<div id="root"></div>' if path.startswith("/projects/") else path.encode(), body)
                    connection.close()
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                connection.request("GET", "/v1/events")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("cache-control"), "no-cache")
                self.assertEqual(response.getheader("x-accel-buffering"), "no")
                self.assertEqual(response.readline(), b"data: live\n")
                self.assertFalse(release.is_set())
                connection.close()
                subprocess.run(["wget", "--spider", "--quiet", f"http://127.0.0.1:{port}/"], check=True, timeout=10, env=env)
            finally:
                try:
                    os.killpg(preview.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    preview.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(preview.pid, signal.SIGKILL)
                    preview.wait()

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
                "COPY --from=prod-deps /app/node_modules ./node_modules",
                "COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules",
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
        self.assertIn("USER bun", web.splitlines())
        self.assertIn("RUN chown -R bun:bun /app", web.splitlines())

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
