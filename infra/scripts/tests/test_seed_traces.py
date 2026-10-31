#!/usr/bin/env python3
import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET


MODULE_PATH = Path(__file__).parents[1] / "seed_traces.py"
SPEC = importlib.util.spec_from_file_location("seed_traces", MODULE_PATH)
assert SPEC and SPEC.loader
seed_traces = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = seed_traces
SPEC.loader.exec_module(seed_traces)


class FakeResponse:
    def __init__(self, status: int, body: object):
        self.status = status
        self._body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int = -1) -> bytes:
        return self._body


class SeedTraceTimingTests(unittest.TestCase):
    def context(self):
        return seed_traces.TraceContext(
            trace_id="0" * 32,
            root_span_id="1" * 16,
            start_unix_nano=1_700_000_000_000_123_456,
            env="development",
            agent_id="code-reviewer",
            agent_version="1.0.0",
            user_id="user-1",
            session_id="session-1",
        )

    def test_serializes_nanosecond_timestamps_as_exact_decimal_strings(self):
        ctx = self.context()
        span = seed_traces.make_span(
            "llm.call", "2" * 16, ctx.root_span_id, ctx,
            start_offset_ms=25, duration_ms=2100, status_code=1, attrs=[], kind=3,
        )
        encoded = json.loads(json.dumps(span))

        self.assertIsInstance(encoded["start_time_unix_nano"], str)
        self.assertIsInstance(encoded["end_time_unix_nano"], str)
        self.assertEqual(
            int(encoded["start_time_unix_nano"]),
            ctx.start_unix_nano + 25_000_000,
        )
        self.assertEqual(
            int(encoded["end_time_unix_nano"]),
            ctx.start_unix_nano + 2_125_000_000,
        )

    def test_parent_timing_contains_every_generated_child(self):
        state = seed_traces.random.getstate()
        self.addCleanup(seed_traces.random.setstate, state)
        for convention in ("genai", "openinference"):
            for child_count in (1, 3, 5):
                for seed in range(20):
                    with self.subTest(convention=convention, children=child_count, seed=seed):
                        seed_traces.random.seed(seed)
                        payload = seed_traces.build_trace_payload(
                            self.context(), child_count, convention
                        )
                        spans = payload["resource_spans"][0]["scope_spans"][0]["spans"]
                        root = spans[0]
                        start = int(root["start_time_unix_nano"])
                        end = int(root["end_time_unix_nano"])
                        for span in spans[1:]:
                            self.assertEqual(span["parent_span_id"], root["span_id"])
                            self.assertGreaterEqual(int(span["start_time_unix_nano"]), start)
                            self.assertGreaterEqual(
                                int(span["end_time_unix_nano"]),
                                int(span["start_time_unix_nano"]),
                            )
                            self.assertLessEqual(int(span["end_time_unix_nano"]), end)


class SeedTraceProjectRoutingTests(unittest.TestCase):
    def test_resolves_default_project_and_sends_it_on_every_otlp_request(self):
        requests = []
        default_project_id = "11111111-1111-4111-8111-111111111111"

        def fake_urlopen(request, timeout):
            requests.append((request, timeout))
            if request.full_url.endswith("/v1/projects"):
                return FakeResponse(
                    200,
                    {
                        "items": [
                            {
                                "id": default_project_id,
                                "name": "Default",
                                "slug": "default",
                                "created_at": "2026-07-30T00:00:00.000Z",
                            }
                        ],
                        "total": 1,
                    },
                )
            return FakeResponse(200, {"partial_success": {}})

        with patch.object(seed_traces.urllib.request, "urlopen", fake_urlopen):
            project_id = seed_traces.resolve_project_id(
                "http://localhost:3000", "Basic test-auth", None
            )
            status, _body = seed_traces.post_otlp(
                "http://localhost:3000/v1/otel/v1/traces",
                "Basic test-auth",
                {"resource_spans": []},
                project_id,
            )

        self.assertEqual(project_id, default_project_id)
        self.assertEqual(status, 200)
        self.assertEqual(len(requests), 2)
        self.assertEqual(
            requests[0][0].get_header("Authorization"), "Basic test-auth"
        )
        self.assertEqual(
            requests[1][0].get_header("X-glasshouse-project-id"), default_project_id
        )

    def test_prefers_an_explicit_project_id_without_listing_projects(self):
        configured_project_id = "22222222-2222-4222-8222-222222222222"

        with patch.object(seed_traces.urllib.request, "urlopen") as urlopen:
            project_id = seed_traces.resolve_project_id(
                "http://localhost:3000", "Basic test-auth", configured_project_id
            )

        self.assertEqual(project_id, configured_project_id)
        urlopen.assert_not_called()


