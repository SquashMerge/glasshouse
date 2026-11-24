import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
VERIFIER = ROOT / "infra/scripts/verify-otlp-ci-report.py"
NAMES = [f"API shuts down HTTP and gRPC on {signal}" for signal in ("SIGTERM", "SIGINT")]


class OtlpCiReportTest(unittest.TestCase):
    def verify(self, report):
        return subprocess.run(
            ["python3", str(VERIFIER), "process-shutdown", str(report)],
            capture_output=True, text=True,
        )

    def test_accepts_real_bun_report_and_rejects_real_bun_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            source = directory / "report.test.ts"
            report = directory / "report.xml"
            for skip in (False, True):
                with self.subTest(skip=skip):
                    source.write_text(
                        'import { test } from "bun:test";\n'
                        + f'test("{NAMES[0]}", () => {{}});\n'
                        + f'test{".skip" if skip else ""}("{NAMES[1]}", () => {{}});\n'
                    )
                    result = subprocess.run(
                        ["bun", "--no-env-file", "test", str(source), "--reporter=junit", f"--reporter-outfile={report}"],
                        cwd=directory, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    verified = self.verify(report)
                    self.assertEqual(verified.returncode, 1 if skip else 0, verified.stderr)
                    if skip:
                        self.assertIn("skipped", verified.stderr)

    def test_rejects_duplicate_cases_and_report_level_failures(self):
        cases = "".join(f'<testcase name="{name}"/>' for name in NAMES)
        with tempfile.TemporaryDirectory() as directory:
            report = pathlib.Path(directory) / "report.xml"
            for xml in (
                f'<testsuite>{cases}<testcase name="{NAMES[0]}"/></testsuite>',
                f'<testsuite skipped="1">{cases}</testsuite>',
                f'<testsuite failures="1">{cases}</testsuite>',
                f'<testsuite errors="1">{cases}</testsuite>',
                f'<testsuite>{cases}<error/></testsuite>',
            ):
                with self.subTest(xml=xml):
                    report.write_text(xml)
                    self.assertNotEqual(self.verify(report).returncode, 0)


if __name__ == "__main__":
    unittest.main()
