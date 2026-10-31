import copy
import json
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from snapshot_admission import REPOSITORY, WORKFLOWS, assess, gh_pages, inventory

SHA = 'a' * 40
OTHER = 'b' * 40


def fixture(sha=SHA):
    runs, jobs = [], {}
    for run_id, (_, (path, names)) in enumerate(WORKFLOWS.items(), 101):
        run = {'id': run_id, 'run_attempt': 1, 'path': path, 'head_sha': sha,
               'event': 'push', 'head_branch': 'main', 'status': 'completed',
               'conclusion': 'success', 'repository': {'full_name': REPOSITORY},
               'head_repository': {'full_name': REPOSITORY}}
        runs.append(run)
        jobs[(run_id, 1)] = [dict(name=name, run_id=run_id, run_attempt=1,
                                   head_sha=sha, status='completed', conclusion='success')
                             for name in sorted(names)]
    return runs, jobs


class AdmissionTests(unittest.TestCase):
    def test_updated_ci_contract_accepts_exact_set_and_rejects_extra_or_missing(self):
        expected = {
            'lint', 'format', 'typecheck', 'test', 'supply-chain', 'infra-security',
            'worker-test', 'build', 'openapi-artifact', 'compose-paths',
            'backup-restore-safety', 'doctor-version', 'Backup/restore (current)',
            'Security scan', 'ClickHouse schema', 'PostgreSQL migration upgrade',
            'e2e', 'Local first-run browser journey', 'Snapshot safety',
            'Image-only Compose integration',
        }
        runs, jobs = fixture()
        template = jobs[(101, 1)][0]
        jobs[(101, 1)] = [dict(template, name=name) for name in sorted(expected)]
        self.assertEqual(assess([SHA], runs, jobs)[0]['state'], 'gates-passed')
        for change in ('extra', 'missing'):
            with self.subTest(change=change):
                altered = copy.deepcopy(jobs)
                if change == 'extra':
                    altered[(101, 1)].append(dict(template, name='Snapshot candidate dry run'))
                else:
                    altered[(101, 1)].pop()
                result = assess([SHA], runs, altered)[0]
                self.assertEqual(result['state'], 'blocked')
                self.assertIn('CI:job-set-mismatch', result['reasons'])

    def test_ci_retains_existing_security_gates_without_candidate_dry_run(self):
        ci = Path('.github/workflows/ci.yml').read_text()
        self.assertNotIn('  snapshot-candidate-dry-run:', ci)
        self.assertIn('  image-compose-integration:', ci)
        job = ci.split('  image-compose-integration:', 1)[1].split('\n  snapshot-safety:', 1)[0]
        self.assertIn('timeout-minutes: 40', job)
        self.assertIn('test-image-compose-integration.sh', job)
        self.assertIn('scan-type: fs', ci)
        self.assertIn('test_snapshot*.py', ci)

    def test_image_only_compose_job_is_required_for_admission(self):
        self.assertIn("Image-only Compose integration", WORKFLOWS["CI"][1])

    def test_ci_runs_snapshot_regressions_as_an_admission_gate(self):
        from pathlib import Path
        ci = Path('.github/workflows/ci.yml').read_text()
        self.assertIn('name: Snapshot safety', ci)
        self.assertIn('test_snapshot*.py', ci)
        self.assertIn('Snapshot safety', WORKFLOWS['CI'][1])

    def setUp(self):
        self.runs, self.jobs = fixture()

    def state(self):
        return assess([SHA], self.runs, self.jobs)[0]

    def test_missing_gates_are_reported_not_admitted(self):
        result = assess([SHA], [], {})[0]
        self.assertEqual(result['state'], 'blocked')
        self.assertEqual(result['reasons'], ['CI:missing', 'Dependency release age:missing'])

    def test_full_exact_sha_attempt_is_only_gate_pass(self):
        result = self.state()
        self.assertEqual(result['state'], 'gates-passed')
        self.assertEqual(result['evidence']['CI'], {'run_id': 101, 'attempt': 1})

    def test_untrusted_or_other_sha_runs_do_not_count(self):
        for field, value in [('event', 'pull_request'), ('event', 'workflow_dispatch'),
                             ('head_branch', 'feature'), ('head_sha', OTHER),
                             ('head_repository', {'full_name': 'fork/glasshouse'}),
                             ('repository', {'full_name': 'fork/glasshouse'}),
                             ('path', '.github/workflows/other.yml')]:
            with self.subTest(field=field, value=value):
                runs, jobs = fixture()
                runs[0][field] = value
                self.assertIn('CI:missing', assess([SHA], runs, jobs)[0]['reasons'])

    def test_run_conclusion_and_status_fail_closed(self):
        for field, value in [('conclusion', 'cancelled'), ('conclusion', 'failure'),
                             ('conclusion', 'skipped'), ('conclusion', None),
                             ('status', 'in_progress')]:
            with self.subTest(field=field, value=value):
                runs, jobs = fixture()
                runs[0][field] = value
                self.assertIn('CI:run-not-successful', assess([SHA], runs, jobs)[0]['reasons'])

    def test_missing_extra_duplicate_or_unsuccessful_jobs_block(self):
        for change in ('missing', 'duplicate', 'failed', 'cancelled', 'other_sha', 'other_attempt', 'other_run'):
            with self.subTest(change=change):
                runs, jobs = fixture()
                entries = jobs[(101, 1)]
                if change == 'missing': entries.pop()
                elif change == 'duplicate': entries[-1] = copy.deepcopy(entries[0])
                elif change == 'failed': entries[0]['conclusion'] = 'failure'
                elif change == 'cancelled': entries[0]['conclusion'] = 'cancelled'
                elif change == 'other_sha': entries[0]['head_sha'] = OTHER
                elif change == 'other_attempt': entries[0]['run_attempt'] = 2
                else: entries[0]['run_id'] = 999
                self.assertEqual(assess([SHA], runs, jobs)[0]['state'], 'blocked')

    def test_missing_attempt_does_not_reuse_older_attempt(self):
        self.runs[0]['run_attempt'] = 2
        self.assertIn('CI:jobs-unavailable', self.state()['reasons'])

    def test_newer_run_failure_blocks_old_success(self):
        newer = dict(self.runs[0], id=103, conclusion='cancelled')
        self.runs.append(newer)
        self.assertIn('CI:run-not-successful', self.state()['reasons'])

    def test_invalid_run_identity_blocks(self):
        self.runs[0]['run_attempt'] = True
        self.assertIn('CI:invalid-run', self.state()['reasons'])

    def test_invalid_commit_rejected(self):
        for sha in ('a' * 39, 'A' * 40, 'HEAD', ''):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                assess([sha], [], {})

    def test_multiple_push_revisions_each_reported(self):
        runs, jobs = fixture()
        rows = assess([OTHER, SHA], runs, jobs)
        self.assertEqual([(x['sha'], x['state']) for x in rows],
                         [(OTHER, 'blocked'), (SHA, 'gates-passed')])


