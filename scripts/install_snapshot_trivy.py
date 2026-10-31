"""Install the checksum-pinned Trivy release used by snapshot workflows."""

import hashlib
import os
import platform
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = '0.69.3'
# Published in trivy_0.69.3_checksums.txt by Aqua Security for Linux x86-64.
SHA256 = '1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75'
URL = f'https://github.com/aquasecurity/trivy/releases/download/v{VERSION}/trivy_{VERSION}_Linux-64bit.tar.gz'


def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('snapshot Trivy installer requires Linux x86-64')
    runner_temp = Path(os.environ['RUNNER_TEMP'])
    with tempfile.TemporaryDirectory(prefix='trivy-install-', dir=runner_temp) as temp:
        temp = Path(temp)
        archive_path = temp / 'trivy.tar.gz'
        digest = hashlib.sha256()
        with urllib.request.urlopen(URL, timeout=120) as response, archive_path.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != SHA256:
            raise ValueError('Trivy release checksum mismatch')
        binary = temp / 'trivy'
        with tarfile.open(archive_path, 'r:gz') as archive:
            member = archive.getmember('trivy')
            if not member.isfile():
                raise ValueError('Trivy archive binary is not a regular file')
            source = archive.extractfile(member)
            if source is None:
                raise ValueError('Trivy archive binary missing')
            with source, binary.open('wb') as output:
                shutil.copyfileobj(source, output)
        binary.chmod(0o755)
        bin_dir = runner_temp / 'trivy-bin'
        bin_dir.mkdir(exist_ok=True)
        os.replace(binary, bin_dir / 'trivy')
        with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as github_path:
            github_path.write(f'{bin_dir}\n')
    print(f'Installed checksum-verified Trivy v{VERSION}')


if __name__ == '__main__':
    main()
