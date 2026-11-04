#!/usr/bin/env python3
"""Scan a loaded release candidate and emit an identity-checked CycloneDX SBOM."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from snapshot_ghcr import scan_image, trivy_invocation, validate_sbom_identity

MAX_SBOM_BYTES = 32 * 1024 * 1024


def scan(image, config_digest, destination):
    if not image or image.startswith('-') or not re.fullmatch(r'sha256:[0-9a-f]{64}', config_digest):
        raise ValueError('invalid candidate image or image config digest')
    if os.path.lexists(destination):
        raise FileExistsError('SBOM destination already exists')
    scan_image(image, config_digest)
    with tempfile.TemporaryDirectory(prefix='release-sbom-', dir=destination.parent) as directory:
        temporary = Path(directory) / 'sbom.json'
        with trivy_invocation('image', ['--format', 'cyclonedx', '--output', str(temporary), image]) as (command, env):
            subprocess.run(command, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with temporary.open('rb') as source:
            content = source.read(MAX_SBOM_BYTES + 1)
        if len(content) > MAX_SBOM_BYTES:
            raise ValueError('SBOM exceeds size limit')
        validate_sbom_identity(content, config_digest)
        with destination.open('xb') as output:
            try:
                output.write(content)
            except BaseException:
                destination.unlink(missing_ok=True)
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image')
    parser.add_argument('config_digest')
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    scan(args.image, args.config_digest, args.destination)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        sys.exit('Release candidate image scan or SBOM validation failed')
