import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra/scripts/test-release-image.sh"


class ReleaseImageHarnessTest(unittest.TestCase):
    def test_requires_an_archive(self):
        result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("image archive is required", result.stderr)

    def test_rejects_missing_archive_before_starting_services(self):
        result = subprocess.run(["bash", str(SCRIPT), "/not-present/glasshouse.tar.gz", "bundle.tar.gz", "glasshouse:test"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive not found", result.stderr)

    def test_loads_the_exact_compressed_image_archive(self):
        source = SCRIPT.read_text()
        self.assertIn('gzip -dc -- "$archive" | docker load', source)
        self.assertIn('sha256sum "$archive"', source)


if __name__ == "__main__":
    unittest.main()
