# OTel Ingest (Astraea)

This page explains how to point an OpenTelemetry-instrumented agent at Astraea's `/v1/otel/v1/traces` endpoint.

## TL;DR — set these five env vars on your agent

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/v1/otel" # receiver mount; no trailing /v1/traces
export ASTRAEA_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(printf '%s' 'astraea:YOUR_PASSWORD' | base64),x-astraea-project-id=$ASTRAEA_PROJECT_ID"
export OTEL_SERVICE_NAME="my-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

`OTEL_EXPORTER_OTLP_ENDPOINT` should point at Astraea's **receiver mount** (`/v1/otel`), without the final `/v1/traces` suffix. The OTel SDK appends `/v1/traces` by default, producing Astraea's `POST /v1/otel/v1/traces` endpoint. If your SDK uses a non-standard path, see [Custom path](#custom-path) below.

## Authentication

The endpoint requires HTTP Basic Auth using the same `UI_USERNAME` / `UI_PASSWORD` that protect the rest of the API. Encode them into `OTEL_EXPORTER_OTLP_HEADERS`:

```sh
# macOS / Linux
AUTH=$(printf '%s:%s' "$UI_USERNAME" "$UI_PASSWORD" | base64)
export ASTRAEA_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH,x-astraea-project-id=$ASTRAEA_PROJECT_ID"
```

The credentials are the same ones you'd use to log in at `http://localhost:5173/login`.

## Organization and project routing

Every Basic-auth credential resolves to a server-configured organization. OTLP payload attributes cannot select or override it. The exporter must select a project with `x-astraea-project-id`; Astraea verifies that project belongs to the credential's organization before accepting the batch.

```sh
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH,x-astraea-project-id=$ASTRAEA_PROJECT_ID"
```

For a multi-organization deployment, configure `ASTRAEA_BASIC_AUTH_CREDENTIALS` on the API as JSON objects with `username`, `password`, and `organization_id`. The organization and selected project must already exist in Postgres; credentials are authentication configuration, not caller-controlled tenant metadata.

## Python example

```python
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

resource = Resource.create({
    "service.name": os.environ["OTEL_SERVICE_NAME"],
    "deployment.environment": "production",
})

provider = TracerProvider(resource=resource)
exporter = OTLPSpanExporter(
    endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] + "/v1/traces",
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

# Any spans created with this tracer go to Astraea.
tracer = trace.get_tracer(__name__)
with tracer.start_as_current_span("hello") as span:
    span.set_attribute("gen_ai.system", "openai")
    span.set_attribute("gen_ai.request.model", "gpt-4o")
    span.set_attribute("gen_ai.usage.input_tokens", 12)
    span.set_attribute("gen_ai.usage.output_tokens", 18)
```

`OTLPSpanExporter` reads `OTEL_EXPORTER_OTLP_HEADERS` from the env and applies them to every export request.

## Node.js / TypeScript example

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "my-agent",
  }),
  traceExporter: new OTLPTraceExporter({
    // @opentelemetry/exporter-trace-otlp-http appends /v1/traces by default.
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  }),
});

sdk.start();
```

Where `parseOtlpHeaders` is a small helper that splits the `k=v,k2=v2` string into a `Record<string, string>`.

## Prompt provenance and sensitive data

Generation spans may identify the exact managed prompt version that produced the call. Set all three attributes exactly once on the span:

| Attribute | Value |
|---|---|
| `astraea.prompt.id` | Canonical public prompt slug (for example `support-agent`) |
| `astraea.prompt.version` | Positive safe integer (`intValue`; a string form must be canonical decimal such as `"7"`) |
| `astraea.prompt.content_hash` | 64-character lowercase hexadecimal content hash |

The tuple is atomic: a missing, duplicate, or malformed member means no provenance is recorded. Astraea accepts it only for observations classified as `generation`.

Astraea removes every incoming `astraea.prompt.*` attribute before it stores metadata or publishes events, including invalid and unknown keys. Do not send template source, rendered prompts or outputs, variables, or settings under that namespace: they are intentionally unavailable after ingest. Stored observation metadata is a versioned envelope containing sanitized attributes and, when valid, the typed provenance tuple.

## Redacting sensitive data

Astraea stores `input_text`, `output_text`, and sanitized OTLP attributes in a `metadata` JSON column. If your agents send PII or other sensitive data through the trace pipeline, configure redaction on the server side (set in the api container's env / compose env / .env):

```sh
# Replace input_text + output_text with "[REDACTED]" before persistence
ASTRAEA_REDACT_INPUT=true

