import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('release_admission', ROOT / 'infra/scripts/release-admission.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

SHA = 'a' * 40
OTHER = 'b' * 40
CHECKS = {'candidate': 15368, 'e2e': 15368}


def run(name, **changes):
    value = {'name': name, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success', 'app': {'id': 15368}}
    value.update(changes)
    return value


class ReleaseAdmissionTests(unittest.TestCase):
    def test_accepts_only_expected_push_tag_and_exact_successful_checks(self):
        release.validate_event('SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3-rc.1', SHA, SHA, SHA, True)
        release.validate_checks([run('candidate'), run('e2e')], SHA, CHECKS)

    def test_rejects_untrusted_event_tag_head_and_ancestry(self):
        values = ['SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3', SHA, SHA, SHA, True]
        for position, invalid in ((0, 'other/glasshouse'), (1, 'workflow_dispatch'), (1, 'pull_request'),
                                  (2, 'refs/tags/v01.2.3'), (2, 'refs/heads/v1.2.3'),
                                  (3, OTHER), (4, OTHER), (5, OTHER), (6, False)):
            args = values.copy()
            args[position] = invalid
            with self.subTest(position=position, invalid=invalid), self.assertRaises(ValueError):
                release.validate_event(*args)

    def test_rejects_missing_wrong_sha_failed_pending_spoofed_and_duplicate_checks(self):
        for checks in ([run('candidate')], [run('candidate'), run('e2e', head_sha=OTHER)],
                       [run('candidate'), run('e2e', status='in_progress', conclusion=None)],
                       [run('candidate'), run('e2e', conclusion='failure')],
                       [run('candidate'), run('e2e', app={'id': 1})],
                       [run('candidate'), run('candidate'), run('e2e')]):
            with self.subTest(checks=checks), self.assertRaises(ValueError):
                release.validate_checks(checks, SHA, CHECKS)

    def test_requires_matching_main_push_workflow_run_from_trusted_repo(self):
        trusted = {'id': 42, 'workflow_id': 99, 'event': 'push', 'head_branch': 'main',
                   'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                   'repository': {'full_name': 'SquashMerge/glasshouse'},
                   'head_repository': {'full_name': 'SquashMerge/glasshouse'}}
        release.validate_workflow_run(trusted, SHA, 42, 99)
        for key, value in (('id', 43), ('workflow_id', 100), ('event', 'pull_request'),
                           ('head_branch', 'elsewhere'), ('head_sha', OTHER), ('status', 'queued'),
                           ('conclusion', 'failure'), ('repository', {'full_name': 'evil/repo'}),
                           ('head_repository', {'full_name': 'evil/repo'})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.validate_workflow_run({**trusted, key: value}, SHA, 42, 99)

    def test_independently_resolves_annotated_tag_and_main_ancestry(self):
        tag_object = 'c' * 40
        objects = {
            'git/ref/tags/v1.2.3': {'object': {'type': 'tag', 'sha': tag_object}},
            f'git/tags/{tag_object}': {'sha': tag_object, 'object': {'type': 'commit', 'sha': SHA}},
            'git/ref/heads/main': {'object': {'type': 'commit', 'sha': OTHER}},
            f'compare/{SHA}...{OTHER}': {'status': 'ahead', 'merge_base_commit': {'sha': SHA}},
        }
        release.verify_reference_evidence('SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3', SHA, SHA, objects.__getitem__)
        objects[f'compare/{SHA}...{OTHER}']['merge_base_commit']['sha'] = OTHER
        with self.assertRaises(ValueError):
            release.verify_reference_evidence('SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3', SHA, SHA, objects.__getitem__)
        objects[f'compare/{SHA}...{OTHER}']['merge_base_commit']['sha'] = SHA
        objects[f'git/tags/{tag_object}']['object']['type'] = 'tree'
        with self.assertRaises(ValueError):
            release.verify_reference_evidence('SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3', SHA, SHA, objects.__getitem__)
        objects[f'git/tags/{tag_object}']['object']['type'] = 'commit'
        counts = {}
        def moving(path):
            counts[path] = counts.get(path, 0) + 1
            if path == 'git/ref/tags/v1.2.3' and counts[path] > 1:
                return {'object': {'type': 'commit', 'sha': OTHER}}
            return objects[path]
        with self.assertRaises(ValueError):
            release.verify_reference_evidence('SquashMerge/glasshouse', 'push', 'refs/tags/v1.2.3', SHA, SHA, moving)

    def test_check_evidence_resolves_job_and_workflow_identity(self):
        check = run('e2e', id=7, details_url='https://github.com/SquashMerge/glasshouse/actions/runs/42/job/7')
        job = {'id': 7, 'run_id': 42, 'name': 'e2e', 'head_sha': SHA, 'status': 'completed',
               'conclusion': 'success', 'check_run_url': 'https://api.github.com/repos/SquashMerge/glasshouse/check-runs/7'}
        workflow = {'id': 42, 'workflow_id': 99, 'event': 'push', 'head_branch': 'main',
                    'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
                    'repository': {'full_name': 'SquashMerge/glasshouse'},
                    'head_repository': {'full_name': 'SquashMerge/glasshouse'}}
        objects = {'actions/jobs/7': job, 'actions/runs/42': workflow}
        release.verify_check_evidence([check], SHA, {'e2e': (15368, 99)}, objects.__getitem__)
        for modified in ({**check, 'details_url': 'https://evil.test/actions/runs/42/job/7'},
                         {**check, 'id': 8}):
            with self.subTest(modified=modified), self.assertRaises(ValueError):
                release.verify_check_evidence([modified], SHA, {'e2e': (15368, 99)}, objects.__getitem__)
        with self.assertRaises(ValueError):
            release.verify_check_evidence([check], SHA, {'e2e': (15368, 100)}, objects.__getitem__)

    def test_rejects_empty_policy(self):
        with self.assertRaises(ValueError):
            release.validate_checks([], SHA, {})


if __name__ == '__main__':
    unittest.main()
