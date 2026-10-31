#!/usr/bin/env python3
"""Disabled-by-default GHCR snapshot runner; use only in the protected workflow.

The registry is not transactional. Full-SHA tags are protected against accidental
retargeting by the serialized workflow and digest checks, not against administrators
or other writers. Private registry records are not a lock or signature.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zlib

from snapshot_admission import REPOSITORY, SHA, WORKFLOWS, admit_exact, fresh_main_history, verify_fresh_main
from snapshot_reconcile import initial, reconcile
from snapshot_candidate import source_archive
from snapshot_preflight import package_metadata

PACKAGES = {name: f'squashmerge/glasshouse-{name}-snapshot' for name in ('api', 'web')}
DIGEST_ACCEPT = ', '.join(('application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json'))


def clean_env(extra=None):
    env = os.environ.copy()
    for key in ('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_ACTIONS'):
        env.pop(key, None)
    if extra:
        env.update(extra)
    return env


def run(command, **kwargs):
    return subprocess.run(command, check=True, env=clean_env(),
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


class ScanFailure(ValueError):
    """A scanner failure whose message contains only explicitly allowed data."""


# Only known built-in rule names may appear in public logs. Unknown/custom rule
# IDs are counted, not echoed: rule IDs themselves are untrusted input.
SAFE_SECRET_RULES = frozenset('''
aws-access-key-id aws-secret-access-key github-pat github-oauth github-app-token
github-refresh-token github-fine-grained-pat gitlab-pat hugging-face-access-token
private-key shopify-token slack-access-token stripe-publishable-token stripe-secret-token
gcp-service-account heroku-api-key slack-web-hook twilio-api-key age-secret-key
facebook-token twitter-token adobe-client-id adobe-client-secret alibaba-access-key-id
alibaba-secret-key asana-client-id asana-client-secret atlassian-api-token
bitbucket-client-id bitbucket-client-secret beamer-api-token clojars-api-token
contentful-delivery-api-token databricks-api-token discord-api-token discord-client-id
discord-client-secret doppler-api-token dropbox-api-secret dropbox-short-lived-api-token
dropbox-long-lived-api-token duffel-api-token dynatrace-api-token easypost-api-token
fastly-api-token finicity-client-secret finicity-api-token flutterwave-public-key
flutterwave-enc-key frameio-api-token gocardless-api-token grafana-api-token
hashicorp-tf-api-token hubspot-api-token intercom-api-token intercom-client-secret
ionic-api-token jwt-token linear-api-token linear-client-secret lob-api-key lob-pub-api-key
mailchimp-api-key mailgun-token mailgun-signing-key mapbox-api-token messagebird-api-token
messagebird-client-id new-relic-user-api-key new-relic-user-api-id
new-relic-browser-api-token npm-access-token planetscale-password planetscale-api-token
private-packagist-token postman-api-token pulumi-api-token rubygems-api-token
sendgrid-api-token sendinblue-api-token shippo-api-token linkedin-client-secret
linkedin-client-id twitch-api-token typeform-api-token dockerconfig-secret
symfony-default-secret
'''.split())
SCAN_REPORT_LIMIT = 32 * 1024 * 1024
SCAN_ENTRY_LIMIT = 20


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def scan_image(image, config_digest):
    """Fail closed; never expose raw scanner output, metadata, or subprocess args."""
    command = ['trivy', 'image', '--scanners', 'vuln,secret', '--exit-code', '1',
               '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--format', 'json', image]
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(command, env=clean_env(), stdout=output,
                                    stderr=subprocess.DEVNULL, check=False)
            output.seek(0)
            raw = output.read(SCAN_REPORT_LIMIT + 1)
    except (OSError, subprocess.SubprocessError):
        raise ScanFailure('Trivy operational failure (process could not run)') from None
    if result.returncode not in (0, 1):
        raise ScanFailure('Trivy operational failure (nonzero exit; output suppressed)')
    try:
        if len(raw) > SCAN_REPORT_LIMIT:
            raise ValueError
        doc = json.loads(raw, object_pairs_hook=unique_json_object)
        if (not isinstance(doc, dict) or type(doc.get('SchemaVersion')) is not int
                or doc['SchemaVersion'] != 2 or doc.get('ArtifactType') != 'container_image'
                or doc.get('ArtifactName') != image or not isinstance(doc.get('Metadata'), dict)
                or doc['Metadata'].get('ImageID') != config_digest):
            raise ValueError
        results = doc.get('Results', [])
        if not isinstance(results, list):
            raise ValueError
        vulnerabilities, secrets = [], []
        for entry in results:
            if (not isinstance(entry, dict) or not isinstance(entry.get('Target'), str)
                    or not set(entry).issubset({'Target', 'Class', 'Type', 'Packages',
                                                'Vulnerabilities', 'Secrets'})):
                raise ValueError
            for key, dest in (('Vulnerabilities', vulnerabilities), ('Secrets', secrets)):
                findings = entry.get(key, [])
                if not isinstance(findings, list):
                    raise ValueError
                for finding in findings:
                    if (not isinstance(finding, dict)
                            or finding.get('Severity') not in ('HIGH', 'CRITICAL')):
                        raise ValueError
                    ident = finding.get('VulnerabilityID' if key == 'Vulnerabilities' else 'RuleID')
                    if not isinstance(ident, str) or not ident:
                        raise ValueError
                    if key == 'Vulnerabilities':
                        ident = ident if re.fullmatch(r'CVE-[0-9]{4}-[0-9]{4,7}', ident) else 'other'
                        dest.append((ident, finding['Severity']))
                    else:
                        dest.append(ident if ident in SAFE_SECRET_RULES else 'other')
    except (ValueError, TypeError, UnicodeError, RecursionError):
        if result.returncode:
            raise ScanFailure('Trivy operational failure (no valid scan report; output suppressed)') from None
        raise ScanFailure('Trivy invalid scan report (output suppressed)') from None
    if result.returncode == 0 and not vulnerabilities and not secrets:
        return
    if result.returncode == 1 and (vulnerabilities or secrets):
        vuln_summary = sorted(set(vulnerabilities))[:SCAN_ENTRY_LIMIT]
        secret_summary = sorted(set(secrets))[:SCAN_ENTRY_LIMIT]
        raise ScanFailure('Trivy findings: ' + json.dumps({
            'vulnerability_count': len(vulnerabilities), 'vulnerabilities': vuln_summary,
            'secret_count': len(secrets), 'secret_rule_ids': secret_summary,
            'details_truncated': len(set(vulnerabilities)) > SCAN_ENTRY_LIMIT or len(set(secrets)) > SCAN_ENTRY_LIMIT,
        }, separators=(',', ':')))
    raise ScanFailure('Trivy operational failure (exit/report mismatch; output suppressed)')


def registry_token(package, authenticated):
    query = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': f'repository:{package}:pull'})
    headers = {}
    if authenticated:
        token = os.environ['GH_TOKEN']
        headers['Authorization'] = 'Basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode()
    request = urllib.request.Request('https://ghcr.io/token?' + query, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    result = value.get('token') or value.get('access_token')
    if not isinstance(result, str) or not result:
        raise ValueError('registry did not issue a pull token')
    return result


def registry_head(package, tag, authenticated=True):
    """Return digest, None for confirmed authenticated 404, or raise on ambiguity."""
    bearer = registry_token(package, authenticated)
    request = urllib.request.Request(f'https://ghcr.io/v2/{package}/manifests/{tag}',
        headers={'Authorization': 'Bearer ' + bearer, 'Accept': DIGEST_ACCEPT}, method='HEAD')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            digest = response.headers.get('Docker-Content-Digest', '')
        if not __import__('re').fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise ValueError('registry returned an invalid digest')
        return digest
    except urllib.error.HTTPError as exc:
        if authenticated and exc.code == 404:
            return None
        raise


def verify_private():
    if os.environ.get('SNAPSHOT_PACKAGE_POLICY_REVIEWED') != 'true':
        raise ValueError('package access and fork policy review is not affirmed')
    package_metadata()  # Authenticated API must identify both private org packages.
    for package in PACKAGES.values():
        # Admin creates a harmless private bootstrap tag in each package before enablement.
        if registry_head(package, 'bootstrap') is None:
            raise ValueError('private bootstrap tag is absent or unreadable')
        try:
            registry_head(package, 'bootstrap', authenticated=False)
        except urllib.error.HTTPError as exc:
            if exc.code not in (401, 403):
                raise ValueError('anonymous pull denial was not established') from exc
        else:
            raise ValueError('anonymous pull unexpectedly succeeded')


def persist(path, record):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as output:
        json.dump(record, output, indent=2, sort_keys=True)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def raw_manifest(archive):
    raw = subprocess.check_output(['skopeo', 'inspect', '--raw', f'oci-archive:{archive}'], env=clean_env(), stderr=subprocess.DEVNULL)
    manifest = json.loads(raw)
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 2 or 'config' not in manifest:
        raise ValueError('candidate must have one image manifest, not an index')
    config = manifest.get('config', {}).get('digest', '')
    if not __import__('re').fullmatch(r'sha256:[0-9a-f]{64}', config):
        raise ValueError('candidate config digest invalid')
    return 'sha256:' + hashlib.sha256(raw).hexdigest(), config, raw


def build_test_scan(sha, root, work, record_dir, *, archive_factory=source_archive):
    # Publication always uses the default first-parent archive policy; only the
    # separate, registry-free CI runner injects the checked-out HEAD policy.
    archive = archive_factory(root, sha)
    source = work / 'source'
    source.mkdir()
    run(['tar', '-xf', '-', '-C', str(source)], input=archive)
    images, digests, archives, manifests = {}, {}, {}, {}
    for name in PACKAGES:
        output = work / f'{name}.oci.tar'
        image = f'glasshouse-local-{name}:{sha}'
        run(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--file', f'apps/{name}/Dockerfile',
             '--output', f'type=oci,dest={output}', '--provenance=false', '--sbom=false',
             '--label', f'org.opencontainers.image.revision={sha}', '-'], cwd=work, input=archive)
        digests[name], config_digest, manifests[name] = raw_manifest(output)
        run(['skopeo', 'copy', f'oci-archive:{output}', f'docker-daemon:{image}'])
        loaded_id = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], env=clean_env(), text=True, stderr=subprocess.DEVNULL).strip()
        if loaded_id != config_digest:
            raise ValueError('loaded image differs from OCI candidate')
        actual = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image], env=clean_env(), text=True, stderr=subprocess.DEVNULL).strip()
        if actual != sha:
            raise ValueError('candidate revision label mismatch')
        scan_image(image, config_digest)
        sbom = record_dir / f'{sha}-{name}-sbom.json'
        run(['trivy', 'image', '--format', 'cyclonedx', '--output', str(sbom), image])
        validate_sbom_identity(sbom.read_bytes(), config_digest)
        images[name], archives[name] = image, output
    env = clean_env({'IMAGE_TEST_REVISION': sha, 'IMAGE_TEST_API': images['api'], 'IMAGE_TEST_WEB': images['web']})
    subprocess.run(['bash', 'infra/scripts/test-image-compose-integration.sh'], cwd=source, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return digests, archives, manifests


def login(authdir):
    env = clean_env({'DOCKER_CONFIG': str(authdir)})
    subprocess.run(['docker', 'login', 'ghcr.io', '--username', 'x-access-token', '--password-stdin'],
                   input=os.environ['GH_TOKEN'] + '\n', text=True, env=env, check=True,
                   stdout=subprocess.DEVNULL)


def reservation_layout(path, record):
    """Create an OCI image containing a private reservation/checkpoint in labels."""
    blobs = path / 'blobs' / 'sha256'
    blobs.mkdir(parents=True)
    def blob(value):
        content = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        digest = hashlib.sha256(content).hexdigest()
        (blobs / digest).write_bytes(content)
        return {'digest': 'sha256:' + digest, 'size': len(content)}
    config = blob({'architecture': 'amd64', 'os': 'linux', 'rootfs': {'type': 'layers', 'diff_ids': []},
                   'config': {'Labels': {'org.glasshouse.snapshot.reservation': json.dumps(record, sort_keys=True, separators=(',', ':'))}}})
    config['mediaType'] = 'application/vnd.oci.image.config.v1+json'
    manifest = blob({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                     'config': config, 'layers': []})
    manifest.update(mediaType='application/vnd.oci.image.manifest.v1+json',
                    annotations={'org.opencontainers.image.ref.name': 'reservation'})
    (path / 'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
    (path / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'manifests': [manifest]}))


def read_reservation(package, tag, authfile):
    reference = f'docker://ghcr.io/{package}:{tag}'
    digest = registry_head(package, tag)
    if digest is None:
        raise ValueError('registry record missing')
    raw = subprocess.check_output(['skopeo', 'inspect', '--raw', '--authfile', str(authfile), reference], env=clean_env())
    if 'sha256:' + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('registry record manifest digest mismatch')
    manifest = json.loads(raw)
    if manifest.get('schemaVersion') != 2 or manifest.get('layers') != []:
        raise ValueError('invalid registry record manifest')
    config = subprocess.check_output(['skopeo', 'inspect', '--raw', '--config', '--authfile', str(authfile), reference], env=clean_env())
    if ('sha256:' + hashlib.sha256(config).hexdigest() != manifest.get('config', {}).get('digest')
            or registry_head(package, tag) != digest):
        raise ValueError('registry record config digest mismatch or tag changed')
    value = json.loads(config)['config']['Labels']['org.glasshouse.snapshot.reservation']
    return json.loads(value)


CHECKPOINT_TAG = 'publisher-checkpoint-v1'


def load_checkpoint(authfile):
    if registry_head(PACKAGES['api'], CHECKPOINT_TAG) is None:
        raise ValueError('checkpoint missing; explicit operator recovery required')
    record = read_reservation(PACKAGES['api'], CHECKPOINT_TAG, authfile)
    if (not isinstance(record, dict) or set(record) != {'kind', 'repository', 'packages', 'state'}
            or record['kind'] != 'checkpoint' or record['repository'] != REPOSITORY
            or record['packages'] != PACKAGES):
        raise ValueError('invalid checkpoint identity')
    return record['state']


def save_checkpoint(state, authfile, expected):
    package = PACKAGES['api']
    if registry_head(package, CHECKPOINT_TAG) != expected:
        raise ValueError('checkpoint changed or disappeared')
    record = {'kind': 'checkpoint', 'repository': REPOSITORY, 'packages': PACKAGES, 'state': state}
    with tempfile.TemporaryDirectory(prefix='checkpoint-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        layout = Path(directory) / 'layout'
        reservation_layout(layout, record)
        descriptor = json.loads((layout / 'index.json').read_text())['manifests'][0]
        intended = descriptor['digest']
        verify_fresh_main(state['cursor'])
        run(['skopeo', 'copy', '--preserve-digests', '--authfile', str(authfile),
             f'oci:{layout}:reservation', f'docker://ghcr.io/{package}:{CHECKPOINT_TAG}'])
    if registry_head(package, CHECKPOINT_TAG) != intended or load_checkpoint(authfile) != state:
        raise ValueError('checkpoint readback mismatch')
    return intended


def reserve(record, work, authfile):
    sha, digests = record['sha'], record['digests']
    if not valid_reservation(record, sha):
        raise ValueError('invalid reservation evidence')
    package, tag = PACKAGES['api'], 'reservation-' + sha
    current = registry_head(package, tag)
    if current is None:
        # A tag with no reservation is ambiguous (legacy writer or deleted
        # reservation), so never create a new intent in that state.
        if any(registry_head(p, sha) is not None for p in PACKAGES.values()):
            raise ValueError('unreserved SHA tag exists')
        layout = work / 'reservation'
        reservation_layout(layout, record)
        verify_fresh_main(sha)
        run(['skopeo', 'copy', '--preserve-digests', '--authfile', str(authfile),
             f'oci:{layout}:reservation', f'docker://ghcr.io/{package}:{tag}'])
        if registry_head(package, tag) is None:
            raise ValueError('reservation not readable')
    existing = read_reservation(package, tag, authfile)
    if (not valid_reservation(existing, sha) or
            any(existing.get(key) != record.get(key) for key in
                ('sha', 'platform', 'repository', 'packages', 'digests', 'manifests'))):
        raise ValueError('candidate conflicts with durable reservation')
    return existing


SBOM_LIMIT = 8 * 1024 * 1024
MANIFEST_LIMIT = 1024 * 1024


def validate_sbom_identity(raw, config_digest):
    """Trivy's ImageID is the Docker config digest, not the manifest digest."""
    bom = json.loads(raw)
    if not isinstance(bom, dict) or bom.get('bomFormat') != 'CycloneDX':
        raise ValueError('invalid CycloneDX SBOM')
    if (not isinstance(bom.get('specVersion'), str)
            or not __import__('re').fullmatch(r'1\.[0-7]', bom['specVersion'])
            or ('version' in bom and (type(bom['version']) is not int or bom['version'] < 1))):
        raise ValueError('invalid CycloneDX version')
    metadata = bom.get('metadata')
    if not isinstance(metadata, dict):
        raise ValueError('SBOM has no metadata')
    component = metadata.get('component')
    if not isinstance(component, dict) or component.get('type') != 'container':
        raise ValueError('SBOM has no container root component')
    if not isinstance(component.get('name'), str) or not component['name'].strip():
        raise ValueError('SBOM has no container name')
    properties = component.get('properties')
    if not isinstance(properties, list) or not all(isinstance(p, dict) for p in properties):
        raise ValueError('SBOM has invalid root properties')
    ids = [p.get('value') for p in properties if p.get('name') == 'aquasecurity:trivy:ImageID']
    if ids != [config_digest]:
        raise ValueError('SBOM image config digest mismatch')


