#!/usr/bin/env python3
"""Fail closed on unsafe Docker recovery target inspection."""
import json
import os
import posixpath
import subprocess
import sys


def validate(containers, volumes, config, project, pg_id, ch_id, pg_service, ch_service):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(pg_id and ch_id and pg_id != ch_id, 'target containers must be distinct')
    require(isinstance(containers, list) and all(isinstance(c, dict) for c in containers), 'invalid container inventory')
    by_id = {c.get('Id'): c for c in containers}
    require(len(by_id) == len(containers) and pg_id in by_id and ch_id in by_id, 'target containers absent from inventory')
    selected = []
    for identifier, service, destination in ((pg_id, pg_service, '/var/lib/postgresql'), (ch_id, ch_service, '/var/lib/clickhouse')):
        container = by_id[identifier]
        labels = (container.get('Config') or {}).get('Labels') or {}
        require(container.get('State', {}).get('Running') is True and labels.get('com.docker.compose.project') == project and labels.get('com.docker.compose.service') == service, 'target container identity or running state mismatch')
        mounts = container.get('Mounts')
        require(isinstance(mounts, list), 'target mounts unavailable')
        matching = []
        for mount in mounts:
            require(isinstance(mount, dict) and isinstance(mount.get('Destination'), str), 'invalid target mount')
            path = posixpath.normpath(mount['Destination'])
            if posixpath.commonpath((path, destination)) in (path, destination):
                matching.append(mount)
        require(len(matching) == 1 and matching[0].get('Destination') == destination and matching[0].get('Type') == 'volume' and matching[0].get('RW') is True and matching[0].get('Name'), 'data mount must be a single dedicated writable volume')
        selected.append(matching[0]['Name'])
    require(selected[0] != selected[1], 'target volumes must be distinct')
    require(isinstance(volumes, list), 'volume inspection unavailable')
    volume_map = {volume.get('Name'): volume for volume in volumes if isinstance(volume, dict)}
    require(set(volume_map) == set(selected) and len(volume_map) == len(volumes), 'volume inspection mismatch')
    mountpoints = {}
    for name, volume in volume_map.items():
        require(volume.get('Driver') == 'local' and volume.get('Options') in (None, {}), 'volume must use local driver without options')
        path = volume.get('Mountpoint')
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ValueError('volume mountpoint unavailable')
        mountpoints[name] = os.path.realpath(path)
    def overlaps(first, second):
        common = os.path.commonpath((first, second))
        return common == first or common == second
    require(not overlaps(mountpoints[selected[0]], mountpoints[selected[1]]), 'target volume mountpoints overlap')
    declared = config.get('volumes') if isinstance(config, dict) else None
    require(isinstance(declared, dict), 'Compose volume declarations unavailable')
    for name in selected:
        declarations = [v for v in declared.values() if isinstance(v, dict) and v.get('name') == name]
        require(len(declarations) == 1 and not declarations[0].get('external', False), 'data volume must be declared non-external')
    for container in containers:
        mounts = container.get('Mounts')
        require(isinstance(mounts, list), 'container mounts unavailable')
        for mount in mounts:
            require(isinstance(mount, dict), 'invalid container mount')
            if mount.get('Type') == 'volume' and mount.get('Name') in selected:
                require(container.get('Id') == (pg_id if mount['Name'] == selected[0] else ch_id), 'data volume attached to another container')
                continue
            if mount.get('Type') in ('bind', 'volume'):
                source = mount.get('Source')
                require(isinstance(source, str) and os.path.isabs(source), 'mount source unavailable')
                if isinstance(source, str) and os.path.isabs(source):
                    path = os.path.realpath(source)
                    require(not any(overlaps(path, data_path) for data_path in mountpoints.values()), 'another mount overlaps target data')
    return selected


