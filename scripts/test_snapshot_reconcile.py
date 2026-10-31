import unittest

import snapshot_reconcile as r


def sha(n):
    return f'{n:040x}'


class ReconciliationTests(unittest.TestCase):
    def test_bounded_batches_revisit_pending_and_process_new_revisions(self):
        anchor = sha(0)
        history = [sha(n) for n in range(1, 302)]
        state = r.initial(anchor)
        calls = []
        saved = []
        def publish(revision):
            calls.append(revision)
            return revision != sha(1)
        for _ in range(70):
            state = r.reconcile(state, anchor, list(reversed([anchor] + history)),
                                publish, lambda value: saved.append(value.copy()), batch=10)
        self.assertEqual(state['cursor'], history[-1])
        self.assertEqual(state['pending'], [sha(1)])
        self.assertTrue(all(sha(n) in calls for n in range(1, 302)))
        self.assertLessEqual(len(calls), 400)
        self.assertGreater(len(saved), 0)

    def test_failed_checkpoint_write_never_processes_unrecorded_revisions(self):
        anchor = sha(0)
        seen = []
        with self.assertRaises(OSError):
            r.reconcile(r.initial(anchor), anchor, [sha(2), sha(1), anchor],
                        lambda revision: seen.append(revision),
                        lambda state: (_ for _ in ()).throw(OSError('write failed')))
        self.assertEqual(seen, [])

    def test_multi_commit_backlog_with_missing_runs_and_appended_revisions(self):
        from unittest.mock import patch
        import snapshot_admission as a
        from test_snapshot_admission import fixture
        import json
        import re
        anchor = sha(0)
        revisions = [sha(n) for n in range(1, 302)]
        state = r.initial(anchor)
        complete = set()
        missing = {sha(1)}
        calls_per_run = []
        def api(command, **kwargs):
            endpoint = command[-1]
            if '/workflows/' in endpoint:
                revision = re.search(r'head_sha=([0-9a-f]{40})', endpoint)[1]
                workflow = endpoint.split('/workflows/')[1].split('/')[0]
                runs, _ = fixture(revision)
                found = [run for run in runs if run['path'].endswith(workflow)] if revision not in missing else []
                return json.dumps({'total_count': len(found), 'workflow_runs': found})
            run_id = int(endpoint.split('/runs/')[1].split('/')[0])
            revision = active[0]
            _, jobs = fixture(revision)
            values = jobs[(run_id, 1)]
            return json.dumps({'total_count': len(values), 'jobs': values})
        active = ['']
        def publish(revision):
            if revision in complete:
                return True
            active[0] = revision
            if a.admit_exact(revision)['state'] != 'gates-passed':
                return False
            complete.add(revision)
            return True
        with patch.object(a.subprocess, 'check_output', side_effect=api), \
             patch.object(a, 'verify_fresh_main'):
            for tick in range(75):
                if tick == 10:
                    revisions.extend([sha(302), sha(303)])
                if tick == 66:
                    missing.clear()
                a.API_CALLS = 0
                state = r.reconcile(state, anchor, list(reversed([anchor] + revisions)),
                                    publish, lambda _: None, batch=10)
                calls_per_run.append(a.API_CALLS)
        self.assertEqual(complete, set(revisions))
        self.assertEqual(state['pending'], [])
        self.assertEqual(state['cursor'], revisions[-1])
        self.assertLessEqual(max(calls_per_run), 400)
        self.assertGreater(sum(calls_per_run), 1000)

    def test_checkpoint_must_cover_cursor_and_pending(self):
        anchor = sha(0)
        for state in (None, {'version': 1, 'anchor': anchor, 'cursor': sha(9), 'pending': []},
                      {'version': 1, 'anchor': anchor, 'cursor': sha(1), 'pending': [sha(2)]}):
            with self.assertRaises(ValueError):
                r.reconcile(state, anchor, [sha(2), sha(1), anchor], lambda _: True, lambda _: None)