# Strip these keys from the metadata column entirely (e.g. user emails, IPs)
ASTRAEA_REDACT_KEYS=user.email,user.ip,http.url
```

Both flags default to off (dev-friendly). In production we recommend `ASTRAEA_REDACT_INPUT=true` and a curated `ASTRAEA_REDACT_KEYS` list.

## What gets captured

Astraea accepts OTLP HTTP/JSON trace exports (OTLP 1.4.x). Each span is normalized into:

| Astraea column | Source |
|---|---|
| `trace_id`, `name`, `start_time`, `end_time`, `duration_ms` | OTLP span fields |
| `status` | OTLP `status.code` (2 = error) or `exception.type` attribute |
| `agent_id`, `agent_version` | `gen_ai.agent.id`, `gen_ai.agent.version` (or OpenInference fallback) |
| `env` | `deployment.environment` (or `gen_ai.environment`, `env`) |
| `user_id`, `session_id` | `enduser.id`, `session.id` |
| `input_text` | `gen_ai.prompt.0.content` (or OpenInference `input.value`) |
| `output_text` | `gen_ai.completion.0.content` (or OpenInference `output.value`) |
| `scores_summary` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (CSV) |
| `tags` | `span.kind` + `openinference.span.kind` |

`gen_ai.*` semantic conventions take precedence over OpenInference when both are present.

## Viewing trace metadata

On the Observability trace-detail page, structured Observation attributes, events, and links are shown as expandable JSON trees. The metadata tree opens fully expanded; use its compact **Collapse all** / **Expand all** control to fold or reveal the whole tree, or use individual node controls. Use **Copy value** to copy a node's JSON value or **Copy path** to copy its JSON path. Input and output remain text fields.

The tree is a bounded presentation: it renders at most 500 nodes per detail view, up to 100 children per object or array, and 12 nested levels. When any limit is reached, the UI identifies how many entries were omitted. These display limits do not change stored telemetry; omitted entries remain part of the retained metadata when available through the API. A limited tree is not evidence that ingestion or storage dropped the omitted data.

## Ingestion and query bounds

A single OTLP request accepts at most 2,000 spans (with a 512-span per scope limit), 128 resource spans/scopes/attributes, and 128 events or links per span. Requests over these structural limits are rejected before normalization and persistence. The HTTP body cap independently defaults to 1 MiB; operators may raise it with `API_MAX_BODY_BYTES`.

OTLP retries reuse table-namespaced ClickHouse insert-deduplication tokens derived from the validated batch and trusted organization/project scope. This avoids duplicate trace rows when an earlier attempt writes `traces` but fails before writing `observations`. Deduplication is deliberately bounded by ClickHouse's 100,000-block history per table, not a permanent uniqueness guarantee; retries after that history has rolled over can insert duplicates.

Trace and Observation text is redacted before retention accounting, then safely clipped to 8 KiB UTF-8 per input/output field. The stored `input_retained_truncated` and `output_retained_truncated` flags report source clipping; legacy pre-bound rows are clipped safely at read time and report the same flags without rewriting history. REST and list-SSE excerpts are independently limited to 200 Unicode code points and carry `input_excerpt_truncated` or `output_excerpt_truncated` when presentation clips a field. In `GET /v1/traces/{id}`, the embedded `trace.input_text` and `trace.output_text` are those 200-code-point excerpts, while each detailed Observation input/output is its full retained field. Sanitized Observation metadata is retained as valid JSON up to 16 KiB; a `truncated: true` metadata marker identifies a clipped envelope. Observation lists and list-SSE events expose at most a 2 KiB metadata envelope and set `metadata_truncated: true` when it is omitted. ClickHouse enforces the same ceilings for new writes.

Trace and Observation list `limit` defaults to 50, accepts zero, and clamps a larger value to 200. Malformed, fractional, or negative limits return 400. The v1 `offset` parameter remains supported (including `offset=0`); new clients should use the opaque keyset `next_cursor` and must not combine it with a positive offset. `trace` and `observation` list-SSE event data uses the same Project-scoped row projection as its REST list, including the excerpts and truncation markers above. REST list/detail payloads stop at a 256 KiB raw UTF-8 JSON-body ceiling. A trace-detail SSE snapshot is capped by the smaller of that response budget and `SSE_MAX_PENDING_BYTES` after its complete `event`/`data` frame is serialized, so it can pass the authenticated frame-delivery queue. Partial REST and SSE pages expose `response_truncated` or `snapshot_truncated` with `next_cursor`. Trace and Observation list cursors are Project-scoped for stable `start_time, id` traversal. Trace-detail cursors are additionally trace-scoped, use ascending `start_time, observation_id` order, and fetch at most seven bounded Observations per page; detail SSE cursors have the same trace binding and can load later REST pages. The authenticated organization is not a client row field: Trace and Observation responses carry `project_id`, while the server derives organization scope from credentials.

## Custom path

If your OTel SDK needs an explicit full trace URL, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or the SDK's equivalent) to the complete receiver URL, for example `https://api.example.com/v1/otel/v1/traces`.

If you're sending spans to Astraea behind a reverse proxy with a different receiver mount, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to that proxy's complete trace URL.

## After sending — where do traces go?

Traces appear in the dashboard at `http://localhost:5173/observability`. Click a row to see the full span tree, input/output, and token usage. Project-scoped SSE delivers live updates.

## Production hardening (post-MVP)

- Replace Basic Auth with mTLS or signed JWT (the OTel SDKs support custom exporters / headers).
- Use TLS at the edge proxy (set `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.example.com/v1/otel`).
- Configure tenant routing with server-managed Basic credentials and select an authorized project with `x-astraea-project-id`.
- Enable trace sampling at the agent side for high-volume services (see OTel SDK samplers).
