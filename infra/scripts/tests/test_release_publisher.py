import importlib.util
import io
import json
import unittest
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('publisher', ROOT / 'infra/scripts/release-publisher.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class Response:
    def __init__(self, value, headers=None):
        self.value = json.dumps(value).encode()
        self.headers = headers or {}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size=-1): return self.value if size == -1 else self.value[:size]


class PublisherTests(unittest.TestCase):
    def admission_fixture(self):
        from urllib.parse import urlsplit
        sha = 'a' * 40
        tag = 'refs/tags/v1.2.3'
        objects = {
            'git/ref/tags/v1.2.3': {'object': {'type': 'commit', 'sha': sha}},
            'git/ref/heads/main': {'object': {'type': 'commit', 'sha': sha}},
            f'compare/{sha}...{sha}': {'status': 'identical', 'merge_base_commit': {'sha': sha}},
        }
        checks = []
        for index, (name, (app, workflow)) in enumerate(publisher.POLICY.items(), 1):
            run, job = index * 10, index * 100
            checks.append({'id': job, 'name': name, 'head_sha': sha, 'status': 'completed',
                           'conclusion': 'success', 'app': {'id': app}, 'details_url':
                           f'https://github.com/SquashMerge/glasshouse/actions/runs/{run}/job/{job}'})
            objects[f'actions/jobs/{job}'] = {'id': job, 'run_id': run, 'name': name, 'head_sha': sha,
                'status': 'completed', 'conclusion': 'success', 'check_run_url':
                f'https://api.github.com/repos/SquashMerge/glasshouse/check-runs/{job}'}
            objects[f'actions/runs/{run}'] = {'id': run, 'workflow_id': workflow, 'event': 'push',
                'head_branch': 'main', 'head_sha': sha, 'status': 'completed', 'conclusion': 'success',
                'repository': {'full_name': publisher.REPO}, 'head_repository': {'full_name': publisher.REPO}}
        objects[f'commits/{sha}/check-runs'] = {'total_count': len(checks), 'check_runs': checks}
        def open_url(request, timeout):
            self.assertEqual(request.get_header('Authorization'), 'Bearer token')
            path = urlsplit(request.full_url).path.removeprefix('/repos/SquashMerge/glasshouse/')
            if path not in objects:
                raise HTTPError(request.full_url, 404, 'not found', {}, io.BytesIO())
            return Response(objects[path])
        return publisher.Client('token', opener=open_url), objects, sha, tag

    def test_admission_needs_no_ruleset_or_bypass_permissions(self):
        client, _, sha, tag = self.admission_fixture()
        publisher.admit(client, publisher.REPO, 'push', tag, sha, sha)

    def test_full_authenticated_admission_and_adversarial_evidence(self):
        client, objects, sha, tag = self.admission_fixture()
        def check(): publisher.admit(client, publisher.REPO, 'push', tag, sha, sha)
        check()
        scenarios = [
            ('git/ref/heads/main', {'object': {'type': 'commit', 'sha': 'b' * 40}}),
            ('git/ref/heads/main', {'object': {'type': 'tag', 'sha': sha}}),
            ('actions/runs/10', {**objects['actions/runs/10'], 'event': 'pull_request'}),
            ('actions/runs/10', {**objects['actions/runs/10'], 'head_branch': 'other'}),
            ('actions/runs/10', {**objects['actions/runs/10'], 'workflow_id': 999}),
            ('actions/runs/10', {**objects['actions/runs/10'], 'head_repository': {'full_name': 'evil/fork'}}),
            ('actions/jobs/100', {**objects['actions/jobs/100'], 'conclusion': 'failure'}),
            (f'commits/{sha}/check-runs', {'total_count': 8, 'check_runs': objects[f'commits/{sha}/check-runs']['check_runs'] * 2}),
            (f'commits/{sha}/check-runs', {'total_count': 10, 'check_runs': objects[f'commits/{sha}/check-runs']['check_runs']}),
            ('git/ref/tags/v1.2.3', {'object': {'type': 'commit', 'sha': 'b' * 40}}),
        ]
        for path, bad in scenarios:
            original = objects[path]
            objects[path] = bad
            with self.subTest(path=path), self.assertRaises(ValueError): check()
            objects[path] = original
        with self.assertRaises(ValueError):
            publisher.admit(client, publisher.REPO, 'workflow_dispatch', tag, sha, sha)
        for bad_tag in ('refs/tags/v01.2.3', 'refs/tags/v1.2.3-rc.0', 'refs/heads/v1.2.3'):
            with self.subTest(tag=bad_tag), self.assertRaises(ValueError):
                publisher.admit(client, publisher.REPO, 'push', bad_tag, sha, sha)

    def test_main_moves_after_check_evidence(self):
        from unittest.mock import patch
        client, objects, sha, tag = self.admission_fixture()
        objects[f'compare/{sha}...{"b" * 40}'] = {
            'status': 'ahead', 'merge_base_commit': {'sha': sha}}
        verify = publisher.admission.verify_check_evidence
        def move_main(*args):
            verify(*args)
            original = client.get
            def moved(path):
                if path == 'git/ref/heads/main':
                    return {'object': {'type': 'commit', 'sha': 'b' * 40}}
                return original(path)
            client.get = moved
        with patch.object(publisher.admission, 'verify_check_evidence', side_effect=move_main):
            with self.assertRaises(ValueError):
                publisher.admit(client, publisher.REPO, 'push', tag, sha, sha)

    def test_authenticated_client_paginates_and_rejects_cross_origin(self):
        calls = []
        def open_url(req, timeout):
            calls.append(req)
            if len(calls) == 1:
                return Response([1], {'Link': '<https://api.github.com/repos/SquashMerge/glasshouse/rulesets?per_page=100&page=2>; rel="next"'})
            return Response([2])
        client = publisher.Client('example', opener=open_url)
        self.assertEqual(client.pages('rulesets'), [1, 2])
        self.assertEqual(calls[0].get_header('Authorization'), 'Bearer example')
        with self.assertRaises(ValueError):
            publisher.Client('example', opener=lambda *a, **k: Response([], {'Link': '<https://evil.invalid/>; rel="next"'})).pages('rulesets')

    def test_existing_release_is_never_overwritten(self):
        class Client:
            def get(self, path): return {'id': 1}
        with self.assertRaises(ValueError):
            publisher.require_no_release(Client(), 'v1.2.3')

    def test_invalid_api_error_does_not_mean_absent(self):
        class Client:
            def get(self, path): raise HTTPError(path, 403, 'forbidden', {}, io.BytesIO(b''))
        with self.assertRaises(HTTPError):
            publisher.require_no_release(Client(), 'v1.2.3')

    def test_draft_has_explicit_prerelease_and_generated_notes(self):
        class Client:
            def __init__(self): self.posts = []
            def post(self, path, data):
                self.posts.append((path, data))
                if path == 'releases/generate-notes': return {'body': 'notes'}
                return {'id': 7, **data}
        client = Client()
        release = publisher.create_draft(client, 'v1.2.3-rc.1', 'a' * 40)
        self.assertEqual(release['id'], 7)
        self.assertIs(client.posts[-1][1]['draft'], True)
        self.assertIs(client.posts[-1][1]['prerelease'], True)
        self.assertEqual(client.posts[-1][1]['body'], 'notes')

    def test_download_hashes_bytes_and_does_not_forward_token_on_redirect(self):
        import hashlib
        seen = []
        def open_url(request, timeout):
            seen.append(request)
            if len(seen) == 1:
                raise HTTPError(request.full_url, 302, 'redirect',
                                {'Location': 'https://release-assets.githubusercontent.com/signed'}, io.BytesIO())
            return io.BytesIO(b'hello')
        client = publisher.Client('secret', opener=open_url)
        self.assertEqual(client.download_digest({'id': 9}), (5, hashlib.sha256(b'hello').hexdigest()))
        self.assertEqual(seen[0].get_header('Authorization'), 'Bearer secret')
        self.assertIsNone(seen[1].get_header('Authorization'))
        def bad_redirect(request, timeout):
            raise HTTPError(request.full_url, 302, 'redirect', {'Location': 'https://attacker.invalid/x'}, io.BytesIO())
        with self.assertRaises(ValueError): publisher.Client('secret', opener=bad_redirect).download_digest({'id': 9})

    def test_upload_streams_exact_bytes_and_refuses_http_conflict(self):
        import tempfile
        from unittest.mock import patch
        class Connection:
            def __init__(self, *args, **kwargs): self.body = b''; self.status = 201
            def putrequest(self, method, path): self.method, self.path = method, path
            def putheader(self, key, value): pass
            def endheaders(self): pass
            def send(self, block): self.body += block
            def getresponse(self):
                response = io.BytesIO(json.dumps({'name': 'asset.tar.gz', 'size': len(self.body), 'state': 'uploaded'}).encode())
                response.status = self.status
                return response
            def close(self): pass
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset.tar.gz'
            path.write_bytes(b'bytes')
            expected = publisher.digest_file(path)
            connection = Connection()
            with patch.object(publisher.http.client, 'HTTPSConnection', return_value=connection):
                publisher.Client('token').upload(7, path, expected)
                self.assertEqual(connection.body, b'bytes')
                self.assertEqual(connection.method, 'POST')
                self.assertIn('/releases/7/assets?name=asset.tar.gz', connection.path)
                connection.status = 422
                with self.assertRaises(ValueError): publisher.Client('token').upload(7, path, expected)
                path.write_bytes(b'changed')
                with self.assertRaises(ValueError): publisher.Client('token').upload(7, path, expected)

    def test_end_to_end_draft_upload_and_remote_readback_with_mock_api(self):
        import hashlib
        import os
        import tempfile
        from unittest.mock import patch
        sha = 'a' * 40
        class Client:
            def __init__(self): self.assets = {}; self.draft = None; self.uploads = 0
            def get(self, path):
                if path.startswith('releases/tags/'):
                    raise HTTPError(path, 404, 'not found', {}, io.BytesIO())
                if path == 'releases/7': return self.draft
                raise AssertionError(path)
            def post(self, path, data):
                if path == 'releases/generate-notes': return {'body': 'generated'}
                self.draft = {'id': 7, **data}
                return self.draft
            def pages(self, path):
                if path == 'releases': return []
                if path == 'releases/7/assets':
                    return [{'id': i, 'name': name, 'size': len(content), 'state': 'uploaded'}
                            for i, (name, content) in enumerate(self.assets.items(), 1)]
                raise AssertionError(path)
            def upload(self, release_id, path, expected):
                self.uploads += 1
                self.assets[path.name] = path.read_bytes()
            def download_digest(self, asset):
                content = self.assets[asset['name']]
                return len(content), hashlib.sha256(content).hexdigest()
        client = Client()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in ('glasshouse-image.tar.gz', 'glasshouse-bundle.tar.gz', 'candidate-sbom.json'):
                (directory / name).write_bytes(name.encode())
            names = ('glasshouse-image.tar.gz', 'glasshouse-bundle.tar.gz', 'candidate-sbom.json')
            (directory / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256((directory / n).read_bytes()).hexdigest()}  {n}\n' for n in names))
            environment = {'GH_TOKEN': 'token', 'GITHUB_REPOSITORY': publisher.REPO,
                           'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': 'refs/tags/v1.2.3', 'GITHUB_SHA': sha}
            with patch.dict(os.environ, environment, clear=True), patch.object(publisher, 'Client', return_value=client), \
                 patch.object(publisher, 'admit') as admit, patch('subprocess.check_output', return_value=sha + '\n'), \
                 patch('sys.argv', ['publisher', 'publish', '--asset-dir', tmp]):
                from contextlib import redirect_stdout
                with redirect_stdout(io.StringIO()):
                    publisher.main()
            self.assertEqual(client.uploads, 4)
            self.assertEqual(set(client.assets), {*names, 'SHA256SUMS'})
            self.assertTrue(client.draft['draft'])
            self.assertFalse(client.draft['prerelease'])
            self.assertEqual(admit.call_count, 7)
            (directory / 'candidate-sbom.json').write_bytes(b'tampered')
            untouched = Client()
            with patch.dict(os.environ, environment, clear=True), patch.object(publisher, 'Client', return_value=untouched), \
                 patch.object(publisher, 'admit'), patch('subprocess.check_output', return_value=sha + '\n'), \
                 patch('sys.argv', ['publisher', 'publish', '--asset-dir', tmp]):
                with self.assertRaisesRegex(ValueError, 'checksum manifest mismatch'):
                    publisher.main()
            self.assertIsNone(untouched.draft)
            self.assertEqual(untouched.uploads, 0)

    def test_readback_compares_remote_bytes_and_sizes(self):
        class Client:
            def pages(self, path): return [{'id': 3, 'name': 'bundle.tar.gz', 'size': 3, 'state': 'uploaded'}]
            def download_digest(self, asset): return (3, 'incorrect')
        with self.assertRaises(ValueError):
            publisher.verify_assets(Client(), 1, {'bundle.tar.gz': (3, 'expected')})

if __name__ == '__main__': unittest.main()
