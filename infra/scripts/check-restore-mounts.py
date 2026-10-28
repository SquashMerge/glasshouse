#!/usr/bin/env python3
"""Fail closed when source and restore containers share overlapping storage."""

import json
import os
import posixpath
import sys
from typing import NoReturn


def refuse(reason: str) -> NoReturn:
    print(f"Refusing restore: {reason}.", file=sys.stderr)
    raise SystemExit(2)


def canonical_sources(mount: dict) -> tuple[str, ...] | None:
    source = mount.get("Source")
    if not source:
        return None
    if not isinstance(source, str) or not posixpath.isabs(source):
        refuse("a storage mount has an invalid source path")
    # Docker reports absolute daemon-side paths. Compare lexical normalized
    # paths even for remote contexts, and resolve local symlinked prefixes too.
    normalized = posixpath.normpath(source)
    resolved = posixpath.normpath(os.path.realpath(normalized))
    return tuple(dict.fromkeys((normalized, resolved)))


def overlaps(first: str, second: str) -> bool:
    common = posixpath.commonpath((first, second))
    return common == first or common == second


def main() -> int:
    try:
        containers = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        refuse("Docker mount inspection returned invalid JSON")
    if not isinstance(containers, list) or len(containers) != 4:
        refuse("Docker mount inspection returned an unexpected container list")

    source_mounts: list[dict] = []
    target_mounts: list[dict] = []
    for container, destination in zip(
        containers, (source_mounts, source_mounts, target_mounts, target_mounts)
    ):
        if not isinstance(container, dict):
            refuse("Docker mount inspection returned an invalid container")
        mounts = container.get("Mounts") or []
        if not isinstance(mounts, list) or any(not isinstance(mount, dict) for mount in mounts):
            refuse("Docker mount inspection returned invalid mount data")
        destination.extend(mounts)

    for source_mount in source_mounts:
        source_name = source_mount.get("Name") if source_mount.get("Type") == "volume" else None
        source_paths = canonical_sources(source_mount)
        for target_mount in target_mounts:
            target_name = target_mount.get("Name") if target_mount.get("Type") == "volume" else None
            target_paths = canonical_sources(target_mount)
            if source_name and target_name and source_name == target_name:
                return 1
            if source_paths and target_paths and any(
                overlaps(source_path, target_path)
                for source_path in source_paths
                for target_path in target_paths
            ):
                return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError:
        refuse("storage mount paths could not be compared")
