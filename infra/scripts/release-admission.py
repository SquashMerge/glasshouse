#!/usr/bin/env python3
"""Read-only, fail-closed admission primitives for a future release publisher.

This module does not publish and is not a trust boundary on its own. Callers must
obtain tag, ancestry, check and workflow-run data independently from GitHub.
"""
import re

REPOSITORY = 'SquashMerge/glasshouse'
VERSION = re.compile(r'refs/tags/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.[1-9][0-9]*)?\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')


def validate_event(repository, event, ref, event_sha, tag_sha, checkout_sha, ancestor_of_main):
    if repository != REPOSITORY or event != 'push' or not isinstance(ref, str) or not VERSION.fullmatch(ref):
        raise ValueError('untrusted repository, event or version tag')
    if not all(isinstance(x, str) and SHA.fullmatch(x) for x in (event_sha, tag_sha, checkout_sha)):
        raise ValueError('invalid commit identity')
    if event_sha != tag_sha or tag_sha != checkout_sha or ancestor_of_main is not True:
        raise ValueError('event, tag and checkout must identify a commit on main')


def verify_reference_evidence(repository, event, ref, event_sha, checkout_sha, get):
    """Resolve a tag and protected-main ancestry from a trusted GitHub client."""
    if repository != REPOSITORY or event != 'push' or not isinstance(ref, str) or not VERSION.fullmatch(ref):
        raise ValueError('untrusted repository, event or version tag')
    if not all(isinstance(value, str) and SHA.fullmatch(value) for value in (event_sha, checkout_sha)):
        raise ValueError('invalid event or checkout commit')
    tag_path = 'git/ref/tags/' + ref.removeprefix('refs/tags/')
    tag = get(tag_path)
    if not isinstance(tag, dict) or not isinstance(tag.get('object'), dict):
        raise ValueError('invalid tag reference')
    current = tag['object']
    for _ in range(8):
        kind, object_sha = current.get('type'), current.get('sha')
        if not isinstance(object_sha, str) or not SHA.fullmatch(object_sha):
            raise ValueError('invalid tag object')
        if kind == 'commit':
            break
        if kind != 'tag':
            raise ValueError('tag does not resolve to a commit')
        annotated = get(f'git/tags/{object_sha}')
        if not isinstance(annotated, dict) or annotated.get('sha') != object_sha or not isinstance(annotated.get('object'), dict):
            raise ValueError('invalid annotated tag')
        current = annotated['object']
    else:
        raise ValueError('tag nesting limit exceeded')
    main = get('git/ref/heads/main')
    main_object = main.get('object') if isinstance(main, dict) else None
    if not isinstance(main_object, dict) or main_object.get('type') != 'commit' or not isinstance(main_object.get('sha'), str) or not SHA.fullmatch(main_object['sha']):
        raise ValueError('invalid main ref')
    comparison = get(f'compare/{event_sha}...{main_object["sha"]}')
    ancestor = (isinstance(comparison, dict) and comparison.get('status') in ('ahead', 'identical') and
                isinstance(comparison.get('merge_base_commit'), dict) and comparison['merge_base_commit'].get('sha') == event_sha)
    validate_event(repository, event, ref, event_sha, object_sha, checkout_sha, ancestor)
    if get(tag_path) != tag or get('git/ref/heads/main') != main:
        raise ValueError('tag or main moved during admission')


def validate_workflow_run(run, sha, run_id, workflow_id):
    if not isinstance(run, dict) or not SHA.fullmatch(sha) or type(run_id) is not int or type(workflow_id) is not int or run_id <= 0 or workflow_id <= 0:
        raise ValueError('invalid workflow identity')
    if (run.get('id') != run_id or run.get('workflow_id') != workflow_id or
            run.get('event') != 'push' or run.get('head_branch') != 'main' or
            run.get('head_sha') != sha or run.get('status') != 'completed' or
            run.get('conclusion') != 'success' or
            not isinstance(run.get('repository'), dict) or run['repository'].get('full_name') != REPOSITORY or
            not isinstance(run.get('head_repository'), dict) or run['head_repository'].get('full_name') != REPOSITORY):
        raise ValueError('workflow run is not an approved successful main push')


def verify_check_evidence(runs, sha, policy, get):
    """Cross-check approved check runs against GitHub job and workflow data.

    `get` must query the trusted repository independently; callers are responsible
    for retrieving the complete check-run list and preventing redirects/forgery.
    """
    if not isinstance(policy, dict) or not policy:
        raise ValueError('empty workflow policy')
    try:
        apps = {name: values[0] for name, values in policy.items()}
        if any(len(values) != 2 or type(values[1]) is not int or values[1] <= 0 for values in policy.values()):
            raise ValueError('invalid workflow policy')
    except (TypeError, IndexError):
        raise ValueError('invalid workflow policy') from None
    validate_checks(runs, sha, apps)
    pattern = re.compile(r'https://github\.com/SquashMerge/glasshouse/actions/runs/([1-9][0-9]*)/job/([1-9][0-9]*)\Z')
    for name, (_, workflow_id) in policy.items():
        check = next(item for item in runs if item.get('name') == name)
        url = check.get('details_url')
        match = pattern.fullmatch(url) if isinstance(url, str) else None
        if not match:
            raise ValueError('untrusted check details URL')
        run_id, job_id = map(int, match.groups())
        if type(check.get('id')) is not int or check['id'] != job_id:
            raise ValueError('check and job identities differ')
        job = get(f'actions/jobs/{job_id}')
        if (not isinstance(job, dict) or job.get('id') != job_id or job.get('run_id') != run_id or
                job.get('name') != name or job.get('head_sha') != sha or job.get('status') != 'completed' or
                job.get('conclusion') != 'success' or job.get('check_run_url') !=
                f'https://api.github.com/repos/{REPOSITORY}/check-runs/{job_id}'):
            raise ValueError('job identity or result mismatch')
        validate_workflow_run(get(f'actions/runs/{run_id}'), sha, run_id, workflow_id)


def validate_checks(runs, sha, approved):
    """Require one successful exact-SHA run per name, from its approved app.

    A caller must additionally verify each run's workflow ID, event, branch,
    source repository and complete pagination. This function deliberately cannot
    infer those facts from a check name or app ID.
    """
    if not isinstance(sha, str) or not SHA.fullmatch(sha) or not isinstance(approved, dict) or not approved:
        raise ValueError('invalid SHA or empty check policy')
    if any(not isinstance(name, str) or not name or type(app_id) is not int or app_id <= 0 for name, app_id in approved.items()):
        raise ValueError('invalid check policy')
    if not isinstance(runs, list):
        raise ValueError('invalid check list')
    for name, app_id in approved.items():
        matches = [run for run in runs if isinstance(run, dict) and run.get('name') == name]
        if len(matches) != 1:
            raise ValueError(f'missing or ambiguous required check: {name}')
        run = matches[0]
        app = run.get('app')
        if (run.get('head_sha') != sha or run.get('status') != 'completed' or
                run.get('conclusion') != 'success' or not isinstance(app, dict) or app.get('id') != app_id):
            raise ValueError(f'required check did not pass on the exact SHA: {name}')