class InventoryTests(unittest.TestCase):
    def test_force_push_after_checkout_revokes_exact_admission(self):
        from snapshot_admission import admit_exact
        import os
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            remote, writer, checkout = base / 'remote.git', base / 'writer', base / 'checkout'
            def git(*args, cwd=base):
                return subprocess.check_output(['git', *map(str, args)], cwd=cwd, text=True, stderr=subprocess.PIPE).strip()
            git('init', '--bare', remote)
            git('init', '-b', 'main', writer)
            git('config', 'user.email', 'test@example.invalid', cwd=writer)
            git('config', 'user.name', 'Test', cwd=writer)
            (writer / 'file').write_text('first')
            git('add', 'file', cwd=writer)
            git('commit', '-m', 'first', cwd=writer)
            first = git('rev-parse', 'HEAD', cwd=writer)
            git('remote', 'add', 'origin', remote, cwd=writer)
            git('push', 'origin', 'main', cwd=writer)
            git('clone', '--branch', 'main', remote, checkout)
            (writer / 'file').write_text('second')
            git('commit', '-am', 'second', cwd=writer)
            second = git('rev-parse', 'HEAD', cwd=writer)
            git('push', 'origin', 'main', cwd=writer)
            oldcwd = os.getcwd()
            try:
                os.chdir(checkout)
                with patch('snapshot_admission.collect', side_effect=lambda shas: [{'sha': shas[0], 'state': 'gates-passed'}]):
                    self.assertEqual(admit_exact(second)['sha'], second)
                    git('push', '--force', 'origin', f'{first}:refs/heads/main', cwd=writer)
                    with self.assertRaisesRegex(ValueError, 'first-parent'):
                        admit_exact(second)
                    remote.rename(base / 'unavailable.git')
                    with self.assertRaises(subprocess.CalledProcessError):
                        admit_exact(first)
            finally:
                os.chdir(oldcwd)

    def test_collect_fetches_jobs_only_for_latest_trusted_push(self):
        from snapshot_admission import collect
        runs, jobs = fixture()
        older = dict(runs[0], id=99)
        untrusted = dict(runs[0], id=999, event='pull_request')
        def pages(endpoint, key):
            if key == 'workflow_runs':
                if 'ci.yml' in endpoint:
                    return [older, runs[0], untrusted]
                return [runs[1]]
            run_id = int(endpoint.split('/runs/')[1].split('/')[0])
            return jobs[(run_id, 1)]
        with patch('snapshot_admission.gh_pages', side_effect=pages) as call:
            self.assertEqual(collect([SHA])[0]['state'], 'gates-passed')
        endpoints = [item.args[0] for item in call.call_args_list]
        self.assertEqual(len(endpoints), 4)
        self.assertFalse(any('/runs/99/' in endpoint or '/runs/999/' in endpoint for endpoint in endpoints))

    def test_collect_never_fetches_jobs_for_mismatched_runs(self):
        from snapshot_admission import collect
        for field, value in [('head_sha', OTHER), ('path', '.github/workflows/other.yml'),
                             ('event', 'pull_request'), ('head_branch', 'feature'),
                             ('repository', {'full_name': 'fork/glasshouse'}),
                             ('head_repository', {'full_name': 'fork/glasshouse'})]:
            with self.subTest(field=field):
                runs, jobs = fixture()
                bad = dict(runs[0], id=999, **{field: value})
                def pages(endpoint, key):
                    if key == 'workflow_runs':
                        return [bad, runs[0]] if 'ci.yml' in endpoint else [runs[1]]
                    return jobs[(int(endpoint.split('/runs/')[1].split('/')[0]), 1)]
                with patch('snapshot_admission.gh_pages', side_effect=pages) as calls:
                    self.assertEqual(collect([SHA])[0]['state'], 'gates-passed')
                self.assertFalse(any('/runs/999/' in call.args[0] for call in calls.call_args_list))

    def test_exact_sha_requires_first_parent_and_both_live_workflows(self):
        from snapshot_admission import admit_exact
        runs, jobs = fixture()
        def pages(endpoint, key):
            if key == 'workflow_runs':
                return [r for r in runs if r['path'].endswith(endpoint.split('/workflows/')[1].split('/')[0])]
            if '/101/' in endpoint:
                return jobs[(101, 1)]
            return jobs[(102, 1)]
        with patch('snapshot_admission.fresh_main_history', return_value=[SHA, OTHER]), \
             patch('snapshot_admission.gh_pages', side_effect=pages):
            self.assertEqual(admit_exact(SHA)['state'], 'gates-passed')
            with self.assertRaises(ValueError):
                admit_exact('c' * 40)

    def test_pagination_budget_stops_before_github_limit(self):
        import snapshot_admission as a
        with patch.object(a, 'API_CALLS', 399), \
             patch.object(a.subprocess, 'check_output',
                          return_value=json.dumps({'total_count': 101, 'jobs': list(range(100))})) as call:
            with self.assertRaisesRegex(ValueError, 'budget'):
                a.gh_pages('unused?per_page=100', 'jobs')
            self.assertEqual(call.call_count, 1)

    def test_paginated_collection_refuses_truncated_response(self):
        with patch('snapshot_admission.subprocess.check_output',
                   side_effect=[json.dumps({'total_count': 2, 'jobs': [{}]}),
                                json.dumps({'total_count': 2, 'jobs': []})]):
            with self.assertRaises(ValueError):
                gh_pages('unused', 'jobs')

    def test_paginated_collection_uses_all_pages(self):
        with patch('snapshot_admission.subprocess.check_output',
                   side_effect=[json.dumps({'total_count': 2, 'jobs': [1]}),
                                json.dumps({'total_count': 2, 'jobs': [2]})]):
            self.assertEqual(gh_pages('unused', 'jobs'), [1, 2])

    def test_full_chain_inventory_and_offline_missing_runs(self):
        anchor = 'c' * 40
        with patch('snapshot_admission.fresh_main_history', return_value=[SHA, OTHER, anchor]), \
             patch('snapshot_admission.gh_pages', return_value=[]) as pages:
            rows = inventory(anchor)
        self.assertEqual([row['sha'] for row in rows], [OTHER, SHA])
        self.assertEqual(pages.call_count, 4)
        self.assertTrue(all(row['state'] == 'blocked' for row in rows))

    def test_missing_anchor_refuses_incomplete_chain(self):
        with patch('snapshot_admission.fresh_main_history', return_value=[SHA]):
            with self.assertRaises(ValueError):
                inventory(OTHER)

    def test_api_errors_propagate(self):
        with patch('snapshot_admission.subprocess.check_output',
                   side_effect=subprocess.CalledProcessError(1, 'gh')):
            with self.assertRaises(subprocess.CalledProcessError):
                gh_pages('unused', 'jobs')


if __name__ == '__main__':
    unittest.main()
