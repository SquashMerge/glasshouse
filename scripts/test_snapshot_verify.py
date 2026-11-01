import tempfile
import hashlib
import base64
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import snapshot_verify as v
from test_snapshot_ghcr import SHA, DIGESTS, SBOM_FIELDS, EVIDENCE, sbom, malformed_evidence_records
import snapshot_ghcr as g


class VerifyTests(unittest.TestCase):
    def test_verifier_accepts_upstream_trivy_fixture_with_synthetic_manifest(self):
        # https://github.com/aquasecurity/trivy/blob/v0.69.3/integration/testdata/fluentd-multiple-lockfiles-short.cdx.json.golden
        # Upstream Trivy is licensed under Apache-2.0.
        raw = (Path(__file__).parent / 'fixtures/trivy-v0.69.3-fluentd.cdx.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         '0b3af50245d4f756d154a5e12ffbaf26a5541fbbcabcf9095c8ddc97d8206ccb')
        bom = json.loads(raw)
        config = next(p['value'] for p in bom['metadata']['component']['properties']
                      if p['name'] == 'aquasecurity:trivy:ImageID')
        manifest = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                               'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                                          'digest': config, 'size': 123},
                               'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip',
                                           'digest': 'sha256:' + '3' * 64, 'size': 42}]}).encode()
        digest = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        digests = dict.fromkeys(g.PACKAGES, digest)
        record = {'sha': SHA, 'state': 'complete', 'published': digests, 'platform': 'linux/amd64',
                  'digests': digests, 'repository': g.REPOSITORY, 'packages': g.PACKAGES,
                  'build_run': '10', 'build_attempt': '1', 'admission': EVIDENCE,
                  'manifests': dict.fromkeys(g.PACKAGES, base64.b64encode(manifest).decode()),
                  'sboms': dict.fromkeys(g.PACKAGES, g.encode_sbom(raw)),
                  'sbom_sha256': dict.fromkeys(g.PACKAGES, hashlib.sha256(raw).hexdigest()),
                  'pair_test': 'passed', 'scans': {'api': 'passed', 'web': 'passed'}}
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main'), patch.object(g, 'existing_complete', return_value=record):
            self.assertEqual(v.verify(SHA, Path(temp))['source_sha'], SHA)

    def test_verifier_rejects_structurally_malformed_evidence(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main'):
            for label, record in malformed_evidence_records():
                with self.subTest(label=label), patch.object(g, 'existing_complete', return_value=record):
                    with self.assertRaises(ValueError):
                        v.verify(SHA, Path(temp))

    def test_verifier_rejects_wrong_sbom_image_even_with_recomputed_hash(self):
        wrong = sbom('web')
        record = {'sha': SHA, 'state': 'complete', 'platform': 'linux/amd64',
                  'digests': DIGESTS, 'published': DIGESTS, 'repository': g.REPOSITORY,
                  'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': EVIDENCE, **SBOM_FIELDS, 'pair_test': 'passed',
                  'scans': {'api': 'passed', 'web': 'passed'}}
        record['sboms'] = dict(record['sboms'], api=g.encode_sbom(wrong))
        record['sbom_sha256'] = dict(record['sbom_sha256'], api=hashlib.sha256(wrong).hexdigest())
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main'), patch.object(g, 'existing_complete', return_value=record):
            with self.assertRaises(ValueError):
                v.verify(SHA, Path(temp))

    def test_verifier_identifies_exact_source_and_digest_pair(self):
        record = {'sha': SHA, 'state': 'complete', 'platform': 'linux/amd64',
                  'digests': DIGESTS, 'published': DIGESTS,
                  'repository': g.REPOSITORY, 'packages': g.PACKAGES, 'build_run': '10', 'build_attempt': '1',
                  'admission': {'CI': {'run_id': 1, 'attempt': 1},
                                'Dependency release age': {'run_id': 2, 'attempt': 1}},
                  **SBOM_FIELDS, 'pair_test': 'passed',
                  'scans': {'api': 'passed', 'web': 'passed'}}
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main') as fresh, \
             patch.object(g, 'existing_complete', return_value=record):
            report = v.verify(SHA, Path(temp))
        self.assertEqual(report['source_sha'], SHA)
        self.assertEqual(report['images']['api'], f'ghcr.io/{g.PACKAGES["api"]}@{DIGESTS["api"]}')
        self.assertEqual(report['images']['web'], f'ghcr.io/{g.PACKAGES["web"]}@{DIGESTS["web"]}')
        self.assertEqual(report['assurance'], 'private-registry-exclusive-writer-not-signed')
        fresh.assert_called_with(SHA)

    def test_verifier_rejects_missing_or_corrupt_pair(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(g, 'verify_private'), \
             patch.object(g, 'verify_fresh_main'), patch.object(g, 'existing_complete', return_value=None):
            with self.assertRaises(ValueError):
                v.verify(SHA, Path(temp))
