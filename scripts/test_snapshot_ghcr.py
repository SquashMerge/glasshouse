import json
import base64
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import snapshot_ghcr as g

SHA = 'a' * 40
CONFIGS = {'api': 'sha256:' + '1' * 64, 'web': 'sha256:' + '2' * 64}
MANIFESTS = {name: json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                              'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                                         'digest': config, 'size': 123}, 'layers': []}).encode()
             for name, config in CONFIGS.items()}
DIGESTS = {name: 'sha256:' + hashlib.sha256(raw).hexdigest() for name, raw in MANIFESTS.items()}
EVIDENCE = {'CI': {'run_id': 1, 'attempt': 1},
            'Dependency release age': {'run_id': 2, 'attempt': 1}}


def sbom(name, serial='urn:uuid:2be5773d-7cd3-4b4b-90a5-e165474ddace'):
    # Trivy v0.69.3 CycloneDX root container, as documented in its SBOM guide.
    return json.dumps({'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
                       'serialNumber': serial, 'metadata': {'timestamp': '2026-01-01T00:00:00Z',
                       'component': {'type': 'container', 'name': f'glasshouse-local-{name}:tag',
                                     'properties': [{'name': 'aquasecurity:trivy:ImageID',
                                                     'value': CONFIGS[name]}]}}}).encode()


SBOM_FIELDS = {'sbom_sha256': {name: hashlib.sha256(sbom(name)).hexdigest() for name in g.PACKAGES},
               'sboms': {name: g.encode_sbom(sbom(name)) for name in g.PACKAGES},
               'manifests': {name: base64.b64encode(raw).decode() for name, raw in MANIFESTS.items()}}


