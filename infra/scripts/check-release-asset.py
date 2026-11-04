#!/usr/bin/env python3
"""Check one candidate GitHub Release asset and emit a sha256sum line."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import stat

LIMIT = 2 * 1024 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asset", type=Path)
    asset = parser.parse_args().asset
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", asset.name):
        parser.error("asset filename contains unsafe characters")
    try:
        fd = os.open(asset, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size < LIMIT:
                parser.error("asset must be a nonempty regular file smaller than 2 GiB")
            digest = hashlib.sha256()
            while block := stream.read(1024 * 1024):
                digest.update(block)
            after = os.fstat(stream.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                parser.error("asset changed while hashing")
    except OSError as error:
        parser.error(f"cannot safely open asset: {error}")
    print(f"{digest.hexdigest()}  {asset.name}")


if __name__ == "__main__":
    main()