class SeedTraceResetTests(unittest.TestCase):
    password = "synthetic-reset-secret<&>42"
    config = "/tmp/glasshouse-clickhouse-client.A1b2C3"

    def args(self):
        return SimpleNamespace(
            clickhouse_container="synthetic-clickhouse",
            clickhouse_user="synthetic-user<&>", clickhouse_password=self.password,
            clickhouse_db="synthetic_database",
        )

    def fake_runner(self, calls, fail_at=None, raises=False):
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            self.assertTrue(all(self.password not in argument for argument in argv))
            self.assertTrue(kwargs.get("capture_output"))
            step = len(calls)
            if raises and step == fail_at:
                raise OSError("synthetic subprocess failure")
            stdout = self.config + "\n" if step == 1 else ""
            return subprocess.CompletedProcess(
                argv, 1 if step == fail_at else 0, stdout=stdout, stderr=self.password,
            )
        return run

    def test_reset_passes_escaped_credentials_only_on_stdin_and_cleans_the_config(self):
        calls = []
        with patch.object(seed_traces.subprocess, "run", self.fake_runner(calls)), redirect_stdout(io.StringIO()):
            seed_traces.reset_clickhouse_tables(self.args())
        self.assertEqual(len(calls), 5)
        self.assertIn("umask 077; mktemp", " ".join(calls[0][0]))
        written = ET.fromstring(calls[1][1]["input"])
        self.assertEqual(written.findtext("user"), self.args().clickhouse_user)
        self.assertEqual(written.findtext("password"), self.password)
        self.assertIn('chmod 600 "$1"', calls[1][0][6])
        for index, table in ((2, "traces"), (3, "observations")):
            argv = calls[index][0]
            self.assertIn(f"--config-file={self.config}", argv)
            self.assertIn("--database=synthetic_database", argv)
            self.assertIn(f"TRUNCATE TABLE {table}", argv)
            self.assertFalse(any(argument.startswith("--password") for argument in argv))
        self.assertIn('rm -f -- "$1"', calls[-1][0])
        self.assertEqual(calls[-1][0][-1], self.config)

    def test_configuration_is_removed_after_write_query_or_subprocess_failures(self):
        for fail_at, raises in ((2, False), (3, False), (4, False), (3, True)):
            with self.subTest(fail_at=fail_at, raises=raises):
                calls = []
                with patch.object(seed_traces.subprocess, "run", self.fake_runner(calls, fail_at, raises)), redirect_stdout(io.StringIO()):
                    with self.assertRaises((RuntimeError, OSError)):
                        seed_traces.reset_clickhouse_tables(self.args())
                self.assertIn('rm -f -- "$1"', calls[-1][0])
                self.assertEqual(calls[-1][0][-1], self.config)

    def test_main_does_not_print_secret_bearing_client_diagnostics(self):
        args = self.args()
        args.seed = 1
        args.password = "synthetic-basic-password"
        args.username = "synthetic-owner"
        args.url = "http://synthetic.invalid"
        args.project_id = "11111111-1111-4111-8111-111111111111"
        args.count = 1
        args.reset = True
        output = io.StringIO()
        calls = []
        with patch.object(seed_traces, "parse_args", return_value=args), patch.object(
            seed_traces.subprocess, "run", self.fake_runner(calls, fail_at=3)
        ), redirect_stdout(output), redirect_stderr(output):
            result = seed_traces.main()
        self.assertEqual(result, 1)
        self.assertNotIn(self.password, output.getvalue())
        self.assertIn("client diagnostics suppressed", output.getvalue())

    def test_rejects_untrusted_temporary_paths_without_using_them(self):
        with patch.object(seed_traces.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, stdout="/tmp/unexpected;command\n", stderr=""
        )) as run:
            with self.assertRaises(RuntimeError):
                seed_traces.reset_clickhouse_tables(self.args())
        self.assertEqual(run.call_count, 1)


class SeedTracePromptProvenanceTests(unittest.TestCase):
    def test_adds_one_valid_provenance_tuple_to_most_llm_spans_only(self):
        ctx = seed_traces.TraceContext(
            trace_id="0" * 32,
            root_span_id="1" * 16,
            start_unix_nano=1_700_000_000_000_000_000,
            env="development",
            agent_id="code-reviewer",
            agent_version="1.0.0",
            user_id="user-1",
            session_id="session-1",
        )

        with patch.object(seed_traces.random, "random", return_value=0.1):
            payload = seed_traces.build_trace_payload(ctx, num_children=2, conv="genai")

        spans = payload["resource_spans"][0]["scope_spans"][0]["spans"]
        root = next(span for span in spans if span["name"].startswith("agent.run."))
        llm = next(span for span in spans if span["name"] == "llm.call")
        root_keys = {attribute["key"] for attribute in root["attributes"]}
        llm_attributes = {attribute["key"]: attribute["value"] for attribute in llm["attributes"]}

        self.assertFalse(any(key.startswith("glasshouse.prompt.") for key in root_keys))
        self.assertEqual(
            set(llm_attributes).intersection(
                {
                    "glasshouse.prompt.id",
                    "glasshouse.prompt.version",
                    "glasshouse.prompt.content_hash",
                }
            ),
            {
                "glasshouse.prompt.id",
                "glasshouse.prompt.version",
                "glasshouse.prompt.content_hash",
            },
        )
        self.assertRegex(
            llm_attributes["glasshouse.prompt.id"]["stringValue"],
            r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
        )
        self.assertRegex(
            llm_attributes["glasshouse.prompt.version"]["intValue"], r"^[1-9]\d*$"
        )
        self.assertRegex(
            llm_attributes["glasshouse.prompt.content_hash"]["stringValue"], r"^[0-9a-f]{64}$"
        )


if __name__ == "__main__":
    unittest.main()
