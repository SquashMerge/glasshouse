import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = [ROOT / 'infra/scripts/test-release-upgrade.sh', ROOT / 'infra/scripts/test-release-recovery.sh']


class CandidateSafetyTests(unittest.TestCase):
    def run_script(self, script, *args, **env):
        clean = {key: value for key, value in os.environ.items()
                 if key not in ('GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_TEMP')}
        return subprocess.run(['bash', str(script), *args], cwd=ROOT,
                              env={**clean, **env}, capture_output=True, text=True)

    def test_upgrade_crosses_real_pending_migrations(self):
        script = SCRIPTS[0].read_text()
        self.assertIn('prior=ac2d0848dfc83614f1696e56ed3b90f0ef35400c', script)
        old_boot, new_boot = script.split('"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 240 api', 1)
        for name in ('90061_user_action_audit_events', '90062_audit_log_snapshots'):
            self.assertTrue((ROOT / f'infra/db/migrations/{name}.sql').is_file())
            self.assertIn(name, old_boot)
            self.assertIn(name, new_boot)
        for table in ('user_action_audit_events', 'audit_log_snapshots'):
            self.assertIn(f"to_regclass('public.{table}') IS NULL", old_boot)
            self.assertIn(f"to_regclass('public.{table}') IS NOT NULL", new_boot)
        self.assertIn('== 0', old_boot)
        self.assertIn('== 2', new_boot)

    def test_recovery_checks_real_scoped_project_and_trace(self):
        script = SCRIPTS[1].read_text()
        before, after = script.split('(cd "$bundle" && bash infra/scripts/restore.sh)', 1)
        self.assertIn('"slug":"release-recovery-project"', before)
        self.assertIn('release-recovery-project', after)
        self.assertIn('/v1/traces/', before)
        self.assertIn('release-recovery-trace', before)
        self.assertIn('release-recovery-content', before)
        self.assertIn('project_id=$project_id', before)
        self.assertIn('\ncheck_trace\n', before)
        self.assertIn('\ncheck_trace\n', after)

    def test_scripts_refuse_execution_outside_actions(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name):
                self.assertNotEqual(self.run_script(script).returncode, 0)

    def test_recovery_requires_immutable_candidate_id_before_docker(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
               'RUNNER_TEMP': '/ci-temp'}
        script = ROOT / 'infra/scripts/test-release-recovery.sh'
        for candidate in ('', 'glasshouse:v0.0.0-rc.1', 'sha256:' + 'g' * 64):
            with self.subTest(candidate=candidate):
                result = self.run_script(script, '/ci-temp/glasshouse-candidate-bundle',
                                         'release-ci-123-1', candidate, **env)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('docker:', result.stderr)
                self.assertNotIn('mktemp:', result.stderr)

    def test_scripts_reject_unrelated_project_or_bundle_before_docker(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
               'RUNNER_TEMP': '/ci-temp'}
        for script in SCRIPTS:
            for bundle, project in (('/ci-temp/wrong', 'release-ci-123-1'),
                                    ('/ci-temp/glasshouse-candidate-bundle', 'existing-project')):
                with self.subTest(script=script.name, bundle=bundle, project=project):
                    result = self.run_script(script, bundle, project, 'sha256:' + 'a' * 64, **env)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('docker:', result.stderr)


if __name__ == '__main__':
    unittest.main()
