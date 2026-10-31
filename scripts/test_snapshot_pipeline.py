import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import snapshot_ghcr as g
from test_snapshot_ghcr import CONFIGS, MANIFESTS, DIGESTS, sbom

SHA = 'a' * 40


class PublisherPipelineTests(unittest.TestCase):
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
                    if '--output' in command:
                        Path(command[command.index('--output') + 1]).write_bytes(sbom(name))
                    else:
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
            scans = [cmd for cmd, _ in commands if cmd[0] == 'trivy' and 'image' in cmd]
            self.assertEqual(len(scans), 4)
            harness = [(cmd, kw) for cmd, kw in commands if cmd[:1] == ['bash']]
            self.assertEqual(len(harness), 1)
            self.assertEqual(harness[0][1]['env']['IMAGE_TEST_REVISION'], SHA)
            self.assertEqual(harness[0][1]['env']['IMAGE_TEST_API'], f'glasshouse-local-api:{SHA}')


if __name__ == '__main__':
    unittest.main()
