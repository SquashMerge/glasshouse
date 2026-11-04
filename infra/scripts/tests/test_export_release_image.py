import gzip
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'infra/scripts/export-release-image.py'


class ExportTests(unittest.TestCase):
    def test_streams_exact_docker_save_output_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text('#!/bin/sh\n[ "$1" = save ] && [ "$2" = glasshouse:v1.2.3 ] || exit 7\nprintf "exact docker save bytes"\n')
            docker.chmod(0o755)
            env = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'}
            asset = root / 'image.tar.gz'
            command = ['python3', str(SCRIPT), 'glasshouse:v1.2.3', str(asset)]
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(gzip.decompress(asset.read_bytes()), b'exact docker save bytes')
            before = asset.read_bytes()
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
            self.assertEqual(asset.read_bytes(), before)

    def test_failed_export_does_not_leave_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text('#!/bin/sh\nprintf partial\nexit 12\n')
            docker.chmod(0o755)
            env = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}'}
            asset = root / 'image.tar.gz'
            result = subprocess.run(['python3', str(SCRIPT), 'glasshouse:v1.2.3', str(asset)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(asset.exists())


if __name__ == '__main__':
    unittest.main()