def validate_data_paths(destination, paths, mountinfo):
    if not paths or any(not p.startswith('/') or posixpath.normpath(p) != p or
                        posixpath.commonpath((destination, p)) != destination for p in paths):
        raise ValueError('data path escapes dedicated volume')
    mounts = []
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 10 or '-' not in fields:
            raise ValueError('invalid mountinfo')
        # Linux mountinfo escapes whitespace and backslashes with octal codes.
        import re
        mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), fields[4])
        mounts.append(mount)
    if mounts.count(destination) != 1 or any(
        m != destination and posixpath.commonpath((destination, m)) == destination
        for m in mounts
    ):
        raise ValueError('volume mount is absent or contains nested mounts')


def clickhouse_paths(data):
    disks = data.get('disks')
    if not isinstance(data.get('path'), str) or not isinstance(disks, list) or not disks:
        raise ValueError('ClickHouse runtime storage configuration unavailable')
    if not any(disk.get('name') == 'default' for disk in disks if isinstance(disk, dict)):
        raise ValueError('ClickHouse default disk unavailable')
    if any(not isinstance(disk, dict) or disk.get('type') != 'Local' or
           not isinstance(disk.get('path'), str) or not disk['path'] for disk in disks):
        raise ValueError('ClickHouse requires local disks only')
    return [data['path'], *(disk['path'] for disk in disks)]


def validate_runtime_paths(identifier, destination, paths):
    # Resolve inside the very container that owns the mount, not on the host.
    resolved = []
    for path in [destination, *paths]:
        if not path.startswith('/') or '\n' in path:
            raise ValueError('invalid data path')
        canonical = docker('exec', identifier, 'sh', '-ec',
                           'test -d "$1"; realpath "$1"', 'sh', path).strip()
        if not canonical.startswith('/') or '\n' in canonical:
            raise ValueError('cannot resolve data path')
        resolved.append(canonical)
    if resolved[0] != destination:
        raise ValueError('data volume destination is a symlink')
    mountinfo = docker('exec', identifier, 'cat', '/proc/self/mountinfo')
    validate_data_paths(destination, resolved[1:], mountinfo)


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)


def main():
    if len(sys.argv) == 5 and sys.argv[1] == '--clickhouse-paths':
        with open(sys.argv[4]) as stream:
            data = json.load(stream)
        validate_runtime_paths(sys.argv[2], '/var/lib/clickhouse',
                               [*clickhouse_paths(data), sys.argv[3]])
        return
    if len(sys.argv) >= 5 and sys.argv[1] == '--runtime-paths':
        validate_runtime_paths(sys.argv[2], sys.argv[3], sys.argv[4:])
        return
    # All Docker calls use the same client environment; do not support a remote
    # daemon in this mode. The socket's ownership/host remains operator trust.
    context = os.environ.get('DOCKER_CONTEXT') or docker('context', 'show').strip()
    if os.environ.get('DOCKER_HOST'):
        endpoint = os.environ['DOCKER_HOST']
    else:
        info = json.loads(docker('context', 'inspect', context))
        endpoint = info[0]['Endpoints']['docker']['Host']
    if not endpoint.startswith('unix:///'):
        raise ValueError('a local Unix Docker endpoint is required')
    project, pg_id, ch_id, pg_service, ch_service, config_path = sys.argv[1:]
    ids = docker('ps', '-aq', '--no-trunc').split()
    if not ids:
        raise ValueError('container inventory is empty')
    containers = json.loads(docker('inspect', *ids))
    selected = []
    for identifier, destination in ((pg_id, '/var/lib/postgresql'), (ch_id, '/var/lib/clickhouse')):
        matches = [c for c in containers if c.get('Id') == identifier]
        if len(matches) != 1:
            raise ValueError('target container not found')
        selected += [m.get('Name', '') for m in matches[0].get('Mounts', []) if m.get('Destination') == destination and m.get('Type') == 'volume']
    if len(selected) != 2 or not all(selected):
        raise ValueError('target data volumes not found')
    volumes = json.loads(docker('volume', 'inspect', *selected))
    with open(config_path) as stream:
        config = json.load(stream)
    validate(containers, volumes, config, project, pg_id, ch_id, pg_service, ch_service)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, IndexError, TypeError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f'Refusing restore: isolated target inspection failed: {error}', file=sys.stderr)
        sys.exit(1)
