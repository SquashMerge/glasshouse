#!/usr/bin/env python3
"""Assemble an unpublished, checkout-free deployment directory."""
import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.[1-9][0-9]*)?\Z")
SCRIPTS = (
    "backup.sh", "restore.sh", "backup-restore-common.sh",
    "check-clickhouse-backup.py", "check-restore-mounts.py", "check-isolated-target.py",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="explicit vX.Y.Z or vX.Y.Z-rc.N")
    parser.add_argument("destination", type=Path, help="new directory; never overwritten")
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error("version must be vX.Y.Z or vX.Y.Z-rc.N")
    destination = args.destination.absolute()
    # copytree exclusively creates the destination and refuses any existing path.
    shutil.copytree(ROOT / "deploy/release", destination)
    env = destination / "production.env.example"
    env.write_text(env.read_text().replace("GLASSHOUSE_IMAGE=glasshouse:v0.0.0", f"GLASSHOUSE_IMAGE=glasshouse:{args.version}", 1))
    scripts = destination / "infra/scripts"
    scripts.mkdir()
    for name in SCRIPTS:
        shutil.copy2(ROOT / "infra/scripts" / name, scripts / name)
    (destination / "docs").mkdir()
    shutil.copy2(ROOT / "docs/backup-restore.md", destination / "docs/backup-restore.md")


if __name__ == "__main__":
    main()