def manifest_config(encoded, digest):
    if not isinstance(encoded, str) or len(encoded) > MANIFEST_LIMIT * 2:
        raise ValueError('invalid encoded image manifest')
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MANIFEST_LIMIT or 'sha256:' + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('image manifest digest mismatch')
    manifest = json.loads(raw)
    if (not isinstance(manifest, dict) or type(manifest.get('schemaVersion')) is not int
            or manifest['schemaVersion'] != 2
            or ('mediaType' in manifest and manifest['mediaType'] not in (
                'application/vnd.oci.image.manifest.v1+json',
                'application/vnd.docker.distribution.manifest.v2+json'))):
        raise ValueError('invalid image manifest')
    descriptor = manifest.get('config')
    layers = manifest.get('layers')
    if not isinstance(layers, list):
        raise ValueError('invalid image layers')
    def validate_descriptor(item):
        if (not isinstance(item, dict) or not isinstance(item.get('mediaType'), str)
                or not item['mediaType'].strip() or type(item.get('size')) is not int or item['size'] < 0
                or not isinstance(item.get('digest'), str)
                or not __import__('re').fullmatch(r'sha256:[0-9a-f]{64}', item['digest'])):
            raise ValueError('invalid image descriptor')
        return item['digest']
    config = validate_descriptor(descriptor)
    for layer in layers:
        validate_descriptor(layer)
    return config


