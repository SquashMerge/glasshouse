import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import snapshot_ghcr

ROOT = Path(__file__).resolve().parent.parent
SHA = 'a' * 40


class ArchiveHarnessTests(unittest.TestCase):
    def run_harness(self, extra, hosted=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            script = root / 'infra/scripts/test-image-compose-integration.sh'
            script.parent.mkdir(parents=True)
            shutil.copy2(ROOT / 'infra/scripts/test-image-compose-integration.sh', script)
            shutil.copytree(ROOT / 'infra/scripts/image-integration', root / 'infra/scripts/image-integration')
            shutil.copytree(ROOT / 'deploy/snapshot', root / 'deploy/snapshot')
            shutil.copytree(ROOT / 'infra/db/migrations', root / 'infra/db/migrations')
            shutil.copytree(ROOT / 'infra/db/clickhouse', root / 'infra/db/clickhouse')
            binary = Path(tmp) / 'bin'
            binary.mkdir()
            (binary / 'git').write_text('#!/bin/sh\nexit 1\n')
            (binary / 'docker').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MARKER"\nexit 1\n')
            for p in binary.iterdir():
                p.chmod(0o755)
            marker = Path(tmp) / 'calls'
            with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'GH_TOKEN': 'synthetic'}, clear=False):
                env = snapshot_ghcr.clean_env()
            self.assertNotIn('GH_TOKEN', env)
            self.assertNotIn('GITHUB_ACTIONS', env)
            env.update(PATH=str(binary) + os.pathsep + os.environ['PATH'],
                       GITHUB_SHA='b' * 40, IMAGE_TEST_REVISION=SHA,
                       MARKER=str(marker), RUNNER_TEMP=tmp)
            if hosted:
                env['GITHUB_ACTIONS'] = 'true'
            env.pop('IMAGE_TEST_API', None)
            env.pop('IMAGE_TEST_WEB', None)
            env.update(extra)
            result = subprocess.run(['bash', str(script)], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=30)
            return result, marker.read_text() if marker.exists() else ''

    def test_publisher_archive_uses_prebuilt_images_without_building(self):
        result, calls = self.run_harness({'IMAGE_TEST_API': 'local-api:test', 'IMAGE_TEST_WEB': 'local-web:test'})
        self.assertNotIn('Cannot determine source revision', result.stderr)
        self.assertIn('image inspect', calls)
        self.assertNotIn('build ', calls)

    def test_failure_never_removes_caller_owned_images(self):
        result, calls = self.run_harness({'IMAGE_TEST_API': 'local-api:test', 'IMAGE_TEST_WEB': 'local-web:test'})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('image rm', calls)

    def test_failure_removes_generated_images(self):
        result, calls = self.run_harness({})
        self.assertNotEqual(result.returncode, 0)
        removals = [line for line in calls.splitlines() if line.startswith('image rm ')]
        self.assertEqual(len(removals), 1)
        self.assertIn('glasshouse-image-test-api:', removals[0])
        self.assertIn('glasshouse-image-test-web:', removals[0])

    def test_untrusted_archive_without_complete_image_pair_is_rejected(self):
        result, calls = self.run_harness({'IMAGE_TEST_API': 'local-api:test'})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, '')

    def test_hosted_ci_rejects_unverified_archive_even_with_image_pair(self):
        result, calls = self.run_harness({'IMAGE_TEST_API': 'local-api:test', 'IMAGE_TEST_WEB': 'local-web:test'}, hosted=True)
        self.assertIn('Cannot determine source revision', result.stderr)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
