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

    def test_scripts_refuse_execution_outside_actions(self):
        for script in SCRIPTS:
            with self.subTest(script=script.name):
                self.assertNotEqual(self.run_script(script).returncode, 0)

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