def encode_sbom(raw):
    if not isinstance(raw, bytes) or len(raw) > SBOM_LIMIT or json.loads(raw).get('bomFormat') != 'CycloneDX':
        raise ValueError('invalid or oversized CycloneDX SBOM')
    return base64.b64encode(zlib.compress(raw, level=9)).decode('ascii')


def decode_sbom(encoded):
    if not isinstance(encoded, str) or len(encoded) > SBOM_LIMIT * 2:
        raise ValueError('invalid encoded SBOM')
    compressed = base64.b64decode(encoded, validate=True)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, SBOM_LIMIT + 1)
    if len(raw) > SBOM_LIMIT or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('invalid or oversized SBOM')
    if json.loads(raw).get('bomFormat') != 'CycloneDX':
        raise ValueError('invalid CycloneDX SBOM')
    return raw


def valid_reservation(record, sha):
    if not isinstance(record, dict) or not isinstance(record.get('digests'), dict):
        return False
    digests = record['digests']
    evidence = record.get('admission')
    sbom = record.get('sbom_sha256')
    contents = record.get('sboms')
    try:
        manifests = record.get('manifests')
        if (not isinstance(contents, dict) or set(contents) != set(PACKAGES)
                or not isinstance(manifests, dict) or set(manifests) != set(PACKAGES)
                or set(digests) != set(PACKAGES)):
            return False
        decoded = {name: decode_sbom(contents[name]) for name in PACKAGES}
        for name in PACKAGES:
            validate_sbom_identity(decoded[name], manifest_config(manifests[name], digests[name]))
    except (ValueError, TypeError, AttributeError, KeyError, zlib.error):
        return False
    return (record.get('sha') == sha and record.get('platform') == 'linux/amd64'
            and record.get('repository') == REPOSITORY and record.get('packages') == PACKAGES
            and all(isinstance(record.get(key), str) and __import__('re').fullmatch(r'[1-9][0-9]*', record[key])
                    for key in ('build_run', 'build_attempt'))
            and isinstance(evidence, dict) and set(evidence) == set(WORKFLOWS)
            and all(isinstance(item, dict) and set(item) == {'run_id', 'attempt'}
                    and all(type(item[key]) is int and item[key] > 0 for key in item)
                    for item in evidence.values())
            and isinstance(sbom, dict) and set(sbom) == set(PACKAGES)
            and all(isinstance(value, str) and __import__('re').fullmatch(r'[0-9a-f]{64}', value) for value in sbom.values())
            and all(hashlib.sha256(decoded[name]).hexdigest() == sbom[name] for name in PACKAGES)
            and record.get('pair_test') == 'passed' and record.get('scans') == {'api': 'passed', 'web': 'passed'}
            and set(digests) == set(PACKAGES)
            and all(isinstance(value, str) and __import__('re').fullmatch(r'sha256:[0-9a-f]{64}', value)
                    for value in digests.values()))


