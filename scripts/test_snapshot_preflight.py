import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

import snapshot_preflight as p

SHA = "a" * 40


def package(name):
    return {"id": 1, "name": name, "package_type": "container",
            "visibility": "private", "owner": {"login": "SquashMerge", "type": "Organization"}}


class PreflightTests(unittest.TestCase):
    def test_default_cli_is_noop_without_credentials(self):
        env = dict(os.environ, GH_TOKEN="", GITHUB_TOKEN="")
        run = subprocess.run([sys.executable, "scripts/snapshot_preflight.py"], env=env,
                             text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(run.stdout)["publication"], "disabled")

    def test_private_metadata_alone_never_proves_isolation(self):
        def api(endpoint):
            return package(endpoint.rsplit("/", 1)[-1])
        with patch.object(p, "github_get", side_effect=api), \
             patch.object(p, "admit_exact", return_value={"sha": SHA, "state": "gates-passed", "evidence": {"CI": 1}}):
            report = p.preflight(SHA)
        self.assertEqual(report["publication"], "disabled")
        self.assertEqual(report["state"], "blocked")
        self.assertIn("package-access-policy-unverified", report["blockers"])

    def test_public_or_wrong_package_rejected(self):
        for changes in ({"visibility": "public"}, {"owner": {"login": "wrong"}}, {"owner": {"login": "SquashMerge", "type": "User"}}, {"name": "other"}):
            value = package("glasshouse-api-snapshot")
            value.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                p.check_package(value, "glasshouse-api-snapshot")

    def test_unknown_package_fields_rejected(self):
        for key in ("id", "name", "visibility", "owner", "package_type"):
            value = package("glasshouse-api-snapshot")
            del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                p.check_package(value, "glasshouse-api-snapshot")

    def test_exact_sha_rejected_before_any_network(self):
        with patch.object(p, "github_get") as get, self.assertRaises(ValueError):
            p.preflight("main")
        get.assert_not_called()

    def test_registry_metadata_uses_read_only_command_without_secrets(self):
        result = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
        with patch.object(p.subprocess, "run", return_value=result) as call:
            p.github_get("orgs/SquashMerge/packages/container/glasshouse-api-snapshot")
        self.assertEqual(call.call_args.args[0], ["gh", "api", "--hostname", "github.com", "--method", "GET", "orgs/SquashMerge/packages/container/glasshouse-api-snapshot"])

    def test_package_only_mode_checks_both_even_when_source_ci_is_unavailable(self):
        with patch.object(p, "github_get", side_effect=lambda endpoint: package(endpoint.rsplit("/", 1)[-1])) as get, \
             patch.object(p, "admit_exact") as admit, \
             patch("sys.stdout", new_callable=__import__("io").StringIO) as out:
            self.assertEqual(p.main(["--packages"]), 1)
        admit.assert_not_called()
        self.assertEqual(get.call_count, 2)
        self.assertEqual(json.loads(out.getvalue())["state"], "blocked")

    def test_cli_defaults_to_noop(self):
        result = subprocess.run([sys.executable, "scripts/snapshot_preflight.py"], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {"state": "noop", "publication": "disabled"})

    def test_package_not_found_never_proves_private(self):
        failure = subprocess.CalledProcessError(1, ["gh"], stderr="404 secret-sentinel")
        with patch.object(p, "admit_exact", return_value={"sha": SHA, "state": "gates-passed", "evidence": {}}), \
             patch.object(p.subprocess, "run", side_effect=failure), \
             patch("sys.stderr", new_callable=__import__("io").StringIO) as err:
            self.assertEqual(p.main(["--check", SHA]), 2)
        self.assertNotIn("secret-sentinel", err.getvalue())
        self.assertEqual(json.loads(err.getvalue())["state"], "blocked")

    def test_cli_preflight_end_to_end_with_fake_read_only_adapters(self):
        import tempfile
        from pathlib import Path
        from test_snapshot_admission import fixture
        from snapshot_admission import WORKFLOWS, REPOSITORY
        runs, jobs = fixture()
        responses = {}
        for run in runs:
            workflow = run["path"].rsplit("/", 1)[-1]
            endpoint = f"repos/{REPOSITORY}/actions/workflows/{workflow}/runs?head_sha={SHA}&per_page=100"
            responses[endpoint + '&page=1'] = {"total_count": 1, "workflow_runs": [run]}
            endpoint = f"repos/{REPOSITORY}/actions/runs/{run['id']}/attempts/1/jobs?per_page=100"
            entries = jobs[(run["id"], 1)]
            responses[endpoint + '&page=1'] = {"total_count": len(entries), "jobs": entries}
        for name in p.PACKAGES:
            responses[f"orgs/{p.ORG}/packages/container/{name}"] = package(name)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "responses.json").write_text(json.dumps(responses))
            (root / "git").write_text("#!/bin/sh\nprintf %s\\\\n " + SHA + "\n")
            (root / "gh").write_text("#!/usr/bin/python3\nimport json, os, sys\nfrom pathlib import Path\ndata=json.loads(Path(os.environ['SIM_DIR'], 'responses.json').read_text())\nprint(json.dumps(data[sys.argv[-1]]))\n")
            for command in ("git", "gh"):
                (root / command).chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"], SIM_DIR=directory)
            run = subprocess.run([sys.executable, "scripts/snapshot_preflight.py", "--check", SHA],
                                 env=env, text=True, capture_output=True)
            self.assertEqual(run.returncode, 1, run.stderr)
            report = json.loads(run.stdout)
            self.assertEqual(report["state"], "blocked")
            self.assertEqual(report["sha"], SHA)
            self.assertEqual(len(report["packages"]), 2)
            self.assertIn("package-access-policy-unverified", report["blockers"])


if __name__ == "__main__":
    unittest.main()
