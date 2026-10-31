import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import snapshot_dry_run as dry
import snapshot_ghcr as g
from test_snapshot_ghcr import CONFIGS, MANIFESTS, DIGESTS, sbom

SHA = 'a' * 40


class DryRunTests(unittest.TestCase):
    def test_runs_publisher_pipeline_and_verifies_its_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def build(sha, source, work, records, *, archive_factory):
                self.assertEqual((sha, source), (SHA, root))
                self.assertIs(archive_factory, dry.checked_out_archive)
                for name in g.PACKAGES:
                    (records / f'{sha}-{name}-sbom.json').write_bytes(sbom(name))
                return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
            with patch.object(dry.g, 'build_test_scan', side_effect=build), \
                 patch.object(dry, 'checked_out_archive', return_value=b'archive') as archive:
                # The helper checks HEAD before any build, then injects the same
                # checked-out-only policy into the production pipeline.
                result = dry.dry_run(SHA, root)
            archive.assert_called_once_with(root, SHA)
            self.assertEqual(result['source_sha'], SHA)
            self.assertEqual(result['images']['api']['manifest_digest'], DIGESTS['api'])
            self.assertEqual(result['images']['api']['config_digest'], CONFIGS['api'])
            self.assertEqual(result['images']['api']['sbom_sha256'], hashlib.sha256(sbom('api')).hexdigest())

    def test_wrong_sbom_or_manifest_fails_closed(self):
        for wrong in ('sbom', 'manifest'):
            with self.subTest(wrong=wrong), tempfile.TemporaryDirectory() as temp:
                def build(sha, source, work, records, *, archive_factory):
                    for name in g.PACKAGES:
                        (records / f'{sha}-{name}-sbom.json').write_bytes(sbom('web' if wrong == 'sbom' and name == 'api' else name))
                    manifests = dict(MANIFESTS)
                    if wrong == 'manifest':
                        manifests['api'] += b' '
                    return DIGESTS, {}, manifests
                with patch.object(dry.g, 'build_test_scan', side_effect=build), \
                     patch.object(dry, 'checked_out_archive', return_value=b'archive'), \
                     self.assertRaises(ValueError):
                    dry.dry_run(SHA, Path(temp))

    def test_workflow_uses_dry_run_as_admission_gate_without_package_permission(self):
        from snapshot_admission import WORKFLOWS
        ci = Path('.github/workflows/ci.yml').read_text()
        job = ci.split('  snapshot-candidate-dry-run:', 1)[1].split('\n  snapshot-safety:', 1)[0]
        self.assertIn('name: Snapshot candidate dry run', job)
        self.assertIn('persist-credentials: false', job)
        self.assertIn('python3 scripts/snapshot_dry_run.py', job)
        self.assertNotIn('packages:', job)
        self.assertNotIn('secrets.', job)
        self.assertIn('Snapshot candidate dry run', WORKFLOWS['CI'][1])
        runs, jobs = __import__('test_snapshot_admission').fixture()
        jobs[(101, 1)] = [entry for entry in jobs[(101, 1)] if entry['name'] != 'Snapshot candidate dry run']
        self.assertEqual(__import__('snapshot_admission').assess([SHA], runs, jobs)[0]['state'], 'blocked')

    def test_loaded_digest_mismatch_aborts_before_scan_or_compose(self):
        with tempfile.TemporaryDirectory() as temp:
            work, records = Path(temp) / 'work', Path(temp) / 'records'
            work.mkdir()
            records.mkdir()
            calls = []
            def run(command, **kwargs):
                calls.append(command)
            def output(command, **kwargs):
                if command[0] == 'skopeo':
                    return MANIFESTS['api']
                return 'sha256:' + 'f' * 64 + '\n'
            with patch.object(g, 'run', side_effect=run), \
                 patch.object(g.subprocess, 'check_output', side_effect=output), \
                 patch.object(g.subprocess, 'run') as compose, \
                 self.assertRaisesRegex(ValueError, 'loaded image differs'):
                g.build_test_scan(SHA, Path(temp), work, records,
                                  archive_factory=lambda repo, sha: b'archive')
            self.assertFalse(any(cmd[0] == 'trivy' for cmd in calls))
            compose.assert_not_called()

    def test_production_pipeline_uses_same_archive_and_local_transports(self):
        commands = []
        archive = b'exact git archive'
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp) / 'work'
            records = Path(temp) / 'records'
            work.mkdir()
            records.mkdir()
            def run(command, **kwargs):
                commands.append((command, kwargs))
                if command[0:3] == ['trivy', 'image', '--format']:
                    target = Path(command[command.index('--output') + 1])
                    name = 'api' if '-api-' in target.name else 'web'
                    target.write_bytes(sbom(name))
            def output(command, **kwargs):
                commands.append((command, kwargs))
                name = 'api' if 'api' in command[-1] else 'web'
                if command[0] == 'skopeo':
                    return MANIFESTS[name]
                if command[4] == '{{.Id}}':
                    return CONFIGS[name] + '\n'
                return SHA + '\n'
            def compose(command, **kwargs):
                commands.append((command, kwargs))
                if command[0] == 'trivy':
                    import json
                    import subprocess
                    name = 'api' if 'api' in command[-1] else 'web'
                    kwargs['stdout'].write(json.dumps({
                        'SchemaVersion': 2, 'ArtifactType': 'container_image',
                        'ArtifactName': command[-1], 'Metadata': {'ImageID': CONFIGS[name]},
                    }).encode())
                    return subprocess.CompletedProcess(command, 0)
            with patch.object(g, 'run', side_effect=run), \
                 patch.object(g.subprocess, 'check_output', side_effect=output), \
                 patch.object(g.subprocess, 'run', side_effect=compose):
                digests, archives, manifests = g.build_test_scan(
                    SHA, Path(temp), work, records, archive_factory=lambda repo, sha: archive)
            self.assertEqual(digests, DIGESTS)
            self.assertEqual(manifests, MANIFESTS)
            builds = [(cmd, kw) for cmd, kw in commands if cmd[:3] == ['docker', 'buildx', 'build']]
            self.assertEqual(len(builds), 2)
            self.assertTrue(all(kw['input'] == archive and '--provenance=false' in cmd for cmd, kw in builds))
            copies = [cmd for cmd, _ in commands if cmd[:2] == ['skopeo', 'copy']]
            self.assertEqual(len(copies), 2)
            self.assertTrue(all(cmd[-2].startswith('oci-archive:') and cmd[-1].startswith('docker-daemon:') for cmd in copies))
            scans = [cmd for cmd, _ in commands if cmd[:2] == ['trivy', 'image']]
            self.assertEqual(len(scans), 4)
            harness = [(cmd, kw) for cmd, kw in commands if cmd[:1] == ['bash']]
            self.assertEqual(len(harness), 1)
            self.assertEqual(harness[0][1]['env']['IMAGE_TEST_REVISION'], SHA)
            self.assertEqual(harness[0][1]['env']['IMAGE_TEST_API'], f'glasshouse-local-api:{SHA}')


if __name__ == '__main__':
    unittest.main()
