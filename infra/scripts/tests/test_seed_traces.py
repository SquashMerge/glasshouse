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
            requests[1][0].get_header("X-astraea-project-id"), default_project_id
        )

    def test_prefers_an_explicit_project_id_without_listing_projects(self):
        configured_project_id = "22222222-2222-4222-8222-222222222222"

        with patch.object(seed_traces.urllib.request, "urlopen") as urlopen:
            project_id = seed_traces.resolve_project_id(
                "http://localhost:3000", "Basic test-auth", configured_project_id
            )

        self.assertEqual(project_id, configured_project_id)
        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
