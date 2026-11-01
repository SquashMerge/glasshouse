#!/usr/bin/env python3
"""Public CLI fail-closed source-loss checks with synthetic artifacts."""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESTORE = ROOT / 'infra/scripts/restore.sh'


class SourceUnavailableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.artifact = root / 'artifact'
        self.artifact.mkdir(mode=0o700)
        (self.artifact / 'postgres.dump').write_bytes(b'fixture')
        with zipfile.ZipFile(self.artifact / 'clickhouse.zip', 'w') as z:
            z.writestr('fixture', 'content')
        sums = ''.join(f'{hashlib.sha256((self.artifact / name).read_bytes()).hexdigest()}  {name}\n' for name in ('postgres.dump', 'clickhouse.zip'))
        (self.artifact / 'SHA256SUMS').write_text(sums)
        self.manifest = {'format': 'glasshouse-backup-v1', 'source_id': 'source', 'stores': ['postgresql', 'clickhouse'], 'complete': True, 'postgres_server_version': '18.6', 'clickhouse_server_version': '26.10.2.103', 'source_docker_daemon_id': 'same-daemon', 'source_compose_project': 'source'}
        for item in self.artifact.iterdir():
            item.chmod(0o600)
        self.target = root / 'target'
        self.target.mkdir()
        (self.target / 'compose.yaml').touch()
        (self.target / 'target.env').touch()
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        docker = bin_dir / 'docker'
        docker.write_text('#!/bin/sh\nif [ "$1" = info ]; then printf "same-daemon\\n"; exit 0; fi\nif [ "$1" = compose ]; then exit 0; fi\nprintf "unexpected docker command\\n" >&2; exit 9\n')
        docker.chmod(0o700)
        self.env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}', BACKUP_ARTIFACT=str(self.artifact), RESTORE_SOURCE_UNAVAILABLE='true', RESTORE_TARGET_ID='target', RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO target', RESTORE_TARGET_LIVE='false', RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP', RESTORE_TARGET_DIRECTORY=str(self.target), RESTORE_TARGET_COMPOSE_FILE=str(self.target / 'compose.yaml'), RESTORE_TARGET_ENV_FILE=str(self.target / 'target.env'), RESTORE_TARGET_COMPOSE_PROJECT='target', RESTORE_SOURCE_UNAVAILABLE_CONFIRMATION='SOURCE IS UNAVAILABLE', RESTORE_DISTINCT_HOST_CONFIRMATION='I VERIFIED DISTINCT HOST', RESTORE_DISTINCT_STORAGE_CONFIRMATION='I VERIFIED DISTINCT STORAGE')

    def run_restore(self):
        (self.artifact / 'manifest.json').write_text(json.dumps(self.manifest))
        (self.artifact / 'manifest.json').chmod(0o600)
        return subprocess.run([str(RESTORE)], env=self.env, text=True, capture_output=True)

    def test_same_daemon_rejected_before_source_lookup(self):
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source and target Docker daemon IDs must differ', result.stderr)

    def test_same_actual_daemon_rejected(self):
        actual_id = subprocess.check_output(['docker', 'info', '--format', '{{.ID}}'], text=True).strip()
        self.manifest['source_docker_daemon_id'] = actual_id
        self.env['PATH'] = os.environ['PATH']
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source and target Docker daemon IDs must differ', result.stderr)

    def test_distinct_daemon_reaches_target_service_validation(self):
        self.manifest['source_docker_daemon_id'] = 'different-daemon'
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('target services must already be running', result.stderr)

    def test_missing_independent_storage_attestation_rejected(self):
        del self.env['RESTORE_DISTINCT_STORAGE_CONFIRMATION']
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('distinct host and storage confirmations are required', result.stderr)

    def test_missing_metadata_rejected_before_source_lookup(self):
        del self.manifest['source_docker_daemon_id']
        result = self.run_restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source Docker daemon and Compose project metadata', result.stderr)


if __name__ == '__main__':
    unittest.main()
