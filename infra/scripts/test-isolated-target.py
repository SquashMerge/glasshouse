#!/usr/bin/env python3
"""Safety tests for source-unavailable target inspection."""
import copy
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).with_name('check-isolated-target.py')
spec = importlib.util.spec_from_file_location('isolated_target', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def container(identifier, service, volume, destination):
    return {'Id': identifier, 'State': {'Running': True},
            'Config': {'Labels': {'com.docker.compose.project': 'target', 'com.docker.compose.service': service}},
            'Mounts': [{'Type': 'volume', 'Name': volume, 'Destination': destination, 'RW': True}]}


def fixture():
    pg = container('pg', 'postgres', 'pg-volume', '/var/lib/postgresql')
    ch = container('ch', 'clickhouse', 'ch-volume', '/var/lib/clickhouse')
    volumes = [{'Name': name, 'Driver': 'local', 'Options': None,
                'Mountpoint': f'/var/lib/docker/volumes/{name}/_data'}
               for name in ('pg-volume', 'ch-volume')]
    config = {'volumes': {'pg': {'name': 'pg-volume'}, 'ch': {'name': 'ch-volume'}}}
    return [pg, ch], volumes, config


class IsolationTests(unittest.TestCase):
    def check(self, containers, volumes, config):
        module.validate(containers, volumes, config, 'target', 'pg', 'ch', 'postgres', 'clickhouse')

    def test_accept_isolated_volumes(self):
        self.check(*fixture())

    def test_reject_unsafe_inspection(self):
        cases = []
        containers, volumes, config = fixture()
        containers[0]['Mounts'][0]['Type'] = 'bind'; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        volumes[0]['Driver'] = 'nfs'; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        volumes[0]['Options'] = {'device': '/dev/sdb'}; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers.append(container('other', 'other', 'pg-volume', '/data')); cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers[1]['Mounts'][0]['Name'] = 'pg-volume'; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers[0]['Config']['Labels']['com.docker.compose.project'] = 'source'; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers[0]['State']['Running'] = False; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        config['volumes']['pg']['external'] = True; cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers[1]['Mounts'].append({'Type':'bind','Source':'/tmp/foo','Destination':'/var/lib/clickhouse/data', 'RW':True}); cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        containers.append({'Id': 'other', 'Mounts': [{'Type': 'bind', 'Source': '/var/lib/docker/volumes/pg-volume', 'Destination': '/backup', 'RW': True}]}); cases.append((containers, volumes, config))
        containers, volumes, config = fixture()
        volumes[1]['Mountpoint'] = volumes[0]['Mountpoint']; cases.append((containers, volumes, config))
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                self.check(*copy.deepcopy(case))


if __name__ == '__main__':
    unittest.main()
