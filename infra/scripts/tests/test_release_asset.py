import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'infra/scripts/check-release-asset.py'


class AssetTests(unittest.TestCase):
    def run_check(self, path):
        return subprocess.run(['python3', str(SCRIPT), str(path)], capture_output=True, text=True)

    def test_hashes_nonempty_regular_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'glasshouse-v1.2.3.tar.gz'
            path.write_bytes(b'candidate artifact')
            result = self.run_check(path)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n')

    def test_rejects_empty_symlink_and_github_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset.tar.gz'
            path.touch()
            self.assertNotEqual(self.run_check(path).returncode, 0)
            path.write_bytes(b'x')
            link = Path(directory) / 'link.tar.gz'
            link.symlink_to(path)
            self.assertNotEqual(self.run_check(link).returncode, 0)
            with path.open('wb') as file:
                file.truncate(2 * 1024 * 1024 * 1024)
            self.assertNotEqual(self.run_check(path).returncode, 0)

    def test_rejects_unsafe_checksum_filenames(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad\nasset'
            path.write_bytes(b'x')
            self.assertNotEqual(self.run_check(path).returncode, 0)


if __name__ == '__main__':
    unittest.main()
