import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SYNTHETIC_SECRET = "synthetic-normalization-95bd21a"
CONTENTS = "\r\n".join([
    "POSTGRES_USER=synthetic", f"POSTGRES_PASSWORD={SYNTHETIC_SECRET}",
    "CLICKHOUSE_USER=synthetic", f"CLICKHOUSE_PASSWORD={SYNTHETIC_SECRET}",
    f"VALKEY_PASSWORD={SYNTHETIC_SECRET}", "UI_USERNAME=synthetic",
    f"UI_PASSWORD={SYNTHETIC_SECRET}", "GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=synthetic",
    "GEPA_ALLOWED_MODELS=openai/gpt-4o-mini", "DATABASE_URL=postgres://synthetic.invalid/db", "",
]).encode()


class EnvironmentNormalizationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="glasshouse-env-normalization-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        scripts = self.root / "infra/scripts"
        scripts.mkdir(parents=True)
        for name in ("doctor.sh", "with-local-env.sh", "normalize-env.sh"):
            shutil.copy2(ROOT / "infra/scripts" / name, scripts / name)
        self.env_file = self.root / "infra/.env"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.mode_record = self.root / "mode.json"
        # Observe the temporary file's permissions while secret bytes are written.
        tr = self.bin / "tr"
        tr.write_text(f"#!{sys.executable}\n" + '''
import json, os, signal, stat, sys
from pathlib import Path
Path(os.environ["MODE_RECORD"]).write_text(json.dumps(stat.S_IMODE(os.fstat(1).st_mode)))
sys.stdout.buffer.write(sys.stdin.buffer.read().replace(b"\\r", b""))
sys.stdout.buffer.flush()
if os.environ.get("FAIL_NORMALIZATION") == "1":
    sys.exit(17)
if os.environ.get("INTERRUPT_NORMALIZATION") == "1":
    os.kill(os.getppid(), signal.SIGTERM)
''')
        tr.chmod(0o700)
        for tool, version in (
            ("docker", "2.32.0"), ("bun", "1.3.14"),
            ("node", "v22.12.0"), ("uv", "uv 0.4.0"),
        ):
            path = self.bin / tool
            path.write_text(f"#!/bin/sh\nprintf '%s\\n' '{version}'\n")
            path.chmod(0o700)

    def run_script(self, script, **overrides):
        environment = {
            **os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
            "GLASSHOUSE_CONTAINER_NETWORK": "0",
            "MODE_RECORD": str(self.mode_record), **overrides,
        }
        command = ["bash", str(self.root / "infra/scripts" / script)]
        if script == "with-local-env.sh":
            command += ["bash", "-c", 'test -n "$POSTGRES_PASSWORD"']
        result = subprocess.run(
            command, cwd=self.root, env=environment, capture_output=True,
            preexec_fn=lambda: os.umask(0), timeout=10,
        )
        self.assertNotIn(SYNTHETIC_SECRET.encode(), result.stdout + result.stderr)
        return result

    def test_both_callers_use_private_temporary_files_and_preserve_restrictions(self):
        for script in ("doctor.sh", "with-local-env.sh"):
            for source_mode in (0o600, 0o400, 0o644):
                with self.subTest(script=script, source_mode=oct(source_mode)):
                    self.env_file.write_bytes(CONTENTS)
                    self.env_file.chmod(source_mode)
                    unrelated = self.root / "unrelated"
                    unrelated.write_text("do not overwrite")
                    predictable = self.root / "infra/.env.tmp"
                    if not predictable.exists():
                        predictable.symlink_to(unrelated)
                    result = self.run_script(script)
                    self.assertEqual(result.returncode, 0, "synthetic caller failed")
                    self.assertEqual(json.loads(self.mode_record.read_text()) & 0o077, 0)
                    self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), source_mode & 0o600)
                    self.assertEqual(self.env_file.read_bytes(), CONTENTS.replace(b"\r", b""))
                    self.assertEqual(unrelated.read_text(), "do not overwrite")
                    self.assertEqual(list(self.env_file.parent.glob(".env.normalize.*")), [])
                    # Permit preparing the next restrictive-mode fixture as a non-root user.
                    self.env_file.chmod(0o600)

    def test_errors_and_signals_remove_partial_files_and_keep_the_original(self):
        for script in ("doctor.sh", "with-local-env.sh"):
            for failure in ("FAIL_NORMALIZATION", "INTERRUPT_NORMALIZATION"):
                with self.subTest(script=script, failure=failure):
                    self.env_file.write_bytes(CONTENTS)
                    self.env_file.chmod(0o600)
                    result = self.run_script(script, **{failure: "1"})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.env_file.read_bytes(), CONTENTS)
                    self.assertEqual(list(self.env_file.parent.glob(".env.normalize.*")), [])

    def test_normalization_refuses_symlinks(self):
        target = self.root / "target.env"
        target.write_bytes(CONTENTS)
        self.env_file.symlink_to(target)
        result = self.run_script("with-local-env.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), CONTENTS)
