#!/usr/bin/env python3
"""Read-only verification of a private publisher record; not a signature verifier."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import snapshot_ghcr as g


def fetch_verified(sha, work):
    if not isinstance(sha, str) or not g.SHA.fullmatch(sha):
        raise ValueError('invalid source SHA')
    g.verify_private()
    g.verify_fresh_main(sha)
    record = g.existing_complete(sha, work)
    if (record is None or not g.valid_reservation(record, sha)
            or record.get('state') != 'complete' or record.get('published') != record['digests']):
        raise ValueError('pair is missing or incomplete')
    g.verify_fresh_main(sha)
    report = {'source_repository': g.REPOSITORY, 'source_sha': sha,
              'images': {name: f'ghcr.io/{package}@{record["digests"][name]}'
                         for name, package in g.PACKAGES.items()},
              'sbom_sha256': record['sbom_sha256'], 'gate_runs': record['admission'],
              'publisher_run': {'run_id': record['build_run'], 'attempt': record['build_attempt']},
              'assurance': 'private-registry-exclusive-writer-not-signed'}
    return report, record


def verify(sha, work):
    return fetch_verified(sha, work)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sha', help='full lowercase first-parent source SHA')
    parser.add_argument('--sbom-dir', type=Path, help='existing private directory for SBOM files; refuses overwrite')
    args = parser.parse_args()
    try:
        with tempfile.TemporaryDirectory(prefix='snapshot-verify-') as directory:
            report, record = fetch_verified(args.sha, Path(directory))
        if args.sbom_dir:
            if not args.sbom_dir.is_dir():
                raise ValueError('SBOM directory must exist')
            for name in g.PACKAGES:
                path = args.sbom_dir / f'{args.sha}-{name}-sbom.json'
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as output:
                    output.write(g.decode_sbom(record['sboms'][name]))
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print('snapshot verification failed closed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
