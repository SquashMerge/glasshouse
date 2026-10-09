#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


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
