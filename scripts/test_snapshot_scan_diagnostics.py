import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_scan_and_sbom_ignore_untrusted_configuration(self):
        from test_snapshot_ghcr import CONFIGS, MANIFESTS, sbom
        calls, config_paths = [], []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work, records = root / 'work', root / 'records'
            work.mkdir()
            records.mkdir()
            (root / '.trivyignore').write_text('aws-access-key-id\n')
            (root / 'trivy.yaml').write_text('scan:\n  skip-files: ["**/*"]\n')
            (root / 'trivy-secret.yaml').write_text('disable-rules: [aws-access-key-id]\n')
            hostile = {'TRIVY_CONFIG': str(root / 'trivy.yaml'),
                       'TRIVY_SECRET_CONFIG': str(root / 'trivy-secret.yaml'),
                       'TRIVY_IGNOREFILE': str(root / '.trivyignore'),
                       'TRIVY_SKIP_FILES': '**/*', 'TRIVY_SCANNERS': 'vuln',
                       'TRIVY_DB_REPOSITORY': 'attacker.invalid/db',
                       'TRIVY_JAVA_DB_REPOSITORY': 'attacker.invalid/java',
                       'TRIVY_USERNAME': 'untrusted', 'TRIVY_PASSWORD': 'untrusted',
                       'GH_TOKEN': 'untrusted', 'GITHUB_TOKEN': 'untrusted',
                       'DOCKER_CONFIG': str(root), 'DOCKER_AUTH_CONFIG': 'untrusted',
                       'REGISTRY_AUTH_FILE': str(root / 'auth.json'), 'OTHER_SECRET': 'untrusted',
                       'HTTPS_PROXY': 'http://proxy.invalid:8080', 'XDG_CACHE_HOME': str(root / 'cache')}
            def output(command, **kwargs):
                name = 'api' if 'api' in command[-1] else 'web'
                if command[0] == 'skopeo':
                    return MANIFESTS[name]
                return CONFIGS[name] + '\n' if command[4] == '{{.Id}}' else 'a' * 40 + '\n'
            def child(command, **kwargs):
                if command[0] != 'trivy':
                    return subprocess.CompletedProcess(command, 0)
                calls.append(command)
                env = kwargs['env']
                trivy_env = {k: v for k, v in env.items() if k.startswith('TRIVY_')}
                self.assertEqual(trivy_env, {
                    'TRIVY_DB_REPOSITORY': 'mirror.gcr.io/aquasec/trivy-db:2',
                    'TRIVY_JAVA_DB_REPOSITORY': 'mirror.gcr.io/aquasec/trivy-java-db:1',
                })
                self.assertNotIn('GH_TOKEN', env)
                self.assertNotIn('GITHUB_TOKEN', env)
                self.assertNotIn('DOCKER_AUTH_CONFIG', env)
                self.assertNotIn('REGISTRY_AUTH_FILE', env)
                self.assertNotIn('OTHER_SECRET', env)
                self.assertEqual(env['HTTPS_PROXY'], hostile['HTTPS_PROXY'])
                self.assertEqual(env['XDG_CACHE_HOME'], hostile['XDG_CACHE_HOME'])
                self.assertNotEqual(env['DOCKER_CONFIG'], str(root))
                self.assertEqual(list(Path(env['DOCKER_CONFIG']).iterdir()), [])
                self.assertLess(command.index('--config'), command.index('image'))
                for flag, expected in (('--config', '{}'), ('--secret-config', '{}'), ('--ignorefile', '')):
                    path = Path(command[command.index(flag) + 1])
                    self.assertEqual(path.read_text().strip(), expected)
                    self.assertEqual(path.stat().st_mode & 0o077, 0)
                    self.assertEqual(path.parent.stat().st_mode & 0o077, 0)
                    config_paths.append(path)
                name = 'api' if 'api' in command[-1] else 'web'
                if '--output' in command:
                    Path(command[command.index('--output') + 1]).write_bytes(sbom(name))
                else:
                    doc = json.loads(report())
                    doc['ArtifactName'] = command[-1]
                    doc['Metadata']['ImageID'] = CONFIGS[name]
                    kwargs['stdout'].write(json.dumps(doc).encode())
                    self.assertEqual(command[command.index('--scanners') + 1], 'vuln,secret')
                    self.assertEqual(command[command.index('--severity') + 1], 'HIGH,CRITICAL')
                    self.assertIn('--ignore-unfixed', command)
                return subprocess.CompletedProcess(command, 0)
            previous = Path.cwd()
            try:
                os.chdir(root)
                with patch.dict(os.environ, hostile, clear=True), \
                     patch.object(g, 'run'), patch.object(g.subprocess, 'check_output', side_effect=output), \
                     patch.object(g.subprocess, 'run', side_effect=child):
                    g.build_test_scan('a' * 40, root, work, records, archive_factory=lambda *_: b'source')
            finally:
                os.chdir(previous)
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(not path.exists() for path in config_paths))

    def test_trivy_config_cleanup_on_error(self):
        paths = []
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            with g.trivy_invocation('image', [IMAGE]) as (command, _):
                paths = [Path(command[command.index(flag) + 1])
                         for flag in ('--config', '--secret-config', '--ignorefile')]
                self.assertTrue(all(path.is_file() for path in paths))
                raise RuntimeError('fixture failure')
        self.assertTrue(all(not path.exists() for path in paths))

    @unittest.skipUnless(os.environ.get('SNAPSHOT_TEST_TRIVY'), 'optional pinned Trivy binary not supplied')
    def test_real_pinned_trivy_detects_secret_despite_hostile_defaults(self):
        binary = Path(os.environ['SNAPSHOT_TEST_TRIVY']).resolve()
        version = subprocess.run([str(binary), '--version'], capture_output=True, text=True, check=True)
        self.assertIn('Version: 0.69.3', version.stdout)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scan = root / 'fixture'
            scan.mkdir()
            # Synthetic noncredential assembled at runtime, never logged.
            (scan / 'synthetic.txt').write_text('aws_access_key_id = ' + 'AK' + 'IA' + '1234567890ABCDEF' + '\n')
            (root / '.trivyignore').write_text('aws-access-key-id\n')
            (root / 'trivy.yaml').write_text('scan:\n  skip-files: ["**/synthetic.txt"]\n')
            (root / 'trivy-secret.yaml').write_text('disable-rules: [aws-access-key-id]\n')
            hostile = {'PATH': str(binary.parent) + ':/usr/bin:/bin', 'HOME': str(root),
                       'TRIVY_CONFIG': str(root / 'trivy.yaml'),
                       'TRIVY_SECRET_CONFIG': str(root / 'trivy-secret.yaml'),
                       'TRIVY_IGNOREFILE': str(root / '.trivyignore'),
                       'TRIVY_SKIP_FILES': '**/synthetic.txt'}
            args = ['--scanners', 'secret', '--offline-scan', '--exit-code', '1',
                    '--severity', 'HIGH,CRITICAL', '--format', 'json', str(scan)]
            previous = Path.cwd()
            try:
                os.chdir(root)
                with patch.dict(os.environ, hostile, clear=True):
                    unsafe = subprocess.run([str(binary), 'fs', *args], env=hostile,
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    self.assertEqual(unsafe.returncode, 0)
                    self.assertFalse(any(r.get('Secrets') for r in json.loads(unsafe.stdout).get('Results', [])))
                    with g.trivy_invocation('fs', args) as (command, env):
                        result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            finally:
                os.chdir(previous)
            self.assertEqual(result.returncode, 1)
            findings = [(s.get('RuleID'), s.get('Severity')) for r in json.loads(result.stdout).get('Results', [])
                        for s in r.get('Secrets', [])]
            self.assertIn(('aws-access-key-id', 'CRITICAL'), findings)

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

    def test_malformed_packages_fail_closed(self):
        for packages in ('bad', {}, None, [None], ['bad']):
            with self.subTest(packages=packages):
                self.assertIn('invalid scan report', self.scan(report([{'Packages': packages}]), 0)[0])
        self.assertEqual(self.scan(report([{'Packages': []}, {'Packages': [{'ID': 'pkg@1'}]}]), 0)[0], '')

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
