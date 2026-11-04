#!/usr/bin/env python3
"""Export one local image as a new compressed Docker-load-compatible asset."""
import argparse
import gzip
from pathlib import Path
import subprocess
import sys

LIMIT = 2 * 1024 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("asset", type=Path)
    args = parser.parse_args()
    if not args.image or args.image.startswith("-"):
        parser.error("an explicit image reference is required")
    try:
        output = args.asset.open("xb")
    except OSError as error:
        parser.error(f"cannot create new asset: {error}")
    process = None
    complete = False
    try:
        with output:
            process = subprocess.Popen(["docker", "save", args.image], stdout=subprocess.PIPE)
            count = 0
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                assert process.stdout is not None
                while block := process.stdout.read(1024 * 1024):
                    compressed.write(block)
                    count += len(block)
            process.stdout.close()
            if process.wait() != 0 or count == 0:
                raise RuntimeError("docker save failed or produced no data")
        if not 0 < args.asset.stat().st_size < LIMIT:
            raise RuntimeError("compressed asset must be smaller than 2 GiB")
        complete = True
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        if not complete:
            args.asset.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        sys.exit(str(error))