def existing_complete(sha, work):
    tag = 'reservation-' + sha
    if registry_head(PACKAGES['api'], tag) is None:
        return None
    with tempfile.TemporaryDirectory(prefix='registry-auth-', dir=work) as directory:
        authdir = Path(directory)
        login(authdir)
        record = read_reservation(PACKAGES['api'], tag, authdir / 'config.json')
    if not valid_reservation(record, sha):
        raise ValueError('invalid existing reservation')
    digests = record['digests']
    states = {name: registry_head(package, sha) for name, package in PACKAGES.items()}
    if any(states[name] is not None and states[name] != digests[name] for name in PACKAGES):
        raise ValueError('existing tag conflicts with durable reservation')
    if all(states[name] == digests[name] for name in PACKAGES):
        record.update(state='complete', published=states, reservation=tag)
        return record
    return None


def publish_one(sha, root, record_dir):
    if not SHA.fullmatch(sha):
        raise ValueError('invalid source SHA')
    verify_private()
    verify_fresh_main(sha)
    path = record_dir / (sha + '.json')
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        work = Path(directory)
        existing = existing_complete(sha, work)
        if existing is not None:
            verify_private()
            verify_fresh_main(sha)
            persist(path, existing)
            return existing
        admission = admit_exact(sha)
        if admission.get('state') != 'gates-passed':
            raise ValueError('source gates not successful')
        record = {'sha': sha, 'state': 'building', 'platform': 'linux/amd64',
                  'repository': REPOSITORY, 'packages': PACKAGES,
                  'admission': admission['evidence'], 'build_run': os.environ['GITHUB_RUN_ID'],
                  'build_attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'digests': {}, 'published': {}}
        persist(path, record)
        digests, archives, manifests = build_test_scan(sha, root, work, record_dir)
        sboms = {name: (record_dir / f'{sha}-{name}-sbom.json').read_bytes() for name in PACKAGES}
        record.update(state='incomplete', digests=digests, pair_test='passed', scans={'api': 'passed', 'web': 'passed'},
                      manifests={name: base64.b64encode(data).decode('ascii') for name, data in manifests.items()},
                      sbom_sha256={name: hashlib.sha256(data).hexdigest() for name, data in sboms.items()},
                      sboms={name: encode_sbom(data) for name, data in sboms.items()})
        if not valid_reservation(record, sha):
            raise ValueError('invalid candidate evidence')
        persist(path, record)
        # Detect both conflicts before either push. GitHub concurrency is the sole
        # serializer; external writers/admin tag deletion are explicitly unsupported.
        for name, package in PACKAGES.items():
            remote = registry_head(package, sha)
            if remote is not None and remote != digests[name]:
                raise ValueError('existing SHA tag conflicts with candidate')
        verify_private()
        if admit_exact(sha).get('state') != 'gates-passed':
            raise ValueError('source gates changed before publication')
        authdir = work / 'auth'
        authdir.mkdir(mode=0o700)
        login(authdir)
        verify_fresh_main(sha)
        record = dict(reserve(record, work, authdir / 'config.json'))
        record.update(state='incomplete', published={})
        # The record and exported files must refer to the same reserved evidence,
        # even though this attempt generated a fresh, nondeterministic SBOM.
        for name in PACKAGES:
            (record_dir / f'{sha}-{name}-sbom.json').write_bytes(decode_sbom(record['sboms'][name]))
        record['reservation'] = 'reservation-' + sha
        persist(path, record)
        for name, package in PACKAGES.items():
            verify_private()
            if admit_exact(sha).get('state') != 'gates-passed':
                raise ValueError('source gates changed during publication')
            current = registry_head(package, sha)
            if current is None:
                verify_fresh_main(sha)
                run(['skopeo', 'copy', '--preserve-digests', '--authfile', str(authdir / 'config.json'),
                     f'oci-archive:{archives[name]}', f'docker://ghcr.io/{package}:{sha}'])
                current = registry_head(package, sha)
            if current != digests[name]:
                raise ValueError('registry digest mismatch or unknown result')
            record['published'][name] = current
            persist(path, record)
        verify_private()
        if any(registry_head(package, sha) != digests[name] for name, package in PACKAGES.items()):
            raise ValueError('pair changed before completion')
        record['state'] = 'complete'
        persist(path, record)
    return record


def main():
    if (os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or
            os.environ.get('SNAPSHOT_PUBLISH_ENABLED') != 'true'):
        raise ValueError('publisher disabled or wrong repository')
    anchor = os.environ.get('SNAPSHOT_ANCHOR', '')
    if not SHA.fullmatch(anchor):
        raise ValueError('fixed reconciliation anchor required')
    record_dir = Path(os.environ['SNAPSHOT_RECORD_DIR'])
    record_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    verify_private()
    history = fresh_main_history()
    if anchor not in history:
        raise ValueError('anchor is not on main')
    with tempfile.TemporaryDirectory(prefix='checkpoint-auth-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        authdir = Path(directory)
        login(authdir)
        authfile = authdir / 'config.json'
        current = registry_head(PACKAGES['api'], CHECKPOINT_TAG)
        if os.environ.get('SNAPSHOT_INITIALIZE_CHECKPOINT') == 'true':
            if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or current is not None:
                raise ValueError('checkpoint initialization is manual and requires an absent checkpoint')
            save_checkpoint(initial(anchor), authfile, None)
            print('checkpoint initialized; no revisions published', flush=True)
            return 0
        state = load_checkpoint(authfile)
        if registry_head(PACKAGES['api'], CHECKPOINT_TAG) != current:
            raise ValueError('checkpoint changed during read')
        expected = [current]
        def save(value):
            expected[0] = save_checkpoint(value, authfile, expected[0])
        def process(sha):
            try:
                result = publish_one(sha, Path.cwd(), record_dir)
                return result['state'] == 'complete'
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                print(json.dumps({'state': 'blocked', 'error': type(exc).__name__}), flush=True)
                return False
        result = reconcile(state, anchor, history, process, save)
        status = 'pending' if result['pending'] else ('more' if result['cursor'] != history[0] else 'reconciled')
        print(json.dumps({'state': status}), flush=True)
        return 1 if result['pending'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as exc:
        print('snapshot publisher failed closed: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(2)
