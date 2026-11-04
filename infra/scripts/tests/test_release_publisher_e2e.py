"""Offline pipeline regression: production publisher, synthetic artifacts, fake GitHub transport."""
import filecmp
import hashlib
import importlib.util
import io
import json
import os
import socket
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('publisher_e2e', ROOT / 'infra/scripts/release-publisher.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
NAMES = ('glasshouse-image.tar.gz', 'glasshouse-bundle.tar.gz', 'candidate-sbom.json')


class Response(io.BytesIO):
    def __init__(self, data, status=200):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.headers = {}
        self.status = status


class FakeGitHub:
    """Only the HTTP transport is replaced; unrecognized requests fail closed."""
    def __init__(self, sha, tag, storage):
        self.sha, self.tag, self.storage = sha, tag, storage
        self.storage.mkdir()
        self.draft, self.assets = None, {}
        self.downloads = []
        self.move_after_upload = False
        self.move_tag_after_upload = False
        self.lose_response_after = None
        self.corrupt_readback = False
        self.fail_upload_after = None
        self.existing = False
        self.requests = []
        self.objects = {
            f'git/ref/tags/{tag}': {'object': {'type': 'commit', 'sha': sha}},
            'git/ref/heads/main': {'object': {'type': 'commit', 'sha': sha}},
            f'compare/{sha}...{sha}': {'status': 'identical', 'merge_base_commit': {'sha': sha}},
        }
        checks = []
        for i, (name, (app, workflow)) in enumerate(publisher.POLICY.items(), 1):
            run, job = i * 10, i * 100
            checks.append({'id': job, 'name': name, 'head_sha': sha, 'status': 'completed',
                           'conclusion': 'success', 'app': {'id': app}, 'details_url':
                           f'https://github.com/{publisher.REPO}/actions/runs/{run}/job/{job}'})
            self.objects[f'actions/jobs/{job}'] = {'id': job, 'run_id': run, 'name': name,
                'head_sha': sha, 'status': 'completed', 'conclusion': 'success', 'check_run_url':
                f'https://api.github.com/repos/{publisher.REPO}/check-runs/{job}'}
            self.objects[f'actions/runs/{run}'] = {'id': run, 'workflow_id': workflow, 'event': 'push',
                'head_branch': 'main', 'head_sha': sha, 'status': 'completed', 'conclusion': 'success',
                'repository': {'full_name': publisher.REPO}, 'head_repository': {'full_name': publisher.REPO}}
        self.objects[f'commits/{sha}/check-runs'] = {'total_count': len(checks), 'check_runs': checks}

    def metadata(self):
        return [{'id': i, 'name': n, 'size': path.stat().st_size, 'state': 'uploaded'}
                for i, (n, path) in enumerate(self.assets.items(), 1)]

    def open(self, request, timeout):
        assert request.full_url.startswith(publisher.BASE)
        assert request.get_header('Authorization') == 'Bearer synthetic-token'
        path = urlsplit(request.full_url).path.removeprefix(f'/repos/{publisher.REPO}/')
        method = request.get_method()
        self.requests.append((method, path))
        if method == 'GET':
            if path in self.objects:
                return Response(self.objects[path])
            if path == 'releases':
                return Response([{'tag_name': self.tag, 'draft': True}] if self.existing or self.draft else [])
            if path.startswith('releases/tags/'):
                raise HTTPError(request.full_url, 404, 'not found', {}, io.BytesIO())
            if path == 'releases/7':
                return Response(self.draft)
            if path == 'releases/7/assets':
                return Response(self.metadata())
            if path.startswith('releases/assets/'):
                asset = self.metadata()[int(path.rsplit('/', 1)[1]) - 1]
                self.downloads.append(asset['name'])
                path = self.assets[asset['name']]
                if self.corrupt_readback:
                    # Only synthetic negative tests enable corruption.
                    data = path.read_bytes()
                    return Response(b'X' + data[1:])
                return path.open('rb')
        if method == 'POST':
            body = json.loads(request.data)
            if path == 'releases/generate-notes':
                return Response({'body': 'synthetic notes'})
            if path == 'releases':
                self.draft = {'id': 7, **body}
                return Response(self.draft, 201)
        raise AssertionError((method, path))

    def connection(self, host, **kwargs):
        assert host == 'uploads.github.com'
        fake = self
        class Connection:
            def __init__(self):
                self.stream = None
                self.sent = 0
                self.headers = {}
            def putrequest(self, method, target):
                assert method == 'POST'
                url = urlsplit(target)
                assert url.path == f'/repos/{publisher.REPO}/releases/7/assets'
                self.name = parse_qs(url.query)['name'][0]
                assert self.name in (*NAMES, 'SHA256SUMS')
                assert self.name not in fake.assets
                self.path = fake.storage / self.name
                self.stream = self.path.open('xb')
            def putheader(self, key, value): self.headers[key] = value
            def endheaders(self): pass
            def send(self, block):
                assert len(block) <= 1024 * 1024
                self.stream.write(block)
                self.sent += len(block)
            def getresponse(self):
                self.stream.close()
                assert self.headers['Authorization'] == 'Bearer synthetic-token'
                assert int(self.headers['Content-Length']) == self.sent
                if fake.fail_upload_after == len(fake.assets):
                    self.path.unlink()
                    return Response({'error': 'synthetic upload failure'}, 500)
                fake.assets[self.name] = self.path
                if fake.move_after_upload:
                    fake.objects['git/ref/heads/main']['object']['sha'] = 'b' * 40
                if fake.move_tag_after_upload:
                    fake.objects[f'git/ref/tags/{fake.tag}']['object']['sha'] = 'b' * 40
                if fake.lose_response_after == len(fake.assets):
                    raise ConnectionResetError('synthetic accepted upload, lost response')
                return Response({'name': self.name, 'size': self.sent, 'state': 'uploaded'}, 201)
            def close(self):
                if self.stream and not self.stream.closed:
                    self.stream.close()
        return Connection()


class PublisherPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assets = self.root / 'release-assets'
        self.assets.mkdir()
        self.sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        self.tag = 'v1.2.3-rc.1'
        self.fake = FakeGitHub(self.sha, self.tag, self.root / 'fake-github')
        self.environment = {'GH_TOKEN': 'synthetic-token', 'GITHUB_REPOSITORY': publisher.REPO,
            'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': f'refs/tags/{self.tag}', 'GITHUB_SHA': self.sha}
        self.workflow = (ROOT / '.github/workflows/release-publisher.yml').read_text()

    def prepare(self):
        bundle = self.root / 'glasshouse-candidate-bundle'
        subprocess.run([sys.executable, str(ROOT / 'infra/scripts/make-release-bundle.py'), self.tag, str(bundle)],
                       cwd=ROOT, check=True, capture_output=True)
        with tarfile.open(self.assets / NAMES[1], 'w:gz') as archive:
            archive.add(bundle, arcname=bundle.name)
        (self.assets / NAMES[0]).write_bytes(b'synthetic image archive, not a Docker image')
        (self.assets / NAMES[2]).write_bytes(b'{"synthetic":"sbom"}\n')
        sums = ''.join(f'{hashlib.sha256((self.assets / name).read_bytes()).hexdigest()}  {name}\n' for name in NAMES)
        (self.assets / 'SHA256SUMS').write_text(sums)
        self.manifest = hashlib.sha256(sums.encode()).hexdigest()

    def publish(self, mode='publish', tag=None):
        env = {'PATH': os.environ['PATH'], **self.environment}
        if tag is not None:
            env['GITHUB_REF'] = 'refs/tags/' + tag
        args = ['release-publisher.py', mode]
        if mode == 'publish': args += ['--asset-dir', str(self.assets)]
        class Opener:
            open = self.fake.open
        with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', args), \
             patch.object(publisher, 'build_opener', return_value=Opener()), \
             patch.object(publisher.http.client, 'HTTPSConnection', side_effect=self.fake.connection), \
             patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')), \
             patch.object(socket.socket, 'connect_ex', side_effect=AssertionError('network forbidden')), \
             patch.object(socket, 'getaddrinfo', side_effect=AssertionError('network forbidden')), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            publisher.main()
            return output.getvalue()

    def workflow_verify(self, step='Verify transferred artifact and repeat admission'):
        section = self.workflow.split(f'      - name: {step}\n', 1)[1]
        run = section.split('        run: |\n', 1)[1].split('      - name:', 1)[0]
        script = '\n'.join(line[10:] for line in run.splitlines() if line.strip())
        # Execute only the preflight shell checks, never an unmocked publisher.
        commands = {'Verify transferred artifact and repeat admission':
                    'python3 infra/scripts/release-publisher.py admit',
                    'Create and verify draft release':
                    'python3 infra/scripts/release-publisher.py publish --asset-dir "$RUNNER_TEMP/release-assets"'}
        command = commands[step]
        lines = script.splitlines()
        self.assertEqual(lines[-1], command)
        self.assertEqual(lines[:-1], [
            'set -euo pipefail',
            '[[ "$EXPECTED_MANIFEST" =~ ^[0-9a-f]{64}$ ]]',
            'test "$(sha256sum "$RUNNER_TEMP/release-assets/SHA256SUMS" | cut -d \' \' -f 1)" = "$EXPECTED_MANIFEST"',
            '(cd "$RUNNER_TEMP/release-assets" && sha256sum --check SHA256SUMS)',
        ])
        script = '\n'.join(lines[:-1])
        env = {'PATH': os.environ['PATH'], 'RUNNER_TEMP': str(self.root), 'EXPECTED_MANIFEST': self.manifest}
        return subprocess.run(['bash', '-c', script], cwd=ROOT, env=env, capture_output=True, text=True)

    def test_pipeline_upload_and_readback_real_publisher(self):
        self.prepare()
        self.assert_pipeline(self.assets)

    def test_candidate_archive_pipeline_with_synthetic_fixture(self):
        self.tag = 'v0.0.0-rc.1'
        self.prepare()
        source = self.root / 'synthetic-candidate'
        source.mkdir()
        for name in (*NAMES, 'SHA256SUMS'):
            shutil.move(self.assets / name, source / name)
        self.assert_candidate_pipeline(source)

    @unittest.skipUnless(os.environ.get('PUBLISHER_CANDIDATE_DIR'), 'no hosted candidate archives supplied')
    def test_hosted_candidate_archives_through_mock_publisher(self):
        # CI supplies the files created by this job, not a rebuilt fixture or a previous artifact.
        self.assert_candidate_pipeline(Path(os.environ['PUBLISHER_CANDIDATE_DIR']))

    def assert_candidate_pipeline(self, source):
        self.tag = 'v0.0.0-rc.1'
        self.environment['GITHUB_REF'] = f'refs/tags/{self.tag}'
        self.fake = FakeGitHub(self.sha, self.tag, self.root / 'candidate-fake-github')
        for name in (*NAMES, 'SHA256SUMS'):
            shutil.copyfile(source / name, self.assets / name)
        self.manifest = publisher.digest_file(source / 'SHA256SUMS')[1]
        self.assert_pipeline(source)

    def assert_pipeline(self, original):
        for step in ('Verify transferred artifact and repeat admission', 'Create and verify draft release'):
            result = self.workflow_verify(step)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        candidate = (ROOT / 'infra/scripts/test-publisher-candidate.sh').read_text()
        self.assertIn('asset="$RUNNER_TEMP/glasshouse-image.tar.gz"', candidate)
        self.assertIn('tar -czf "$RUNNER_TEMP/glasshouse-bundle.tar.gz"', candidate)
        self.assertIn('python3 infra/scripts/release-image-scan.py "$image" "$before" "$RUNNER_TEMP/candidate-sbom.json"', candidate)
        self.assertIn('sha256sum glasshouse-image.tar.gz glasshouse-bundle.tar.gz candidate-sbom.json > SHA256SUMS', candidate)
        transfer = self.workflow.split('      - name: Transfer tested archives\n', 1)[1].split('\n  publish-draft:', 1)[0]
        transferred = [line.strip().split('${{ runner.temp }}/')[1] for line in transfer.splitlines()
                       if line.strip().startswith('${{ runner.temp }}/')]
        self.assertEqual(transferred, [*NAMES, 'SHA256SUMS'])
        section = self.workflow.split('      - name: Attest exact tested archives\n', 1)[1].split('      - name:', 1)[0]
        subjects = [line.strip().split('/release-assets/')[1] for line in section.splitlines()
                    if '/release-assets/' in line]
        self.assertEqual(subjects, list(NAMES))
        with tarfile.open(self.assets / NAMES[1], 'r:gz') as archive:
            env_file = archive.extractfile('glasshouse-candidate-bundle/production.env.example')
            self.assertIsNotNone(env_file)
            self.assertIn(f'GLASSHOUSE_IMAGE=glasshouse:{self.tag}', env_file.read().decode())
        self.publish('admit')
        self.assertIn('all asset sizes and hashes read back', self.publish())
        self.assertEqual(self.fake.draft['tag_name'], self.tag)
        self.assertEqual(self.fake.draft['target_commitish'], self.sha)
        self.assertTrue(self.fake.draft['draft'])
        self.assertTrue(self.fake.draft['prerelease'])
        self.assertEqual(list(self.fake.assets), [*NAMES, 'SHA256SUMS'])
        self.assertEqual(self.fake.downloads, [*NAMES, 'SHA256SUMS'])
        for name, uploaded in self.fake.assets.items():
            self.assertTrue(filecmp.cmp(uploaded, original / name, shallow=False), name)
            self.assertTrue(filecmp.cmp(self.assets / name, original / name, shallow=False), name)

    def test_reject_bad_version_and_checksum_before_writes(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'explicit version'):
            self.publish(tag='v01.2.3')
        self.assertEqual(self.fake.requests, [])
        candidate_env = {'PATH': os.environ['PATH'], 'VERSION': 'v01.2.3', 'CANDIDATE_SHA': self.sha,
                         'RUNNER_TEMP': str(self.root), 'GITHUB_RUN_ID': '1',
                         'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_ACTIONS': 'true'}
        candidate = subprocess.run(['bash', 'infra/scripts/test-publisher-candidate.sh'],
                                   cwd=ROOT, env=candidate_env, capture_output=True, text=True)
        self.assertNotEqual(candidate.returncode, 0)
        self.assertEqual(candidate.stdout, '')
        self.assertEqual(candidate.stderr, '')
        self.assertEqual({p.name for p in self.assets.iterdir()}, {*NAMES, 'SHA256SUMS'})
        (self.assets / NAMES[1]).write_bytes(b'tampered')
        self.assertNotEqual(self.workflow_verify().returncode, 0)
        with self.assertRaisesRegex(ValueError, 'checksum manifest mismatch'):
            self.publish()
        self.assertIsNone(self.fake.draft)
        self.assertEqual(self.fake.assets, {})

    def test_changed_manifest_is_rejected_by_both_workflow_gates(self):
        self.prepare()
        (self.assets / 'SHA256SUMS').write_text('0' * 64 + '  ' + NAMES[0] + '\n')
        for step in ('Verify transferred artifact and repeat admission', 'Create and verify draft release'):
            self.assertNotEqual(self.workflow_verify(step).returncode, 0)
        self.assertIsNone(self.fake.draft)
        self.assertEqual(self.fake.assets, {})

    def test_duplicate_draft_refused_before_creation(self):
        self.prepare()
        self.fake.existing = True
        with self.assertRaisesRegex(ValueError, 'release already exists'):
            self.publish()
        self.assertIsNone(self.fake.draft)
        self.assertEqual(self.fake.assets, {})

    def test_ref_movement_after_first_upload_leaves_partial_draft(self):
        self.prepare()
        self.fake.move_after_upload = True
        with self.assertRaisesRegex(ValueError, 'current main tip'):
            self.publish()
        self.assertTrue(self.fake.draft['draft'])
        self.assertEqual(list(self.fake.assets), [NAMES[0]])
        self.assertEqual(self.fake.downloads, [])

    def test_tag_movement_after_upload_leaves_partial_draft(self):
        self.prepare()
        self.fake.move_tag_after_upload = True
        with self.assertRaisesRegex(ValueError, 'event, tag and checkout'):
            self.publish()
        self.assertTrue(self.fake.draft['draft'])
        self.assertEqual(list(self.fake.assets), [NAMES[0]])
        self.assertEqual(self.fake.downloads, [])

    def test_accepted_upload_with_lost_response_leaves_partial_draft(self):
        self.prepare()
        self.fake.lose_response_after = 1
        with self.assertRaisesRegex(ConnectionResetError, 'lost response'):
            self.publish()
        self.assertTrue(self.fake.draft['draft'])
        self.assertEqual(list(self.fake.assets), [NAMES[0]])
        self.assertTrue(filecmp.cmp(self.fake.assets[NAMES[0]], self.assets / NAMES[0], shallow=False))
        with self.assertRaisesRegex(ValueError, 'release already exists'):
            self.publish()
        self.assertEqual(list(self.fake.assets), [NAMES[0]])

    def test_failed_upload_leaves_partial_draft_and_rerun_refuses_it(self):
        self.prepare()
        self.fake.fail_upload_after = 1
        with self.assertRaisesRegex(ValueError, 'asset upload failed'):
            self.publish()
        self.assertTrue(self.fake.draft['draft'])
        self.assertEqual(list(self.fake.assets), [NAMES[0]])
        with self.assertRaisesRegex(ValueError, 'release already exists'):
            self.publish()
        self.assertEqual(list(self.fake.assets), [NAMES[0]])

    def test_remote_corruption_is_rejected(self):
        self.prepare()
        self.fake.corrupt_readback = True
        with self.assertRaisesRegex(ValueError, 'contents mismatch'):
            self.publish()
        self.assertEqual(len(self.fake.assets), 4)
        self.assertEqual(self.fake.downloads, [NAMES[0]])


if __name__ == '__main__':
    unittest.main()
