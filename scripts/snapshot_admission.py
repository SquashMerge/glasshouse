#!/usr/bin/env python3
"""Read-only snapshot gate inventory. This module never builds or publishes images."""
import json
import os
import re
import subprocess
import sys

REPOSITORY = 'SquashMerge/glasshouse'
SHA = re.compile(r'^[0-9a-f]{40}$')
WORKFLOWS = {
    'CI': ('.github/workflows/ci.yml', {
        'lint', 'format', 'typecheck', 'test', 'supply-chain', 'infra-security',
        'worker-test', 'build', 'openapi-artifact', 'compose-paths',
        'backup-restore-safety', 'doctor-version', 'Backup/restore (current)',
        'Security scan', 'ClickHouse schema', 'PostgreSQL migration upgrade',
        'e2e', 'Local first-run browser journey', 'Snapshot safety',
        'Image-only Compose integration', 'Snapshot candidate dry run',
    }),
    'Dependency release age': ('.github/workflows/dependency-release-age.yml',
                               {'Verify newly locked package ages'}),
}


def assess(commits, runs, jobs):
    """Evaluate GitHub API snapshots; a positive result is NOT permission to publish.

    jobs maps (run_id, run_attempt) to the complete API job list for that attempt.
    All runs and jobs must be fetched through authenticated, paginated API calls.
    """
    result = []
    for sha in commits:
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError('invalid commit SHA')
        reasons, evidence = [], {}
        for name, (path, expected) in WORKFLOWS.items():
            matching = [r for r in runs if r.get('head_sha') == sha
                        and r.get('path') == path and r.get('event') == 'push'
                        and r.get('head_branch') == 'main'
                        and (r.get('repository') or {}).get('full_name') == REPOSITORY
                        and (r.get('head_repository') or {}).get('full_name') == REPOSITORY]
            if not matching:
                reasons.append(f'{name}:missing')
                continue
            if any(type(r.get('id')) is not int or type(r.get('run_attempt')) is not int
                   or r['id'] <= 0 or r['run_attempt'] <= 0 for r in matching):
                reasons.append(f'{name}:invalid-run')
                continue
            run = max(matching, key=lambda r: r['id'])
            key = (run['id'], run['run_attempt'])
            evidence[name] = {'run_id': key[0], 'attempt': key[1]}
            if run.get('status') != 'completed' or run.get('conclusion') != 'success':
                reasons.append(f'{name}:run-not-successful')
                continue
            attempt_jobs = jobs.get(key)
            if not isinstance(attempt_jobs, list):
                reasons.append(f'{name}:jobs-unavailable')
                continue
            names = [j.get('name') for j in attempt_jobs]
            if len(names) != len(expected) or set(names) != expected:
                reasons.append(f'{name}:job-set-mismatch')
                continue
            if any(j.get('status') != 'completed' or j.get('conclusion') != 'success'
                   or j.get('run_id') != key[0] or j.get('run_attempt') != key[1]
                   or j.get('head_sha') != sha for j in attempt_jobs):
                reasons.append(f'{name}:job-not-successful-or-mismatched')
        result.append({'sha': sha, 'state': 'blocked' if reasons else 'gates-passed',
                       'reasons': reasons, 'evidence': evidence})
    return result


API_CALLS = 0
API_BUDGET = 400


def gh_pages(endpoint, key):
    global API_CALLS
    items, expected = [], None
    for page in range(1, 101):
        if API_CALLS >= API_BUDGET:
            raise ValueError('GitHub API budget exhausted')
        API_CALLS += 1
        separator = '&' if '?' in endpoint else '?'
        raw = subprocess.check_output(['gh', 'api', '--hostname', 'github.com',
                                       f'{endpoint}{separator}page={page}'], text=True)
        result = json.loads(raw)
        if (not isinstance(result, dict) or not isinstance(result.get(key), list)
                or type(result.get('total_count')) is not int or result['total_count'] < 0):
            raise ValueError('invalid API response')
        if expected is None:
            expected = result['total_count']
        if result['total_count'] != expected:
            raise ValueError('changing API result')
        entries = result[key]
        items.extend(entries)
        if len(items) == expected:
            return items
        if not entries or len(items) > expected:
            raise ValueError('incomplete API result')
    raise ValueError('API pagination limit exceeded')


def fresh_main_history():
    """Refresh the configured authoritative origin; never fall back to cached refs."""
    env = os.environ.copy()
    env['GIT_TERMINAL_PROMPT'] = '0'
    subprocess.run(['git', 'fetch', '--force', '--no-tags', 'origin',
                    '+refs/heads/main:refs/remotes/origin/main'], check=True, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return subprocess.check_output(
        ['git', 'rev-list', '--first-parent', 'refs/remotes/origin/main'], text=True).splitlines()


def verify_fresh_main(sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise ValueError('SHA must be a full lowercase commit SHA')
    if sha not in fresh_main_history():
        raise ValueError('SHA is not on the main first-parent chain')


def admit_exact(sha):
    verify_fresh_main(sha)
    return collect([sha])[0]


def collect(commits):
    runs, jobs = [], {}
    for sha in commits:
        for path, _ in WORKFLOWS.values():
            workflow = path.rsplit('/', 1)[-1]
            endpoint = f'repos/{REPOSITORY}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100'
            found = gh_pages(endpoint, 'workflow_runs')
            runs.extend(found)
            matching = [run for run in found if run.get('head_sha') == sha and run.get('path') == path
                        and run.get('event') == 'push' and run.get('head_branch') == 'main'
                        and (run.get('repository') or {}).get('full_name') == REPOSITORY
                        and (run.get('head_repository') or {}).get('full_name') == REPOSITORY]
            if matching and all(type(run.get('id')) is int and run['id'] > 0
                                and type(run.get('run_attempt')) is int and run['run_attempt'] > 0
                                for run in matching):
                run = max(matching, key=lambda item: item['id'])
                if run.get('status') == 'completed' and run.get('conclusion') == 'success':
                    run_id, attempt = run['id'], run['run_attempt']
                    jobs[(run_id, attempt)] = gh_pages(
                        f'repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100', 'jobs')
    return assess(commits, runs, jobs)


def inventory(anchor):
    if not SHA.fullmatch(anchor):
        raise ValueError('anchor must be a full lowercase commit SHA')
    first_parent = fresh_main_history()
    if anchor not in first_parent:
        raise ValueError('anchor is not on the main first-parent chain')
    return collect(list(reversed(first_parent[:first_parent.index(anchor)])))


def main():
    try:
        anchor = os.environ.get('SNAPSHOT_ANCHOR', '')
        report = inventory(anchor)
        print(json.dumps({'anchor_exclusive': anchor, 'publication': 'disabled',
                          'revisions': report}, indent=2))
        if any(row['state'] == 'blocked' for row in report):
            return 1
        return 0
    except (ValueError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        print(f'snapshot inventory failed closed: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
