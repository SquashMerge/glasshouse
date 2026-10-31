import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import snapshot_dry_run as dry
import snapshot_ghcr as g

IMAGE = 'glasshouse-local-api:' + 'a' * 40
CONFIG = 'sha256:' + '1' * 64
SENTINEL = 'private-token-NEVER-PRINT'


def report(results=None):
    value = {'SchemaVersion': 2, 'ArtifactType': 'container_image',
             'ArtifactName': IMAGE, 'Metadata': {'ImageID': CONFIG}}
    if results is not None:
        value['Results'] = [dict({'Target': 'fixture'}, **item) for item in results]
    return json.dumps(value).encode()


class ScannerTests(unittest.TestCase):
    def scan(self, raw, code, stderr=SENTINEL):
        commands = []
        def fake(command, **kwargs):
            commands.append(command)
            kwargs['stdout'].write(raw)
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            return subprocess.CompletedProcess(command, code)
        with patch.object(g.subprocess, 'run', side_effect=fake):
            try:
                g.scan_image(IMAGE, CONFIG)
                return '', commands
            except ValueError as exc:
                return str(exc), commands

    def test_vulnerability_is_bounded_and_not_passed(self):
        item = {'VulnerabilityID': 'CVE-2026-12345', 'Severity': 'HIGH', 'Title': SENTINEL}
        message, commands = self.scan(report([{'Target': SENTINEL, 'Vulnerabilities': [item]}]), 1)
        self.assertIn('CVE-2026-12345', message)
        self.assertIn('HIGH', message)
        self.assertNotIn(SENTINEL, message)
        self.assertIn('--ignore-unfixed', commands[0])
        self.assertEqual(commands[0][commands[0].index('--severity') + 1], 'HIGH,CRITICAL')
        self.assertEqual(commands[0][commands[0].index('--exit-code') + 1], '1')
        self.assertEqual(commands[0][commands[0].index('--format') + 1], 'json')

    def test_vulnerabilities_show_all_34_and_safe_fingerprinted_details(self):
        items = [{'VulnerabilityID': f'CVE-2026-{i:04}', 'Severity': 'HIGH',
                  'PkgName': 'dependency', 'InstalledVersion': SENTINEL,
                  'FixedVersion': SENTINEL, 'Title': SENTINEL, 'Match': SENTINEL,
                  'PkgPath': SENTINEL} for i in range(34)]
        items += [dict(items[0], PkgName=SENTINEL, Severity='CRITICAL')]
        message, _ = self.scan(report([
            {'Class': 'lang-pkgs', 'Type': 'python-pkg', 'Vulnerabilities': items},
            {'Class': SENTINEL, 'Type': SENTINEL,
             'Vulnerabilities': [dict(items[0], PkgName=SENTINEL)]},
        ]), 1)
        summary = json.loads(message.removeprefix('Trivy findings: '))
        self.assertEqual(summary['vulnerability_count'], 36)
        self.assertEqual(len(summary['vulnerabilities']), 35)
        self.assertEqual({entry[0] for entry in summary['vulnerabilities']},
                         {f'CVE-2026-{i:04}' for i in range(34)})
        digest = hashlib.sha256(b'dependency').hexdigest()
        injected_digest = hashlib.sha256(SENTINEL.encode()).hexdigest()
        self.assertIn(['CVE-2026-0000', 'HIGH', 'lang-pkgs', 'python-pkg', digest],
                      summary['vulnerability_details'])
        self.assertIn(['CVE-2026-0000', 'HIGH', 'other', 'other', injected_digest],
                      summary['vulnerability_details'])
        self.assertNotIn(SENTINEL, message)
        self.assertNotIn('dependency', message)
        self.assertFalse(summary['details_truncated'])

    def test_upstream_v0693_json_report_with_gate_filter(self):
        # Apache-2.0 upstream integration/testdata/alpine-39.json.golden at v0.69.3.
        doc = json.loads((Path(__file__).parent / 'fixtures/trivy-v0.69.3-alpine-39.json').read_bytes())
        doc['ArtifactName'] = IMAGE
        doc['Metadata']['ImageID'] = CONFIG
        for entry in doc['Results']:
            entry['Vulnerabilities'] = [v for v in entry['Vulnerabilities']
                                        if v['Severity'] in ('HIGH', 'CRITICAL')
                                        and v.get('FixedVersion')]
        message, _ = self.scan(json.dumps(doc).encode(), 1)
        summary = json.loads(message.removeprefix('Trivy findings: '))
        self.assertEqual(summary['vulnerability_count'], 2)
        self.assertTrue(all(row[2:4] == ['os-pkgs', 'alpine']
                            and len(row[4]) == 64 for row in summary['vulnerability_details']))
        self.assertNotIn('libssl', message)

    def test_details_are_bounded_independently_from_unique_cves(self):
        items = [{'VulnerabilityID': 'CVE-2026-1234', 'Severity': 'HIGH',
                  'PkgName': f'package-{i}'} for i in range(200)]
        items += [{'VulnerabilityID': f'CVE-2026-{i:04}', 'Severity': 'HIGH',
                   'PkgName': None} for i in range(140)]
        message, _ = self.scan(report([{'Class': {'secret': SENTINEL}, 'Type': [SENTINEL],
                                        'Vulnerabilities': items}]), 1)
        summary = json.loads(message.removeprefix('Trivy findings: '))
        self.assertEqual(summary['vulnerability_count'], 340)
        self.assertEqual(len(summary['vulnerabilities']), 128)
        self.assertEqual(len(summary['vulnerability_details']), 128)
        self.assertTrue(summary['details_truncated'])
        self.assertTrue(all(x[2:4] == ['other', 'other'] for x in summary['vulnerability_details']))
        self.assertLess(len(message), 24000)
        self.assertNotIn(SENTINEL, message)
        self.assertNotIn('package-', message)

    def test_secret_is_bounded_and_redacts_content(self):
        item = {'RuleID': 'aws-access-key-id', 'Severity': 'CRITICAL', 'Match': SENTINEL,
                'Code': {'Lines': [{'Content': SENTINEL}]}}
        message, _ = self.scan(report([{'Target': SENTINEL, 'Secrets': [item]}]), 1)
        self.assertIn('aws-access-key-id', message)
        self.assertNotIn(SENTINEL, message)

    def test_scanner_error_never_includes_raw_stderr_or_command(self):
        message, _ = self.scan(b'', 1)
        self.assertIn('operational', message)
        self.assertNotIn(SENTINEL, message)
        self.assertNotIn(IMAGE, message)

    def test_dry_run_does_not_print_subprocess_arguments(self):
        error = subprocess.CalledProcessError(1, ['tar', SENTINEL])
        with patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKSPACE': '/tmp'}), \
             patch.object(dry, 'dry_run', side_effect=error), \
             patch('sys.stderr', new_callable=io.StringIO) as stderr:
            self.assertEqual(dry.main(), 1)
            self.assertNotIn(SENTINEL, stderr.getvalue())

    def test_clean_only_with_consistent_success_and_correct_identity(self):
        self.assertEqual(self.scan(report(), 0)[0], '')
        finding = report([{'Secrets': [{'RuleID': 'aws-access-key-id', 'Severity': 'HIGH'}]}])
        for raw, code in [(finding, 0), (report(), 1), (b'{}', 0), (b'{', 0),
                          (report([{'Secrets': 'bad'}]), 0),
                          (report([{'UnexpectedFindings': [SENTINEL]}]), 0),
                          (report().replace(b'"SchemaVersion": 2', b'"SchemaVersion": 1, "SchemaVersion": 2'), 0),
                          (report().replace(CONFIG.encode(), ('sha256:' + '2' * 64).encode()), 0)]:
            with self.subTest(raw=raw, code=code):
                self.assertNotEqual(self.scan(raw, code)[0], '')

    def test_untrusted_ids_and_large_reports_do_not_leak(self):
        items = [{'RuleID': SENTINEL, 'Severity': 'HIGH', 'Match': SENTINEL}]
        items += [{'RuleID': 'aws-access-key-id', 'Severity': 'HIGH'}] * 200
        message, _ = self.scan(report([{'Secrets': items}]), 1)
        self.assertNotIn(SENTINEL, message)
        self.assertLess(len(message), 4000)
        self.assertIn('201', message)

    def test_real_child_stderr_and_stdout_never_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            program = Path(directory) / 'trivy'
            program.write_text('#!/usr/bin/python3\nimport sys\n'
                               f'sys.stderr.write({SENTINEL!r})\n'
                               f'sys.stdout.write({SENTINEL!r})\n'
                               'sys.exit(1)\n')
            program.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory}), \
                 patch('sys.stderr', new_callable=io.StringIO) as stderr, \
                 self.assertRaises(g.ScanFailure) as failure:
                g.scan_image(IMAGE, CONFIG)
            self.assertIn('operational', str(failure.exception))
            self.assertNotIn(SENTINEL, str(failure.exception))
            self.assertNotIn(SENTINEL, stderr.getvalue())

    def test_scanner_failure_prevents_sbom_and_compose(self):
        from test_snapshot_ghcr import MANIFESTS
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, records = root / 'work', root / 'records'
            work.mkdir()
            records.mkdir()
            def output(command, **kwargs):
                if command[0] == 'skopeo':
                    return MANIFESTS['api']
                return CONFIG + '\n' if command[4] == '{{.Id}}' else 'a' * 40 + '\n'
            with patch.object(g, 'run') as run, \
                 patch.object(g.subprocess, 'check_output', side_effect=output), \
                 patch.object(g, 'scan_image', side_effect=g.ScanFailure('Trivy findings')), \
                 patch.object(g.subprocess, 'run') as compose, \
                 self.assertRaises(g.ScanFailure):
                g.build_test_scan('a' * 40, root, work, records,
                                  archive_factory=lambda *_: b'source')
            self.assertFalse(any(call.args[0][0] == 'trivy' for call in run.call_args_list))
            compose.assert_not_called()
            self.assertEqual(list(records.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
