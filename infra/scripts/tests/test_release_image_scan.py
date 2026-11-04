import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('release_image_scan', ROOT / 'infra/scripts/release-image-scan.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

IMAGE = 'glasshouse:v0.0.0-rc.1'
DIGEST = 'sha256:' + 'a' * 64


def sbom(digest=DIGEST):
    return json.dumps({'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'metadata': {
        'component': {'type': 'container', 'name': IMAGE, 'properties': [
            {'name': 'aquasecurity:trivy:ImageID', 'value': digest}]}}}).encode()


class ReleaseImageScanTests(unittest.TestCase):
    def test_scans_loaded_identity_and_validates_sbom_before_exposing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sbom.json'
            def generate(command, **kwargs):
                Path(command[command.index('--output') + 1]).write_bytes(sbom())
            with patch.object(release, 'scan_image') as scan, \
                 patch.object(release.subprocess, 'run', side_effect=generate):
                release.scan(IMAGE, DIGEST, target)
            scan.assert_called_once_with(IMAGE, DIGEST)
            self.assertEqual(target.read_bytes(), sbom())

    def test_wrong_sbom_identity_never_exposes_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sbom.json'
            def generate(command, **kwargs):
                Path(command[command.index('--output') + 1]).write_bytes(sbom('sha256:' + 'b' * 64))
            with patch.object(release, 'scan_image'), \
                 patch.object(release.subprocess, 'run', side_effect=generate), \
                 self.assertRaisesRegex(ValueError, 'digest mismatch'):
                release.scan(IMAGE, DIGEST, target)
            self.assertFalse(target.exists())

    def test_existing_sbom_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'sbom.json'
            target.write_bytes(b'preserve')
            with patch.object(release, 'scan_image') as scanner, self.assertRaises(FileExistsError):
                release.scan(IMAGE, DIGEST, target)
            scanner.assert_not_called()
            self.assertEqual(target.read_bytes(), b'preserve')


if __name__ == '__main__':
    unittest.main()