def malformed_evidence_records():
    record = {'sha': SHA, 'state': 'complete', 'published': DIGESTS, 'platform': 'linux/amd64',
              'digests': DIGESTS, 'repository': g.REPOSITORY, 'packages': g.PACKAGES,
              'build_run': '10', 'build_attempt': '1', 'admission': EVIDENCE, **SBOM_FIELDS,
              'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
    for field, value in [('specVersion', None), ('specVersion', 'banana'), ('specVersion', 1.6),
                         ('version', True), ('name', None), ('name', ''), ('name', [])]:
        bom = json.loads(sbom('api'))
        target = bom['metadata']['component'] if field == 'name' else bom
        if value is None:
            del target[field]
        else:
            target[field] = value
        raw = json.dumps(bom).encode()
        yield f'sbom-{field}-{value}', dict(record, sboms=dict(record['sboms'], api=g.encode_sbom(raw)),
            sbom_sha256=dict(record['sbom_sha256'], api=hashlib.sha256(raw).hexdigest()))
    for field, value in [('layers', None), ('layers', {}), ('mediaType', None), ('mediaType', ''), ('size', None),
                         ('size', True), ('size', -1), ('digest', 'sha256:123'),
                         ('layer', {'mediaType': 'application/vnd.oci.image.layer.v1.tar',
                                    'size': 1, 'digest': 'sha256:123'}),
                         ('layer', {'size': 1, 'digest': 'sha256:' + '3' * 64}),
                         ('layer', {'mediaType': 'application/vnd.oci.image.layer.v1.tar',
                                    'digest': 'sha256:' + '3' * 64})]:
        manifest = json.loads(MANIFESTS['api'])
        target = manifest if field in ('layers', 'layer') else manifest['config']
        if field == 'layer':
            target['layers'] = [value]
        elif value is None:
            del target[field]
        else:
            target[field] = value
        raw = json.dumps(manifest).encode()
        digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
        digests = dict(DIGESTS, api=digest)
        yield f'manifest-{field}-{value}', dict(record, manifests=dict(record['manifests'], api=base64.b64encode(raw).decode()),
                                                 digests=digests, published=digests)


class GHCRTests(unittest.TestCase):
    def test_reservation_rejects_structurally_malformed_evidence(self):
        for label, record in malformed_evidence_records():
            with self.subTest(label=label):
                self.assertFalse(g.valid_reservation(record, SHA))

    def test_reservation_rejects_nameless_sbom_even_with_matching_checksum(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': {'CI': {'run_id': 1, 'attempt': 1},
                                'Dependency release age': {'run_id': 2, 'attempt': 1}},
                  **SBOM_FIELDS, 'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
        raw = b'{"bomFormat":"CycloneDX"}'
        record['sboms'] = {name: g.encode_sbom(raw) for name in g.PACKAGES}
        record['sbom_sha256'] = {name: hashlib.sha256(raw).hexdigest() for name in g.PACKAGES}
        self.assertFalse(g.valid_reservation(record, SHA))

    def test_partial_retry_reuses_reserved_evidence_despite_new_sbom_serials(self):
        tags, reservations, calls = {}, {}, []
        evidence = {'CI': {'run_id': 1, 'attempt': 1},
                    'Dependency release age': {'run_id': 2, 'attempt': 1}}
        def head(package, tag):
            return ('sha256:' + 'f' * 64 if reservations else None) if tag.startswith('reservation-') else tags.get(package)
        def read(*args):
            return json.loads(json.dumps(reservations['record']))
        def candidate(sha, repo, work, records):
            calls.append('build')
            for name in g.PACKAGES:
                (records / f'{sha}-{name}-sbom.json').write_bytes(sbom(name, str(len(calls))))
            return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
        def transport(command, **kwargs):
            destination = command[-1]
            if 'reservation-' in destination:
                layout = Path(command[-2][4:].rsplit(':', 1)[0])
                index = json.loads((layout / 'index.json').read_text())
                manifest = json.loads((layout / 'blobs/sha256' / index['manifests'][0]['digest'][7:]).read_text())
                config = json.loads((layout / 'blobs/sha256' / manifest['config']['digest'][7:]).read_text())
                reservations['record'] = json.loads(config['config']['Labels']['org.glasshouse.snapshot.reservation'])
            elif 'web-snapshot' in destination and 'failed' not in calls:
                calls.append('failed')
                raise OSError('interrupted')
            else:
                name = 'api' if 'api-snapshot' in destination else 'web'
                tags[g.PACKAGES[name]] = DIGESTS[name]
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), patch.object(g, 'verify_fresh_main'), patch.object(g, 'login'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': evidence}) as admit, \
             patch.object(g, 'existing_complete', return_value=None), patch.object(g, 'registry_head', side_effect=head), \
             patch.object(g, 'read_reservation', side_effect=read), patch.object(g, 'build_test_scan', side_effect=candidate), \
             patch.object(g, 'run', side_effect=transport):
            with self.assertRaises(OSError):
                g.publish_one(SHA, Path(temp), Path(temp))
            original = reservations['record']['sboms']
            result = g.publish_one(SHA, Path(temp), Path(temp))
            self.assertEqual(result['state'], 'complete')
            self.assertEqual(result['sboms'], original)
            for name in g.PACKAGES:
                self.assertEqual((Path(temp) / f'{SHA}-{name}-sbom.json').read_bytes(), g.decode_sbom(original[name]))
                self.assertNotEqual(sbom(name, '3'), g.decode_sbom(original[name]))
            self.assertEqual(calls.count('build'), 2)
            self.assertGreaterEqual(admit.call_count, 4)

    def test_identity_and_manifest_mismatches_are_rejected_even_if_sbom_hash_is_updated(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': EVIDENCE, **SBOM_FIELDS, 'pair_test': 'passed',
                  'scans': {'api': 'passed', 'web': 'passed'}}
        self.assertTrue(g.valid_reservation(record, SHA))
        base = json.loads(sbom('api'))
        for identity in (None, CONFIGS['web'], DIGESTS['api'], ''):
            with self.subTest(identity=identity):
                obj = json.loads(json.dumps(base))
                props = obj['metadata']['component']['properties']
                if identity is None:
                    props.clear()
                else:
                    props[0]['value'] = identity
                raw = json.dumps(obj).encode()
                invalid = dict(record, sboms=dict(record['sboms'], api=g.encode_sbom(raw)),
                               sbom_sha256=dict(record['sbom_sha256'], api=hashlib.sha256(raw).hexdigest()))
                self.assertFalse(g.valid_reservation(invalid, SHA))
        invalid = dict(record, manifests=dict(record['manifests'], api=record['manifests']['web']))
        self.assertFalse(g.valid_reservation(invalid, SHA))

    def test_reserve_rejects_tampered_evidence_or_changed_digest_pair(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': EVIDENCE, **SBOM_FIELDS, 'pair_test': 'passed',
                  'scans': {'api': 'passed', 'web': 'passed'}}
        variants = [dict(record, digests=dict(DIGESTS, web=DIGESTS['api'])),
                    dict(record, sboms=dict(record['sboms'], web=record['sboms']['api'])),
                    dict(record, manifests=dict(record['manifests'], web=record['manifests']['api']))]
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'registry_head', return_value=DIGESTS['api']), \
             patch.object(g, 'run') as run:
            for invalid in variants:
                with self.subTest(invalid=invalid), patch.object(g, 'read_reservation', return_value=invalid):
                    with self.assertRaisesRegex(ValueError, 'reservation'):
                        g.reserve(record, Path(temp), Path(temp) / 'auth')
            run.assert_not_called()

    def test_reserve_rejects_different_but_self_consistent_candidate(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': EVIDENCE, **SBOM_FIELDS, 'pair_test': 'passed',
                  'scans': {'api': 'passed', 'web': 'passed'}}
        raw_manifest = MANIFESTS['web'] + b' '
        changed = dict(record, digests=dict(DIGESTS, web='sha256:' + hashlib.sha256(raw_manifest).hexdigest()),
                       manifests=dict(record['manifests'], web=base64.b64encode(raw_manifest).decode()))
        self.assertTrue(g.valid_reservation(changed, SHA))
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'registry_head', return_value=DIGESTS['api']), \
             patch.object(g, 'read_reservation', return_value=record), patch.object(g, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                g.reserve(changed, Path(temp), Path(temp) / 'auth')
            run.assert_not_called()

    def test_invalid_fresh_sbom_prevents_reservation_and_app_pushes(self):
        def candidate(sha, repo, work, records):
            for name in g.PACKAGES:
                (records / f'{sha}-{name}-sbom.json').write_bytes(sbom('web'))
            return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), patch.object(g, 'verify_fresh_main'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': EVIDENCE}), \
             patch.object(g, 'existing_complete', return_value=None), patch.object(g, 'build_test_scan', side_effect=candidate), \
             patch.object(g, 'run') as run, patch.object(g, 'reserve') as reserve:
            with self.assertRaisesRegex(ValueError, 'candidate evidence'):
                g.publish_one(SHA, Path(temp), Path(temp))
            reserve.assert_not_called()
            run.assert_not_called()

    def test_real_checkpoint_transport_resumes_backlog_after_partial_failure(self):
        anchor, one, two, three = ('0' * 40, '1' * 40, '2' * 40, '3' * 40)
        history = [two, one, anchor]
        manifests = {}
        published = []
        def head(package, tag):
            return manifests.get((package, tag), (None, None, None))[0]
        def transport(command, **kwargs):
            src, dest = command[-2:]
            layout = Path(src[4:].rsplit(':', 1)[0])
            descriptor = json.loads((layout / 'index.json').read_text())['manifests'][0]
            manifest = (layout / 'blobs/sha256' / descriptor['digest'][7:]).read_bytes()
            config_digest = json.loads(manifest)['config']['digest']
            config = (layout / 'blobs/sha256' / config_digest[7:]).read_bytes()
            package, tag = dest.removeprefix('docker://ghcr.io/').rsplit(':', 1)
            manifests[(package, tag)] = (descriptor['digest'], manifest, config)
        def inspect(command, **kwargs):
            package, tag = command[-1].removeprefix('docker://ghcr.io/').rsplit(':', 1)
            entry = manifests[(package, tag)]
            return entry[2] if '--config' in command else entry[1]
        attempts = []
        def publish(sha, root, records):
            attempts.append(sha)
            if sha == one and attempts.count(one) == 1:
                raise ValueError('missing CI')
            published.append(sha)
            return {'state': 'complete', 'digests': DIGESTS}
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'GITHUB_REPOSITORY': g.REPOSITORY, 'SNAPSHOT_PUBLISH_ENABLED': 'true',
                                     'SNAPSHOT_ANCHOR': anchor, 'SNAPSHOT_RECORD_DIR': temp,
                                     'GITHUB_EVENT_NAME': 'workflow_dispatch',
                                     'SNAPSHOT_INITIALIZE_CHECKPOINT': 'true'}), \
             patch.object(g, 'verify_private'), patch.object(g, 'verify_fresh_main'), \
             patch.object(g, 'fresh_main_history', side_effect=lambda: list(history)), \
             patch.object(g, 'login'), patch.object(g, 'registry_head', side_effect=head), \
             patch.object(g, 'run', side_effect=transport), \
             patch.object(g.subprocess, 'check_output', side_effect=inspect), \
             patch.object(g, 'publish_one', side_effect=publish):
            self.assertEqual(g.main(), 0)
            os.environ['SNAPSHOT_INITIALIZE_CHECKPOINT'] = 'false'
            self.assertEqual(g.main(), 1)
            state = g.load_checkpoint(Path(temp) / 'auth')
            self.assertEqual(state['pending'], [one])
            self.assertEqual(state['cursor'], two)
            history.insert(0, three)
            self.assertEqual(g.main(), 0)
            state = g.load_checkpoint(Path(temp) / 'auth')
            self.assertEqual(state['pending'], [])
            self.assertEqual(state['cursor'], three)
            self.assertEqual(set(published), {one, two, three})
            history[:0] = [f'{n:040x}' for n in range(9, 3, -1)]
            import io
            with patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(g.main(), 0)
            self.assertIn('more', output.getvalue())

    def test_checkpoint_missing_is_not_silently_initialized(self):
        with patch.object(g, 'registry_head', return_value=None):
            with self.assertRaisesRegex(ValueError, 'checkpoint'):
                g.load_checkpoint(Path('/nonexistent'))

    def test_checkpoint_rejects_wrong_registry_identity(self):
        bad = {'kind': 'checkpoint', 'repository': 'wrong', 'packages': g.PACKAGES,
               'state': {'version': 1, 'anchor': SHA, 'cursor': SHA, 'pending': []}}
        with patch.object(g, 'registry_head', return_value=DIGESTS['api']), \
             patch.object(g, 'read_reservation', return_value=bad):
            with self.assertRaisesRegex(ValueError, 'checkpoint'):
                g.load_checkpoint(Path('/nonexistent'))

    def test_record_manifest_and_config_bytes_are_digest_verified(self):
        import hashlib
        config = json.dumps({'config': {'Labels': {'org.glasshouse.snapshot.reservation': '{}'}}},
                            separators=(',', ':')).encode()
        digest = lambda data: 'sha256:' + hashlib.sha256(data).hexdigest()
        manifest = json.dumps({'schemaVersion': 2, 'layers': [], 'config': {'digest': digest(config)}},
                              separators=(',', ':')).encode()
        with patch.object(g, 'registry_head', return_value=digest(manifest)), \
             patch.object(g.subprocess, 'check_output', side_effect=[manifest, config]):
            self.assertEqual(g.read_reservation(g.PACKAGES['api'], 'x', Path('/auth')), {})
        with patch.object(g, 'registry_head', return_value=digest(manifest)), \
             patch.object(g.subprocess, 'check_output', side_effect=[manifest, config + b' ']):
            with self.assertRaisesRegex(ValueError, 'digest'):
                g.read_reservation(g.PACKAGES['api'], 'x', Path('/auth'))
        with patch.object(g, 'registry_head', return_value=digest(manifest)), \
             patch.object(g.subprocess, 'check_output', return_value=manifest + b' '):
            with self.assertRaisesRegex(ValueError, 'digest'):
                g.read_reservation(g.PACKAGES['api'], 'x', Path('/auth'))

    def test_token_endpoint_failure_is_not_missing_manifest(self):
        with patch.object(g, 'registry_token', side_effect=HTTPError('https://x', 404, '', {}, None)):
            with self.assertRaises(HTTPError):
                g.registry_head('squashmerge/test', SHA)

    def test_clean_child_environment_removes_credentials(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'sentinel', 'GITHUB_TOKEN': 'sentinel',
                                    'ACTIONS_RUNTIME_TOKEN': 'sentinel'}):
            env = g.clean_env()
        self.assertNotIn('GH_TOKEN', env)
        self.assertNotIn('GITHUB_TOKEN', env)
        self.assertNotIn('ACTIONS_RUNTIME_TOKEN', env)

    def test_registry_login_uses_stdin_not_arguments(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'GH_TOKEN': 'sentinel'}), \
             patch.object(g.subprocess, 'run') as call:
            g.login(Path(temp))
        self.assertNotIn('sentinel', repr(call.call_args.args))
        self.assertEqual(call.call_args.kwargs['input'], 'sentinel\n')

    def test_privacy_fails_on_missing_approval_or_public_probe(self):
        with patch.dict(os.environ, {'SNAPSHOT_PACKAGE_POLICY_REVIEWED': 'false'}):
            with self.assertRaises(ValueError):
                g.verify_private()
        with patch.dict(os.environ, {'SNAPSHOT_PACKAGE_POLICY_REVIEWED': 'true'}), \
             patch.object(g, 'package_metadata'), patch.object(g, 'registry_head', return_value=DIGESTS['api']):
            with self.assertRaisesRegex(ValueError, 'anonymous'):
                g.verify_private()

    def test_manifest_digest_checks_bytes_and_config(self):
        raw = json.dumps({'schemaVersion': 2, 'config': {'digest': DIGESTS['api']}}).encode()
        with patch.object(g.subprocess, 'check_output', return_value=raw):
            digest, config, actual_raw = g.raw_manifest('candidate')
        self.assertEqual(config, DIGESTS['api'])
        self.assertEqual(actual_raw, raw)
        self.assertEqual(digest, 'sha256:' + __import__('hashlib').sha256(raw).hexdigest())

    def test_reservation_layout_binds_pair_without_image_layers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'layout'
            record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS}
            g.reservation_layout(root, record)
            index = json.loads((root / 'index.json').read_text())
            descriptor = index['manifests'][0]
            manifest = json.loads((root / 'blobs/sha256' / descriptor['digest'].split(':')[1]).read_text())
            config = json.loads((root / 'blobs/sha256' / manifest['config']['digest'].split(':')[1]).read_text())
            self.assertEqual(manifest['layers'], [])
            self.assertEqual(json.loads(config['config']['Labels']['org.glasshouse.snapshot.reservation']), record)

    def test_existing_reservation_mismatch_fails_closed(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS}
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'registry_head', return_value=DIGESTS['api']), \
             patch.object(g, 'read_reservation', return_value=dict(record, digests={'api': 'wrong'})), \
             patch.object(g, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'reservation'):
                g.reserve(record, Path(temp), Path(temp) / 'auth')
            run.assert_not_called()

    def test_workflow_is_main_only_and_uses_serial_queue(self):
        text = Path('.github/workflows/snapshot-publish.yml').read_text()
        for expected in ('queue: max', 'cancel-in-progress: false', "github.ref == 'refs/heads/main'",
                         "github.event.workflow_run.event == 'push'", 'packages: write',
                         'SNAPSHOT_PUBLISH_ENABLED', 'persist-credentials: false'):
            self.assertIn(expected, text)
        self.assertNotIn('pull_request:', text)

    def test_conflict_refuses_both_app_pushes(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), patch.object(g, 'verify_fresh_main'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': EVIDENCE}), \
             patch.object(g, 'registry_head', return_value='sha256:' + '3' * 64), \
             patch.object(g, 'existing_complete', return_value=None), \
             patch.object(g, 'build_test_scan') as build, patch.object(g, 'run') as run:
            root = Path(temp)
            def candidate(sha, repo, work, records):
                for name in g.PACKAGES:
                    (records / f'{sha}-{name}-sbom.json').write_bytes(sbom(name))
                return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
            build.side_effect = candidate
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                g.publish_one(SHA, root, root)
            run.assert_not_called()
            self.assertEqual(json.loads((root / (SHA + '.json')).read_text())['state'], 'incomplete')

    def test_incomplete_revision_with_expired_ci_never_builds_or_publishes(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main'), patch.object(g, 'existing_complete', return_value=None), \
             patch.object(g, 'admit_exact', return_value={'state': 'blocked', 'reasons': ['CI:missing']}), \
             patch.object(g, 'build_test_scan') as build:
            with self.assertRaisesRegex(ValueError, 'gates'):
                g.publish_one(SHA, Path(temp), Path(temp))
            build.assert_not_called()

    def test_previously_complete_pair_survives_expired_ci(self):
        evidence = {'CI': {'run_id': 1, 'attempt': 1},
                    'Dependency release age': {'run_id': 2, 'attempt': 1}}
        completed = {'sha': SHA, 'state': 'complete', 'digests': DIGESTS, 'admission': evidence}
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main') as fresh, \
             patch.object(g, 'existing_complete', return_value=completed), \
             patch.object(g, 'admit_exact', side_effect=AssertionError('expired gates queried')):
            self.assertEqual(g.publish_one(SHA, Path(temp), Path(temp)), completed)
            self.assertEqual(fresh.call_count, 2)

    def test_reservation_verifies_embedded_private_sbom_bytes(self):
        import hashlib
        api = sbom('api')
        web = sbom('web')
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': {'CI': {'run_id': 1, 'attempt': 1},
                                'Dependency release age': {'run_id': 2, 'attempt': 1}},
                  'sbom_sha256': {name: hashlib.sha256(data).hexdigest()
                                  for name, data in {'api': api, 'web': web}.items()},
                  'sboms': {name: g.encode_sbom(data) for name, data in {'api': api, 'web': web}.items()},
                  'manifests': SBOM_FIELDS['manifests'],
                  'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
        self.assertTrue(g.valid_reservation(record, SHA))
        record['sboms']['api'] = g.encode_sbom(web)
        self.assertFalse(g.valid_reservation(record, SHA))

    def test_complete_reservation_requires_full_trusted_evidence(self):
        valid = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                 'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                 'admission': {'CI': {'run_id': 1, 'attempt': 1},
                               'Dependency release age': {'run_id': 2, 'attempt': 1}},
                 **SBOM_FIELDS,
                 'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
        self.assertTrue(g.valid_reservation(valid, SHA))
        for field in ('admission', 'packages', 'repository', 'sbom_sha256', 'build_run', 'build_attempt'):
            invalid = dict(valid)
            invalid.pop(field)
            self.assertFalse(g.valid_reservation(invalid, SHA))

    def test_complete_reserved_pair_is_reconciled_without_rebuild(self):
        record = {'sha': SHA, 'platform': 'linux/amd64', 'digests': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': {'CI': {'run_id': 1, 'attempt': 1},
                                'Dependency release age': {'run_id': 2, 'attempt': 1}},
                  **SBOM_FIELDS,
                  'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'login'), \
             patch.object(g, 'read_reservation', return_value=record), \
             patch.object(g, 'registry_head', side_effect=lambda package, tag:
                 DIGESTS['api'] if tag.startswith('reservation-') else
                 DIGESTS['api' if 'api-snapshot' in package else 'web']):
            reconciled = g.existing_complete(SHA, temp)
            self.assertEqual(reconciled['state'], 'complete')
            self.assertEqual(reconciled['published'], DIGESTS)

    def test_real_coordinator_partial_push_and_retry(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': EVIDENCE}), \
             patch.object(g, 'build_test_scan') as build, patch.object(g, 'login'), \
             patch.object(g, 'verify_fresh_main'), \
             patch.object(g, 'existing_complete', return_value=None), \
             patch.object(g, 'reserve', side_effect=lambda record, *args: record), patch.object(g, 'registry_head') as head, \
             patch.object(g, 'run') as run:
            root = Path(temp)
            tags, calls = {}, []
            def candidate(sha, repo, work, records):
                for name in g.PACKAGES:
                    (records / f'{sha}-{name}-sbom.json').write_bytes(sbom(name))
                return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
            build.side_effect = candidate
            head.side_effect = lambda package, tag: tags.get(package)
            def push(command, **kwargs):
                destination = command[-1]
                name = 'api' if 'api-snapshot' in destination else 'web'
                calls.append(name)
                if name == 'web' and calls.count('web') == 1:
                    raise OSError('interrupted')
                tags[g.PACKAGES[name]] = DIGESTS[name]
            run.side_effect = push
            with self.assertRaises(OSError):
                g.publish_one(SHA, root, root)
            partial = json.loads((root / (SHA + '.json')).read_text())
            self.assertEqual(partial['state'], 'incomplete')
            self.assertEqual(partial['published'], {'api': DIGESTS['api']})
            self.assertEqual(g.publish_one(SHA, root, root)['state'], 'complete')
            self.assertEqual(calls, ['api', 'web', 'web'])

    def test_ref_revoked_after_reservation_stops_second_image_push(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': EVIDENCE}), \
             patch.object(g, 'build_test_scan') as build, patch.object(g, 'login'), \
             patch.object(g, 'existing_complete', return_value=None), patch.object(g, 'reserve', side_effect=lambda record, *args: record), \
             patch.object(g, 'registry_head', return_value=None) as head, \
             patch.object(g, 'run') as run:
            root = Path(temp)
            def candidate(sha, repo, work, records):
                for name in g.PACKAGES:
                    (records / f'{sha}-{name}-sbom.json').write_bytes(sbom(name))
                return DIGESTS, {name: work / name for name in g.PACKAGES}, MANIFESTS
            build.side_effect = candidate
            checks = []
            def fresh(sha):
                checks.append(sha)
                if len(checks) == 4:
                    raise ValueError('SHA is not on the main first-parent chain')
            with patch.object(g, 'verify_fresh_main', side_effect=fresh, create=True):
                # Simulate a successful readback after the first upload.
                head.side_effect = [None, None, None, DIGESTS['api'], None]
                with self.assertRaisesRegex(ValueError, 'first-parent'):
                    g.publish_one(SHA, root, root)
            self.assertEqual(run.call_count, 1)
            self.assertIn('api-snapshot', run.call_args.args[0][-1])

    def test_test_or_scan_failure_never_publishes(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}), \
             patch.object(g, 'verify_private'), patch.object(g, 'verify_fresh_main'), \
             patch.object(g, 'admit_exact', return_value={'state': 'gates-passed', 'evidence': EVIDENCE}), \
             patch.object(g, 'existing_complete', return_value=None), \
             patch.object(g, 'build_test_scan', side_effect=subprocess.CalledProcessError(1, 'trivy')), \
             patch.object(g, 'run') as run:
            root = Path(temp)
            with self.assertRaises(subprocess.CalledProcessError):
                g.publish_one(SHA, root, root)
            run.assert_not_called()
            self.assertEqual(json.loads((root / (SHA + '.json')).read_text())['state'], 'building')


if __name__ == '__main__':
    unittest.main()
