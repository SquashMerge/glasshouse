#!/usr/bin/env python3
"""Produce a tracked archive of a revision on the local main first-parent chain.

The caller must independently refresh and authenticate the main ref and gates.
"""
import re
import subprocess

SHA = re.compile(r'[0-9a-f]{40}\Z')


def _sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError('expected a full lowercase git SHA-1')
    return value


def checked_out_archive(repo, sha):
    """CI only: archive the exact checked-out commit, never a caller-selected ref."""
    _sha(sha)
    try:
        head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                                       stderr=subprocess.PIPE, text=True).strip()
        if head != sha:
            raise ValueError('expected SHA does not match checked-out HEAD')
        return subprocess.check_output(['git', '-C', str(repo), 'archive', '--format=tar', sha],
                                       stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        raise ValueError('cannot read checked-out commit or archive') from exc


def source_archive(repo, sha):
    """Read only tracked contents of an exact revision on the local main first-parent chain."""
    _sha(sha)
    repo = str(repo)
    try:
        history = subprocess.check_output(
            ['git', '-C', repo, 'rev-list', '--first-parent', 'refs/remotes/origin/main'],
            stderr=subprocess.PIPE, text=True,
        ).splitlines()
        if sha not in history:
            raise ValueError('revision is not on local origin/main first-parent history')
        return subprocess.check_output(['git', '-C', repo, 'archive', '--format=tar', sha], stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        raise ValueError('cannot read source history or archive') from exc
