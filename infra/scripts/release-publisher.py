#!/usr/bin/env python3
"""Fail-closed GitHub Release admission and publication primitives."""
import hashlib
import http.client
import importlib.util
import json
import os
import re
import ssl
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPO = 'SquashMerge/glasshouse'
BASE = f'https://api.github.com/repos/{REPO}/'
SHA = re.compile(r'[0-9a-f]{40}\Z')
TAG = re.compile(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.[1-9][0-9]*)?\Z')
POLICY = {'candidate': (15368, 407318799), 'e2e': (15368, 394185931),
          'Security scan': (15368, 394185931), 'Verify newly locked package ages': (15368, 394185932)}
spec = importlib.util.spec_from_file_location('release_admission', Path(__file__).with_name('release-admission.py'))
admission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admission)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, token, opener=None):
        if not isinstance(token, str) or not token or '\n' in token or '\r' in token:
            raise ValueError('missing or malformed token')
        self.token = token
        self.open = opener or build_opener(NoRedirect()).open

    def request(self, url, data=None, method='GET'):
        if not url.startswith(BASE):
            raise ValueError('unexpected GitHub API URL')
        headers = {'Authorization': f'Bearer {self.token}', 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'}
        request = Request(url, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
        with self.open(request, timeout=30) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError('oversized API response')
            return json.loads(raw), response.headers

    def get(self, path):
        return self.request(BASE + path)[0]

    def post(self, path, data):
        return self.request(BASE + path, data, 'POST')[0]

    def download_digest(self, asset):
        asset_id = asset.get('id')
        if type(asset_id) is not int or asset_id <= 0:
            raise ValueError('invalid asset id')
        req = Request(BASE + f'releases/assets/{asset_id}', headers={
            'Authorization': f'Bearer {self.token}', 'Accept': 'application/octet-stream',
            'X-GitHub-Api-Version': '2022-11-28'})
        try:
            response = self.open(req, timeout=60)
        except HTTPError as error:
            if error.code != 302:
                raise
            location = error.headers.get('Location', '')
            parts = urlsplit(location)
            if parts.scheme != 'https' or parts.hostname not in ('release-assets.githubusercontent.com', 'objects.githubusercontent.com') or parts.username or parts.password or parts.port not in (None, 443):
                raise ValueError('untrusted asset redirect') from None
            # Never forward the GitHub token to the signed download URL.
            response = self.open(Request(location), timeout=60)
        with response:
            digest, size = hashlib.sha256(), 0
            while block := response.read(1024 * 1024):
                size += len(block)
                if size >= 2 * 1024**3:
                    raise ValueError('remote asset too large')
                digest.update(block)
            return size, digest.hexdigest()

    def upload(self, release_id, path, expected):
        path = Path(path)
        if type(release_id) is not int or release_id <= 0 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', path.name):
            raise ValueError('invalid upload identity')
        size, digest = expected
        if digest_file(path) != expected:
            raise ValueError('asset changed before upload')
        connection = http.client.HTTPSConnection('uploads.github.com', timeout=120, context=ssl.create_default_context())
        try:
            target = f'/repos/{REPO}/releases/{release_id}/assets?name={quote(path.name, safe="")}'
            connection.putrequest('POST', target)
            connection.putheader('Authorization', f'Bearer {self.token}')
            connection.putheader('Accept', 'application/vnd.github+json')
            connection.putheader('X-GitHub-Api-Version', '2022-11-28')
            connection.putheader('Content-Type', 'application/octet-stream')
            connection.putheader('Content-Length', str(size))
            connection.endheaders()
            sent, actual = 0, hashlib.sha256()
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
                while block := stream.read(1024 * 1024):
                    sent += len(block)
                    if sent > size:
                        raise ValueError('asset grew during upload')
                    actual.update(block)
                    connection.send(block)
            if sent != size or actual.hexdigest() != digest:
                raise ValueError('asset changed during upload')
            response = connection.getresponse()
            body = response.read(1024 * 1024 + 1)
            if response.status != 201 or len(body) > 1024 * 1024:
                raise ValueError('asset upload failed')
            result = json.loads(body)
            if result.get('name') != path.name or result.get('size') != size or result.get('state') != 'uploaded':
                raise ValueError('asset upload response mismatch')
        finally:
            connection.close()

    def pages(self, path, key=None):
        url = BASE + path + ('&' if '?' in path else '?') + 'per_page=100'
        results, visited, total = [], set(), None
        for _ in range(100):
            if url in visited:
                raise ValueError('pagination loop')
            visited.add(url)
            data, headers = self.request(url)
            if key is not None:
                if not isinstance(data, dict) or type(data.get('total_count')) is not int or data['total_count'] < 0:
                    raise ValueError('missing list total')
                if total is not None and total != data['total_count']:
                    raise ValueError('list changed during pagination')
                total = data['total_count']
            items = data if key is None else data.get(key)
            if not isinstance(items, list):
                raise ValueError('invalid list response')
            results.extend(items)
            link = headers.get('Link', '')
            matches = re.findall(r'<([^>]+)>;\s*rel="next"', link)
            if len(matches) > 1:
                raise ValueError('ambiguous pagination')
            if not matches:
                if len(items) == 100 or (total is not None and len(results) != total):
                    raise ValueError('incomplete paginated list')
                return results
            url = matches[0]
            if not url.startswith(BASE):
                raise ValueError('untrusted pagination URL')
        raise ValueError('pagination limit exceeded')


def require_no_release(client, tag):
    # Drafts are not reliably returned by the by-tag endpoint. List all releases.
    if hasattr(client, 'pages'):
        releases = client.pages('releases')
        if any(not isinstance(item, dict) or not isinstance(item.get('tag_name'), str) or item['tag_name'] == tag for item in releases):
            raise ValueError('release already exists or list malformed')
    try:
        client.get('releases/tags/' + quote(tag, safe=''))
    except HTTPError as error:
        if error.code == 404:
            return
        raise
    raise ValueError('release already exists')


def admit(client, repository, event, ref, event_sha, checkout_sha):
    def require_current_main():
        main = client.get('git/ref/heads/main')
        obj = main.get('object') if isinstance(main, dict) else None
        if not isinstance(obj, dict) or obj.get('type') != 'commit' or obj.get('sha') != event_sha:
            raise ValueError('release commit is not the current main tip')

    require_current_main()
    admission.verify_reference_evidence(repository, event, ref, event_sha, checkout_sha, client.get)
    checks = client.pages(f'commits/{event_sha}/check-runs?filter=all', 'check_runs')
    admission.verify_check_evidence(checks, event_sha, POLICY, client.get)
    admission.verify_reference_evidence(repository, event, ref, event_sha, checkout_sha, client.get)
    require_current_main()


def digest_file(path):
    path = Path(path)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        import stat
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size < 2 * 1024**3:
            raise ValueError('invalid release asset')
        digest = hashlib.sha256()
        while block := stream.read(1024 * 1024):
            digest.update(block)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('asset changed during hashing')
        return before.st_size, digest.hexdigest()


def create_draft(client, tag, sha):
    if not TAG.fullmatch(tag) or not SHA.fullmatch(sha):
        raise ValueError('invalid tag or commit')
    notes = client.post('releases/generate-notes', {'tag_name': tag, 'target_commitish': sha})
    if not isinstance(notes, dict) or not isinstance(notes.get('body'), str):
        raise ValueError('release notes unavailable')
    payload = {'tag_name': tag, 'target_commitish': sha, 'name': tag,
               'body': notes['body'], 'draft': True, 'prerelease': '-rc.' in tag,
               'generate_release_notes': False, 'make_latest': 'false'}
    result = client.post('releases', payload)
    if not isinstance(result, dict) or type(result.get('id')) is not int or result['id'] <= 0:
        raise ValueError('invalid created release')
    return result


def verify_assets(client, release_id, expected):
    assets = client.pages(f'releases/{release_id}/assets')
    if len(assets) != len(expected) or {item.get('name') for item in assets} != set(expected):
        raise ValueError('release asset set mismatch')
    for asset in assets:
        size, digest = expected[asset['name']]
        if asset.get('state') != 'uploaded' or asset.get('size') != size:
            raise ValueError('release asset metadata mismatch')
        if client.download_digest(asset) != (size, digest):
            raise ValueError('release asset contents mismatch')


def verify_draft(client, release_id, tag):
    release = client.get(f'releases/{release_id}')
    if (not isinstance(release, dict) or release.get('id') != release_id or
        release.get('tag_name') != tag or release.get('draft') is not True or
        release.get('prerelease') is not ('-rc.' in tag)):
        raise ValueError('release metadata mismatch')


def main():
    import argparse
    import subprocess
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('admit', 'publish'))
    parser.add_argument('--asset-dir', type=Path)
    args = parser.parse_args()
    client = Client(os.environ.get('GH_TOKEN', ''))
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    event = os.environ.get('GITHUB_EVENT_NAME', '')
    ref = os.environ.get('GITHUB_REF', '')
    sha = os.environ.get('GITHUB_SHA', '')
    checkout = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if not ref.startswith('refs/tags/'):
        raise ValueError('not a tag')
    tag = ref.removeprefix('refs/tags/')
    if not TAG.fullmatch(tag):
        raise ValueError('not an explicit version tag')
    def recheck():
        admit(client, repository, event, ref, sha, checkout)
    recheck()
    if args.mode == 'admit':
        return
    if args.asset_dir is None:
        raise ValueError('asset directory required')
    names = ('glasshouse-image.tar.gz', 'glasshouse-bundle.tar.gz', 'candidate-sbom.json', 'SHA256SUMS')
    paths = [args.asset_dir / name for name in names]
    expected = {path.name: digest_file(path) for path in paths}
    sums = paths[-1].read_text()
    expected_sums = ''.join(f'{expected[name][1]}  {name}\n' for name in names[:-1])
    if sums != expected_sums:
        raise ValueError('checksum manifest mismatch')
    require_no_release(client, tag)
    recheck()
    release = create_draft(client, tag, sha)
    release_id = release['id']
    verify_draft(client, release_id, tag)
    for path in paths:
        recheck()
        verify_draft(client, release_id, tag)
        if any(asset.get('name') == path.name for asset in client.pages(f'releases/{release_id}/assets')):
            raise ValueError('asset already exists; refusing overwrite')
        client.upload(release_id, path, expected[path.name])
    recheck()
    verify_draft(client, release_id, tag)
    verify_assets(client, release_id, expected)
    print(f'Draft release {release_id}: all asset sizes and hashes read back')


if __name__ == '__main__':
    main()
