import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

import snapshot_candidate as candidate


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'source').write_text('committed')
        self.git('add', 'source')
        self.git('commit', '-qm', 'first')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.sha)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def test_archives_exact_main_revision_without_dirty_or_untracked_files(self):
        (self.repo / 'source').write_text('dirty')
        (self.repo / 'secret').write_text('untracked')
        archive = candidate.source_archive(self.repo, self.sha)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as tar:
            self.assertEqual(tar.getnames(), ['source'])
            self.assertEqual(tar.extractfile('source').read(), b'committed')

    def test_ci_archive_requires_exact_checked_out_commit_not_main(self):
        self.git('checkout', '-qb', 'side')
        (self.repo / 'source').write_text('candidate')
        self.git('commit', '-qam', 'candidate')
        head = self.git('rev-parse', 'HEAD').strip()
        (self.repo / 'source').write_text('dirty')
        archive = candidate.checked_out_archive(self.repo, head)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as tar:
            self.assertEqual(tar.extractfile('source').read(), b'candidate')
        for bad in (self.sha, head[:12], 'HEAD'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                candidate.checked_out_archive(self.repo, bad)
        with self.assertRaises(ValueError):
            candidate.source_archive(self.repo, head)

    def test_rejects_non_first_parent_and_noncanonical_sha(self):
        self.git('checkout', '-qb', 'side')
        (self.repo / 'source').write_text('side')
        self.git('commit', '-qam', 'side')
        side = self.git('rev-parse', 'HEAD').strip()
        for value in (side, self.sha[:12], self.sha.upper(), '--help'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                candidate.source_archive(self.repo, value)


if __name__ == '__main__':
    unittest.main()
