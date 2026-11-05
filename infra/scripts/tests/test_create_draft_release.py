import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/scripts/create-draft-release.sh"


class CreateDraftReleaseTest(unittest.TestCase):
    def run_script(self, api_mode):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            bin_dir = directory / "bin"
            bin_dir.mkdir()
            calls = directory / "calls"
            fake_gh = bin_dir / "gh"
            fake_gh.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "printf '%s\\n' \"$*\" >> \"$GH_CALLS\"\n"
                "if [[ \"$1\" == api ]]; then\n"
                "  case \"$GH_API_MODE\" in\n"
                "    draft|published) printf 'v1.2.3\\n' ;;\n"
                "    error) exit 1 ;;\n"
                "  esac\n"
                "fi\n"
            )
            fake_gh.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "GH_CALLS": str(calls),
                "GH_API_MODE": api_mode,
                "GH_REPO": "dsarlo/astraea",
            }
            result = subprocess.run(
                ["bash", str(SCRIPT), "v1.2.3"],
                cwd=directory,
                env=environment,
                capture_output=True,
                text=True,
            )
            return result, calls.read_text() if calls.exists() else ""

    def test_paginated_existing_draft_or_published_release_prevents_create(self):
        for release_state in ("draft", "published"):
            with self.subTest(release_state=release_state):
                result, calls = self.run_script(release_state)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("already exists", result.stderr)
                self.assertIn("api --paginate", calls)
                self.assertNotIn("release create", calls)

    def test_release_lookup_api_error_fails_closed(self):
        result, calls = self.run_script("error")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("api --paginate", calls)
        self.assertNotIn("release create", calls)

    def test_absent_release_creates_a_draft(self):
        result, calls = self.run_script("absent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release create v1.2.3", calls)

    def test_create_uses_the_compressed_checked_artifacts(self):
        source = SCRIPT.read_text()
        self.assertIn("glasshouse-image.tar.gz", source)
        self.assertIn("--verify-tag --draft --generate-notes", source)


if __name__ == "__main__":
    unittest.main()
