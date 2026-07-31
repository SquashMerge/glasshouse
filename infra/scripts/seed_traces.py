#!/usr/bin/env python3
"""
Seed a large number of OTLP traces into Astraea via POST /v1/otel/v1/traces.

Three conventions are supported via --convention:
  - genai:        OTel GenAI semantic conventions (gen_ai.* attrs)
  - openinference: Arize Phoenix / OpenInference conventions (input.value, llm.model_name, etc.)
  - mixed:        ~50/50 split between the two

Realistic chat-agent span tree per trace:
  root (agent.run) -> llm.call -> (optional) tool.search_db
                                  -> (optional) tool.search_web

Usage:
  infra/scripts/seed-traces.sh
  infra/scripts/seed-traces.sh --count 1000 --convention genai
  SEED_COUNT=50000 SEED_CONVENTION=openinference infra/scripts/seed-traces.sh

CLI flags mirror the SEED_* env vars (env is read first, CLI overrides).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import secrets
import string
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass


# ---------- realistic fixture pools ----------

AGENTS = [
    ("customer-support-bot", "1.4.2"),
    ("code-reviewer", "0.9.1"),
    ("data-analyst", "2.1.0"),
    ("research-assistant", "1.0.0"),
    ("sql-copilot", "0.5.3"),
    ("doc-summarizer", "1.2.0"),
    ("translation-agent", "1.1.0"),
    ("calendar-helper", "0.3.0"),
    ("email-drafter", "1.0.5"),
    ("bug-triager", "0.7.0"),
]

MODELS = ["gpt-4o", "gpt-4o-mini", "claude-opus-4-5", "claude-sonnet-4-5", "gemini-2.5-pro"]

ENVS = ["production", "production", "production", "staging", "dev"]

USER_PROMPTS = [
    "Why is my order #45892 delayed?",
    "Refactor this Python function to be more idiomatic.",
    "Summarize the Q3 earnings call transcript.",
    "Find the top 5 customers by ARR in the EU region.",
    "What's the weather in Lisbon next week?",
    "Draft a polite follow-up email to a recruiter.",
    "Translate this paragraph to formal Japanese.",
    "Classify this bug report by severity and component.",
    "Schedule a 30-min sync with the design team next Tuesday.",
    "Explain the difference between TCP and UDP to a 10-year-old.",
]

LLM_RESPONSES = [
    "Your order is being held in customs. Estimated delivery is Friday.",
    "Here's the refactored version using dataclasses and a generator.",
    "Revenue grew 18% YoY driven by the enterprise segment; margins compressed 2 pts.",
    "Top 5 EU customers: Acme (€4.2M ARR), Globex (€3.8M), Initech (€3.1M)...",
    "Tuesday: 22°C partly cloudy. Wednesday through Friday: showers, 17-19°C.",
    "Subject: Following up on the senior engineer role\n\nHi Sarah, ...",
    "本段落は、画像認識技術の最新動向について論じている。",
    "Severity: P2. Component: billing. Suggested owner: payments-team.",
    "I have Tuesday at 10:00, 11:30, or 14:00 open. Which works for you?",
    "TCP is like a phone call — both sides have to be connected and talking in order. UDP is like shouting into a crowd.",
]

TOOL_NAMES = ["search_db", "search_web", "fetch_user_profile", "get_weather"]


# ---------- OTLP payload construction ----------

HEX = string.digits + "abcdef"


def hex_id(nbytes: int) -> str:
    return "".join(random.choices(HEX, k=nbytes * 2))


@dataclass
class TraceContext:
    trace_id: str
    root_span_id: str
    start_unix_nano: int
    env: str
    agent_id: str
    agent_version: str
    user_id: str
    session_id: str


def make_attr(key: str, value) -> dict:
    if isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    raise TypeError(f"unsupported attr value type: {type(value)}")


def genai_resource_attrs(ctx: TraceContext) -> list[dict]:
    return [
        make_attr("deployment.environment", ctx.env),
        make_attr("gen_ai.agent.id", ctx.agent_id),
        make_attr("gen_ai.agent.version", ctx.agent_version),
        make_attr("enduser.id", ctx.user_id),
        make_attr("session.id", ctx.session_id),
        make_attr("service.name", f"agent-{ctx.agent_id}"),
    ]


def openinference_resource_attrs(ctx: TraceContext) -> list[dict]:
    return [
        make_attr("deployment.environment", ctx.env),
        make_attr("agent.id", ctx.agent_id),
        make_attr("agent.version", ctx.agent_version),
        make_attr("user.id", ctx.user_id),
        make_attr("session.id", ctx.session_id),
        make_attr("openinference.span.kind", "AGENT"),
    ]


def genai_span_attrs(model: str, in_tok: int, out_tok: int, prompt: str, completion: str,
                     agent_id: str, agent_version: str) -> list[dict]:
    return [
        make_attr("gen_ai.agent.id", agent_id),
        make_attr("gen_ai.agent.version", agent_version),
        make_attr("gen_ai.system", "openai"),
        make_attr("gen_ai.request.model", model),
        make_attr("gen_ai.response.model", model),
        make_attr("gen_ai.usage.input_tokens", in_tok),
        make_attr("gen_ai.usage.output_tokens", out_tok),
        make_attr("gen_ai.prompt.0.content", prompt),
        make_attr("gen_ai.completion.0.content", completion),
    ]


def openinference_span_attrs(model: str, in_tok: int, out_tok: int, prompt: str, completion: str,
                             agent_id: str, agent_version: str) -> list[dict]:
    return [
        make_attr("agent.id", agent_id),
        make_attr("agent.version", agent_version),
        make_attr("llm.system", "openai"),
        make_attr("llm.model_name", model),
        make_attr("llm.token_count.prompt", in_tok),
        make_attr("llm.token_count.completion", out_tok),
        make_attr("input.value", prompt),
        make_attr("output.value", completion),
        make_attr("openinference.span.kind", "LLM"),
    ]


def tool_span_attrs(tool_name: str, args: str, result: str, agent_id: str, agent_version: str) -> list[dict]:
    return [
        make_attr("agent.id", agent_id),
        make_attr("agent.version", agent_version),
        make_attr("openinference.span.kind", "TOOL"),
        make_attr("tool.name", tool_name),
        make_attr("input.value", args),
        make_attr("output.value", result),
    ]


def make_span(
    name: str,
    span_id: str,
    parent_span_id: str | None,
    ctx: TraceContext,
    start_offset_ms: int,
    duration_ms: int,
    status_code: int,
    attrs: list[dict],
    kind: int,
) -> dict:
    start_ns = ctx.start_unix_nano + start_offset_ms * 1_000_000
    end_ns = start_ns + duration_ms * 1_000_000
    return {
        "trace_id": ctx.trace_id,
        "span_id": span_id,
        "parent_span_id": parent_span_id,
        "name": name,
        "kind": kind,
        "start_time_unix_nano": start_ns,
        "end_time_unix_nano": end_ns,
        "status": {"code": status_code},
        "attributes": attrs,
    }


def build_trace_payload(ctx: TraceContext, num_children: int, conv: str) -> dict:
    """Build an OTLP ExportTraceServiceRequest for one trace."""
    prompt = random.choice(USER_PROMPTS)
    completion = random.choice(LLM_RESPONSES)
    in_tok = random.randint(80, 4000)
    out_tok = random.randint(40, 1500)
    model = random.choice(MODELS)
    is_error = random.random() < 0.02

    # Root span: agent.run
    root_status = 2 if is_error else 1
    root_attrs = []
    if conv == "genai":
        root_attrs = genai_span_attrs(model, in_tok, out_tok, prompt, completion, ctx.agent_id, ctx.agent_version)
    elif conv == "openinference":
        root_attrs = openinference_span_attrs(model, in_tok, out_tok, prompt, completion, ctx.agent_id, ctx.agent_version)

    root_span = make_span(
        name=f"agent.run.{ctx.agent_id}",
        span_id=ctx.root_span_id,
        parent_span_id=None,
        ctx=ctx,
        start_offset_ms=0,
        duration_ms=random.randint(400, 5000),
        status_code=root_status,
        attrs=root_attrs,
        kind=1,
    )

    spans = [root_span]
    if is_error:
        root_span.setdefault("attributes", []).append(make_attr("exception.type", "RuntimeError"))
        root_span["attributes"].append(make_attr("exception.message", "tool call timed out"))

    # Children: 1 LLM call + (num_children - 1) tool calls (if requested)
    cur_offset = random.randint(20, 100)
    cur_span_id = hex_id(8)

    # Always at least one LLM child
    llm_attrs = genai_span_attrs(model, in_tok, out_tok, prompt, completion, ctx.agent_id, ctx.agent_version) if conv == "genai" else openinference_span_attrs(model, in_tok, out_tok, prompt, completion, ctx.agent_id, ctx.agent_version)
    spans.append(make_span(
        name="llm.call",
        span_id=cur_span_id,
        parent_span_id=ctx.root_span_id,
        ctx=ctx,
        start_offset_ms=cur_offset,
        duration_ms=random.randint(200, 2500),
        status_code=2 if is_error else 1,
        attrs=llm_attrs,
        kind=3,
    ))

    for i in range(num_children - 1):
        tool = random.choice(TOOL_NAMES)
        cur_offset += random.randint(150, 800)
        spans.append(make_span(
            name=f"tool.{tool}",
            span_id=hex_id(8),
            parent_span_id=ctx.root_span_id,
            ctx=ctx,
            start_offset_ms=cur_offset,
            duration_ms=random.randint(50, 600),
            status_code=1,
            attrs=tool_span_attrs(tool, json.dumps({"q": prompt[:60]}), f"ok ({random.randint(1, 50)} rows)", ctx.agent_id, ctx.agent_version),
            kind=3,
        ))

    if conv == "genai":
        resource_attrs = genai_resource_attrs(ctx)
    else:
        resource_attrs = openinference_resource_attrs(ctx)

    return {
        "resource_spans": [{
            "resource": {"attributes": resource_attrs},
            "scope_spans": [{
                "scope": {"name": "astraea-seed", "version": "1.0.0"},
                "spans": spans,
            }],
        }],
    }


# ---------- HTTP ----------

def resolve_project_id(
    api_base_url: str, auth_header: str, configured_project_id: str | None
) -> str:
    if configured_project_id:
        return configured_project_id

    request = urllib.request.Request(
        api_base_url.rstrip("/") + "/v1/projects",
        method="GET",
        headers={
            "accept": "application/json",
            "authorization": auth_header,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30.0) as response:
            body = response.read(500_000).decode("utf-8", errors="replace")
            if response.status != 200:
                raise RuntimeError(f"GET /v1/projects returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"could not resolve the default project (HTTP {error.code}): {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"could not resolve the default project: {error.reason}"
        ) from error

    try:
        projects = json.loads(body)["items"]
        project_id = next(
            project["id"]
            for project in projects
            if project.get("slug") == "default" and isinstance(project.get("id"), str)
        )
    except (KeyError, StopIteration, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "could not find the authenticated organization's default project in GET /v1/projects"
        ) from error
    return project_id


def post_otlp(
    url: str, auth_header: str, payload: dict, project_id: str, timeout: float = 30.0
) -> tuple[int, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": auth_header,
            "x-astraea-project-id": project_id,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(200).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return -1, str(e.reason)


# ---------- main ----------

def parse_args() -> argparse.Namespace:
    env = os.environ
    p = argparse.ArgumentParser(description="Seed OTLP traces into Astraea.")
    p.add_argument("--url", default=env.get("API_URL", "http://localhost:3000"), help="Astraea API base URL")
    p.add_argument("--project-id", default=env.get("SEED_PROJECT_ID"), help="Target project UUID (default: authenticated org's default project)")
    p.add_argument("--username", default=env.get("UI_USERNAME", "astraea"), help="Basic auth username")
    p.add_argument("--password", default=env.get("UI_PASSWORD", ""), help="Basic auth password")
    p.add_argument("--count", type=int, default=int(env.get("SEED_COUNT", "100000")), help="Number of traces to seed")
    p.add_argument("--convention", choices=["genai", "openinference", "mixed"], default=env.get("SEED_CONVENTION", "mixed"), help="Attribute convention")
    p.add_argument("--batch-size", type=int, default=int(env.get("SEED_BATCH_SIZE", "50")), help="Traces per OTLP request")
    p.add_argument("--days", type=int, default=int(env.get("SEED_DAYS", "30")), help="Spread traces across the last N days")
    p.add_argument("--min-spans", type=int, default=int(env.get("SEED_SPANS_MIN", "2")), help="Min child spans per trace (incl. root)")
    p.add_argument("--max-spans", type=int, default=int(env.get("SEED_SPANS_MAX", "5")), help="Max child spans per trace (incl. root)")
    p.add_argument("--concurrency", type=int, default=int(env.get("SEED_CONCURRENCY", "8")), help="Parallel OTLP requests in flight")
    p.add_argument("--dry-run", action="store_true", help="Build payloads but don't POST")
    p.add_argument("--reset", action="store_true", help="Truncate traces + observations tables before seeding (uses docker exec)")
    p.add_argument("--clickhouse-container", default=env.get("CLICKHOUSE_CONTAINER", "astraea-clickhouse"), help="ClickHouse container name for --reset")
    p.add_argument("--clickhouse-user", default=env.get("CLICKHOUSE_USER", "astraea"), help="ClickHouse user for --reset")
    p.add_argument("--clickhouse-password", default=env.get("CLICKHOUSE_PASSWORD", ""), help="ClickHouse password for --reset")
    p.add_argument("--clickhouse-db", default=env.get("CLICKHOUSE_DB", "astraea"), help="ClickHouse database for --reset")
    p.add_argument("--seed", type=int, default=None, help="RNG seed for reproducible output")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if args.seed is not None:
        random.seed(args.seed)
    else:
        random.seed(secrets.randbelow(2**32))

    if not args.password:
        print("error: --password / UI_PASSWORD is required (or set in infra/.env)", file=sys.stderr)
        return 2
    if args.count <= 0:
        print("error: --count must be > 0", file=sys.stderr)
        return 2

    auth = "Basic " + __import__("base64").b64encode(f"{args.username}:{args.password}".encode()).decode()
    try:
        project_id = resolve_project_id(args.url, auth, args.project_id)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    url = args.url.rstrip("/") + "/v1/otel/v1/traces"

    if args.reset:
        if not args.clickhouse_password:
            print("error: --reset requires --clickhouse-password / CLICKHOUSE_PASSWORD", file=sys.stderr)
            return 2
        import subprocess
        print(f"Resetting ClickHouse tables in '{args.clickhouse_db}' (container={args.clickhouse_container})…")
        for table in ("traces", "observations"):
            cmd = [
                "docker", "exec", "-i", args.clickhouse_container,
                "clickhouse-client",
                f"--database={args.clickhouse_db}",
                f"--user={args.clickhouse_user}",
                f"--password={args.clickhouse_password}",
                "--multiquery",
                "--query", f"TRUNCATE TABLE {table}",
            ]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  ! truncate {table} failed: {r.stderr.strip()}", file=sys.stderr)
                return 1
            print(f"  ✓ truncated {table}")

    now_ns = int(time.time() * 1_000_000_000)
    window_ns = args.days * 24 * 3600 * 1_000_000_000

    def make_trace() -> tuple[TraceContext, int, str]:
        agent, ver = random.choice(AGENTS)
        ctx = TraceContext(
            trace_id=hex_id(16),
            root_span_id=hex_id(8),
            start_unix_nano=now_ns - random.randint(0, window_ns),
            env=random.choice(ENVS),
            agent_id=agent,
            agent_version=ver,
            user_id=f"user-{random.randint(1, 200)}",
            session_id=f"sess-{secrets.token_hex(8)}",
        )
        nspans = random.randint(args.min_spans, max(args.min_spans, args.max_spans))
        if args.convention == "mixed":
            conv = random.choice(["genai", "openinference"])
        else:
            conv = args.convention
        return ctx, nspans, conv

    # Build all batches first so concurrency is bounded by the request pool, not the build.
    print(f"Seeding {args.count} traces (convention={args.convention}, batch={args.batch_size}, spans={args.min_spans}-{args.max_spans}, days={args.days})")
    print(f"  → {url} (project={project_id})")
    if args.dry_run:
        print("  → DRY-RUN: not POSTing")

    t0 = time.time()
    posted = 0
    failed = 0
    spans_total = 0

    def submit_batch() -> list[tuple[int, int]]:
        traces = [make_trace() for _ in range(args.batch_size)]
        payload = {
            "resource_spans": []
        }
        spans_in_batch = 0
        for ctx, nspans, conv in traces:
            one = build_trace_payload(ctx, nspans, conv)
            payload["resource_spans"].extend(one["resource_spans"])
            spans_in_batch += sum(len(rs["scope_spans"][0]["spans"]) for rs in one["resource_spans"])
        return payload, spans_in_batch

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = []
        num_batches = (args.count + args.batch_size - 1) // args.batch_size
        for _ in range(num_batches):
            payload, spans_in_batch = submit_batch()
            spans_total += spans_in_batch
            if args.dry_run:
                futures.append(None)
                posted += args.batch_size
                continue
            futures.append(pool.submit(post_otlp, url, auth, payload, project_id))

        done = 0
        for f in as_completed([f for f in futures if f is not None]):
            status, body = f.result()
            done += 1
            if status != 200:
                failed += args.batch_size
                print(f"  ! batch failed (status={status}): {body[:200]}")
            else:
                posted += args.batch_size

            if done % max(1, num_batches // 20) == 0 or done == num_batches:
                elapsed = time.time() - t0
                rate = posted / elapsed if elapsed > 0 else 0
                pct = 100.0 * done / num_batches
                print(f"  [{pct:5.1f}%] {posted}/{args.count} traces posted, {failed} failed, {rate:.0f} traces/s")

    elapsed = time.time() - t0
    rate = posted / elapsed if elapsed > 0 else 0
    print(f"\nDone in {elapsed:.1f}s: {posted} traces, {spans_total} spans, {failed} failed, {rate:.0f} traces/s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())