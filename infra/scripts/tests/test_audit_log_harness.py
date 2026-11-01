import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
HARNESS = ROOT / "infra/scripts/test-audit-log-integration.sh"


class AuditLogHarnessTest(unittest.TestCase):
    def test_waits_for_tcp_not_temporary_socket_server(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            docker = state / "docker"
            docker.write_text(
                '''#!/usr/bin/env python3
import os
from pathlib import Path
import shlex
import subprocess
import sys

state = Path(os.environ["HARNESS_TEST_STATE"])
args = sys.argv[1:]
if args[0] == "run":
    state.joinpath("health").write_text(args[args.index("--health-cmd") + 1])
elif args[0] == "inspect":
    probe = shlex.split(state.joinpath("health").read_text())
    ok = subprocess.run(probe, stdout=subprocess.DEVNULL).returncode == 0
    print("healthy" if ok else "starting")
elif args[0] == "port":
    print("127.0.0.1:49152")
'''
            )
            docker.chmod(0o755)
            ready = state / "pg_isready"
            ready.write_text(
                '''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

# The initial postgres server listens only on its Unix socket.
if "-h" not in sys.argv:
    sys.exit(0)
host = sys.argv[sys.argv.index("-h") + 1]
assert host == "127.0.0.1", host
sys.exit(0 if Path(os.environ["HARNESS_TEST_STATE"], "tcp-ready").exists() else 1)
'''
            )
            ready.chmod(0o755)
            sleep = state / "sleep"
            sleep.write_text(
                '#!/bin/sh\ntouch "$HARNESS_TEST_STATE/tcp-ready"\n'
            )
            sleep.chmod(0o755)
            bun = state / "bun"
            bun.write_text(
                '''#!/bin/sh
if [ ! -f "$HARNESS_TEST_STATE/tcp-ready" ]; then
    printf 'audit tests started before PostgreSQL TCP readiness\\n' >&2
    exit 42
fi
printf '%s\\n' "$@" > "$HARNESS_TEST_STATE/bun-args"
'''
            )
            bun.chmod(0o755)
            result = subprocess.run(
                ["bash", str(HARNESS)],
                cwd=ROOT,
                env={
                    **os.environ,
                    "PATH": f"{state}{os.pathsep}{os.environ['PATH']}",
                    "HARNESS_TEST_STATE": str(state),
                },
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (state / "bun-args").read_text().splitlines(),
                ["--cwd", "apps/api", "test", "tests/integration/audit-log.test.ts"],
            )


if __name__ == "__main__":
    unittest.main()
