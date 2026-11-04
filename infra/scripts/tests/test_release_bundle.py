import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'infra/scripts/make-release-bundle.py'


class BundleTests(unittest.TestCase):
    def test_bundle_is_standalone_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = pathlib.Path(directory) / 'bundle'
            command = ['python3', str(SCRIPT), 'v1.2.3-rc.1', str(dest)]
            subprocess.run(command, cwd=ROOT, check=True)
            self.assertIn('GLASSHOUSE_IMAGE=glasshouse:v1.2.3-rc.1', (dest / 'production.env.example').read_text())
            for name in ('backup.sh', 'restore.sh', 'backup-restore-common.sh', 'check-clickhouse-backup.py', 'check-restore-mounts.py', 'check-isolated-target.py'):
                self.assertEqual((dest / 'infra/scripts' / name).read_bytes(), (ROOT / 'infra/scripts' / name).read_bytes())
            for name in ('compose.yaml', 'compose.otlp-grpc.yaml', 'README.md', 'infra/clickhouse/backup.xml', 'infra/valkey/valkey.conf'):
                self.assertTrue((dest / name).is_file(), name)
            sentinel = dest / 'sentinel'
            sentinel.write_text('keep')
            result = subprocess.run(command, cwd=ROOT, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_text(), 'keep')

    def test_rejects_unsafe_or_non_release_versions_without_creating_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            for version in ('latest', '1.2.3', 'v1.2.3/evil', 'v01.2.3', 'v1.2.3-rc.0', 'v1.2.3+meta'):
                dest = pathlib.Path(directory) / 'bundle'
                result = subprocess.run(['python3', str(SCRIPT), version, str(dest)], cwd=ROOT, capture_output=True)
                self.assertNotEqual(result.returncode, 0, version)
                self.assertFalse(dest.exists(), version)


if __name__ == '__main__':
    unittest.main()
