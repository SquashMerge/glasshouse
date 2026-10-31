#!/usr/bin/env python3
"""Registry-free hosted CI exercise of the publisher's candidate pipeline.

The checked-out HEAD policy here is NOT publisher admission or authorization.
Only local OCI archives and Docker daemon images are created; public base images,
scanner databases and disposable integration dependencies may be downloaded.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from snapshot_candidate import checked_out_archive
import snapshot_ghcr as g


def dry_run(sha, root):
    # Check before any build, and again in the factory actually used by the
    # publisher's pipeline. The archive ignores untracked/dirty checkout files.
    checked_out_archive(root, sha)
    with tempfile.TemporaryDirectory(prefix='snapshot-candidate-') as directory:
        work = Path(directory) / 'work'
        records = Path(directory) / 'records'
        work.mkdir()
        records.mkdir()
        digests, _, manifests = g.build_test_scan(
            sha, root, work, records, archive_factory=checked_out_archive)
        if set(digests) != set(g.PACKAGES) or set(manifests) != set(g.PACKAGES):
            raise ValueError('candidate pair is incomplete')
        images = {}
        for name in g.PACKAGES:
            config = g.manifest_config(base64.b64encode(manifests[name]).decode('ascii'), digests[name])
            sbom = (records / f'{sha}-{name}-sbom.json').read_bytes()
            g.validate_sbom_identity(sbom, config)
            images[name] = {'manifest_digest': digests[name], 'config_digest': config,
                            'sbom_sha256': hashlib.sha256(sbom).hexdigest()}
        return {'source_sha': sha, 'images': images, 'publication': 'none'}


def main():
    try:
        sha = os.environ['GITHUB_SHA']
        root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
        print(json.dumps(dry_run(sha, root), indent=2, sort_keys=True))
        return 0
    except (KeyError, ValueError, OSError, TypeError, g.subprocess.SubprocessError) as exc:
        print(f'candidate dry run failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
