import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/scripts/validate-release-tag.sh"


class ReleaseTagTest(unittest.TestCase):
    def test_version_tags_are_accepted(self):
        for tag in ("v1.2.3", "v0.12.345", "v1.2.3-rc.1"):
            with self.subTest(tag=tag):
                result = subprocess.run(["bash", str(SCRIPT), tag], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_non_version_and_shell_metacharacter_tags_are_rejected(self):
        for tag in ("", "main", "v1.2", "v1.2.3/other", "v1.2.3;echo bad", "v1.2.3\nother", "-v1.2.3"):
            with self.subTest(tag=tag):
                result = subprocess.run(["bash", str(SCRIPT), tag], capture_output=True)
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
