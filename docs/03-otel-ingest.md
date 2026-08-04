# OTel Ingest (Astraea)

This page explains how to point an OpenTelemetry-instrumented agent at Astraea's `/v1/otel/v1/traces` endpoint.

## TL;DR — set these four env vars on your agent

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000"      # no trailing path
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(echo -n 'astraea:YOUR_PASSWORD' | base64)"
export OTEL_SERVICE_NAME="my-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

`OTEL_EXPORTER_OTLP_ENDPOINT` should point at the **root** of the API (no `/v1/otel/v1/traces` suffix). The OTel SDK appends `/v1/traces` by default; Astraea's mount point accepts at `/v1/otel/v1/traces` (the standard OTLP HTTP path). If your SDK uses a non-standard path, see [Custom path](#custom-path) below.

## Authentication

The endpoint requires HTTP Basic Auth using the same `UI_USERNAME` / `UI_PASSWORD` that protect the rest of the API. Encode them into `OTEL_EXPORTER_OTLP_HEADERS`:

```sh
# macOS / Linux
AUTH=$(printf '%s:%s' "$UI_USERNAME" "$UI_PASSWORD" | base64)
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH"
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

## Ingestion and query bounds

A single OTLP request accepts at most 2,000 spans (with a 512-span per scope limit), 128 resource spans/scopes/attributes, and 128 events or links per span. Requests over these structural limits are rejected before normalization and persistence. The 10 MiB HTTP body cap still applies independently.

OTLP retries reuse table-namespaced ClickHouse insert-deduplication tokens derived from the validated batch and trusted organization/project scope. This avoids duplicate trace rows when an earlier attempt writes `traces` but fails before writing `observations`. Deduplication is deliberately bounded by ClickHouse's 100,000-block history per table, not a permanent uniqueness guarantee; retries after that history has rolled over can insert duplicates.

Trace-detail reads are capped at 5,000 observations, ordered by start time, so an unusually large trace cannot create an unbounded ClickHouse query or SSE snapshot. Use the paginated observations endpoint to inspect broader data.

## Custom path

If your OTel SDK appends a different path (e.g. some SDKs use `/v1/traces` while the OTLP spec says it should), set `OTEL_EXPORTER_OTLP_TRACES_PATH` (or the SDK's equivalent) to override the default `/v1/traces`.

If you're sending spans to Astraea behind a reverse proxy that mounts the receiver at a different path, configure both `OTEL_EXPORTER_OTLP_ENDPOINT` (point at the proxy root) and the SDK's path-override option.

## After sending — where do traces go?

Traces appear in the dashboard at `http://localhost:5173/observability`. Click a row to see the full span tree, input/output, and token usage. The list polls every 10 seconds.

## Production hardening (post-MVP)

- Replace Basic Auth with mTLS or signed JWT (the OTel SDKs support custom exporters / headers).
- Use TLS at the edge proxy (set `OTEL_EXPORTER_OTLP_ENDPOINT=https://...`).
- Configure tenant routing with server-managed Basic credentials and select an authorized project with `x-astraea-project-id`.
- Enable trace sampling at the agent side for high-volume services (see OTel SDK samplers).
