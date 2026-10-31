import hashlib
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import install_snapshot_trivy as installer


class TrivyInstallTests(unittest.TestCase):
    def archive(self, binary=b'fake-trivy'):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            item = tarfile.TarInfo('trivy')
            item.size = len(binary)
            archive.addfile(item, io.BytesIO(binary))
        return data.getvalue()

    def test_both_workflows_use_the_same_pinned_installer(self):
        for workflow in ('ci.yml', 'snapshot-publish.yml'):
            text = Path('.github/workflows', workflow).read_text()
            with self.subTest(workflow=workflow):
                self.assertIn('python3 scripts/install_snapshot_trivy.py', text)
                self.assertNotIn('aquasecurity/setup-trivy@', text)
        self.assertEqual(installer.VERSION, '0.69.3')
        self.assertEqual(installer.SHA256, '1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75')

    def test_checksum_failure_does_not_install_or_modify_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path_file = root / 'github-path'
            path_file.write_text('existing\n')
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(self.archive())), \
                 patch.dict(os.environ, {'RUNNER_TEMP': tmp, 'GITHUB_PATH': str(path_file)}):
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    installer.main()
            self.assertFalse((root / 'trivy-bin' / 'trivy').exists())
            self.assertEqual(path_file.read_text(), 'existing\n')

    def test_verified_archive_rejects_symlink_binary(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            item = tarfile.TarInfo('trivy')
            item.type = tarfile.SYMTYPE
            item.linkname = '/bin/sh'
            archive.addfile(item)
        content = data.getvalue()
        with tempfile.TemporaryDirectory() as tmp:
            path_file = Path(tmp) / 'github-path'
            path_file.write_text('')
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(content)), \
                 patch.object(installer, 'SHA256', hashlib.sha256(content).hexdigest()), \
                 patch.dict(os.environ, {'RUNNER_TEMP': tmp, 'GITHUB_PATH': str(path_file)}):
                with self.assertRaisesRegex(ValueError, 'not a regular file'):
                    installer.main()
            self.assertFalse((Path(tmp) / 'trivy-bin' / 'trivy').exists())
            self.assertEqual(path_file.read_text(), '')

    def test_wrong_architecture_rejected_before_network(self):
        with patch.object(installer.platform, 'machine', return_value='aarch64'), \
             patch.object(installer.urllib.request, 'urlopen') as urlopen:
            with self.assertRaisesRegex(ValueError, 'requires Linux x86-64'):
                installer.main()
        urlopen.assert_not_called()

    def test_verified_archive_installs_executable_and_updates_path(self):
        content = self.archive()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path_file = root / 'github-path'
            path_file.write_text('')
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(content)), \
                 patch.object(installer, 'SHA256', hashlib.sha256(content).hexdigest()), \
                 patch.dict(os.environ, {'RUNNER_TEMP': tmp, 'GITHUB_PATH': str(path_file)}):
                installer.main()
            binary = root / 'trivy-bin' / 'trivy'
            self.assertEqual(binary.read_bytes(), b'fake-trivy')
            self.assertTrue(os.access(binary, os.X_OK))
            self.assertEqual(path_file.read_text(), f'{binary.parent}\n')


if __name__ == '__main__':
    unittest.main()
