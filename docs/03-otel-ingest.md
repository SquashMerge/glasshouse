# OTel Ingest (Glasshouse)

Glasshouse accepts OTLP trace JSON and protobuf at `POST /v1/traces`, and optionally accepts OTLP/gRPC trace exports. The same path's `GET` operation is the separately authorized product trace list; detail and SSE routes remain product reads.

This endpoint change is a breaking cutover: `POST /v1/otel/v1/traces` is removed. Update clients and proxies configured with the old URL. The old custom path was permitted by OTLP; this migration is a Glasshouse product decision, not a specification requirement.

The gRPC receiver is disabled by default and needs a private network or a TLS-terminating proxy. See the listener settings and limitations below before exposing it.

For production or the image-only snapshot bundle, the optional `infra/compose.otlp-grpc.yaml` overlay publishes gRPC only on the host loopback interface and binds the API listener to Docker's private `api` service address. Set `OTLP_GRPC_HOST_PORT` to change only the host-facing port; the container listener remains `4317`. Start it alongside the relevant production Compose file, then put an operator-managed TLS proxy in front of that loopback port if remote exporters need access. The snapshot copy is `deploy/snapshot/compose.otlp-grpc.yaml` and is intentionally identical.

## Endpoint configuration

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000" # base URL, no /v1/traces suffix
export GLASSHOUSE_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(printf '%s' 'glasshouse:YOUR_PASSWORD' | base64),x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
export OTEL_SERVICE_NAME="my-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

For an OTLP/HTTP sender, the base endpoint resolves traces to `/v1/traces`. A signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used as-is and must include the complete path. Configure the sender for HTTP/protobuf or HTTP/JSON; a gRPC exporter instead needs the separately configured gRPC listener.

## Authentication

OTLP trace ingestion accepts either the existing HTTP Basic Auth credentials or a dedicated Project-scoped bearer credential. Basic Auth remains suitable for existing integrations; a dedicated credential is safer for unattended agents because it cannot sign into the dashboard or read telemetry.

An organization Admin can manage credentials from **Settings → Ingestion credentials**. Select the target Project, create a named credential, and copy its secret immediately. Glasshouse shows the secret only in the create/rotate response; list views show only a short prefix and metadata. Store the secret in your deployment secret manager. Rotation immediately replaces the old secret; revocation disables it. Credentials can send traces only to their bound Project and are accepted only by `POST /v1/traces`.

Rotation and revocation require current organization Admin authority; they are not restricted to the credential's creator. Any current Admin in that organization can rotate an active credential for an active Project or revoke a credential for an active or archived Project. `created_by_actor_id` records the creator and supplies the actor used to authorize bearer ingestion; it is not a creator-only management permission.

Bearer ingestion is authorized as that creator Actor using its current authority and enabled-account state. If the creator loses the role/identity state that permits ingestion or is disabled, ingestion stops even if the credential still appears **Active** (not revoked) in the management list. Rotation does not change the creator Actor or restore its authority; another current organization Admin can manage the credential or create a replacement under an authorized Actor.

For a dedicated credential, put the literal secret in a protected environment variable and use it as a bearer token:

```sh
export GLASSHOUSE_OTLP_INGEST_TOKEN="gh_ing_<secret-from-admin-ui>"
export GLASSHOUSE_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.example.com"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $GLASSHOUSE_OTLP_INGEST_TOKEN,x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
```

The server derives organization and Project scope from the credential record. The `x-glasshouse-project-id` header must exactly match the credential's Project; a missing or different Project is rejected. The secret is a bearer credential: do not put it in source control, client-side browser code, logs, or telemetry attributes. It is returned only once at creation or rotation and stored server-side as a SHA-256 digest. Hosted deployments must send it over HTTPS.

The endpoint also accepts HTTP Basic Auth using the same `UI_USERNAME` / `UI_PASSWORD` that protect the rest of the API. Encode them into `OTEL_EXPORTER_OTLP_HEADERS`:

```sh
# macOS / Linux
AUTH=$(printf '%s:%s' "$UI_USERNAME" "$UI_PASSWORD" | base64)
export GLASSHOUSE_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH,x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
```

The Basic credentials are the same ones you'd use to log in at `http://localhost:5173/login`. Basic Auth retains its existing project authorization behavior; an ingestion credential is deliberately limited to trace POSTs.

## Organization and project routing

Every Basic-auth credential resolves to a server-configured organization. OTLP payload attributes cannot select or override it. The exporter must select a project with `x-glasshouse-project-id`; Glasshouse verifies that project belongs to the credential's organization before accepting the batch.

```sh
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH,x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
```

For a multi-organization deployment, configure `GLASSHOUSE_BASIC_AUTH_CREDENTIALS` on the API as JSON objects with `username`, `password`, and `organization_id`. The organization and selected project must already exist in Postgres; credentials are authentication configuration, not caller-controlled tenant metadata.

## Sending JSON

Use a sender that emits OTLP JSON with `Content-Type: application/json`, the authorization header, and the Project selector. The repository's `infra/scripts/seed_traces.py` is an example sender. OTLP/HTTP protobuf senders use the same endpoint with `Content-Type: application/x-protobuf`.

JSON field values of `null` are treated as unset, following ProtoJSON. For example, `resource: null`, `status: null`, `attributes: null`, and nested AnyValue fields with `null` have the same meaning as omitted fields. An unset AnyValue is an empty value, not a literal JSON null. Null elements inside known repeated fields (including nested attribute collections, events, and links) are invalid. Unknown message fields are ignored; their contents do not make an otherwise valid export malformed. Unknown nested attribute fields remain subject to fail-closed redaction. Retained spans still require valid trace/span IDs, a nonempty name, and a start time; setting a required field to null does not bypass that validation. Send uint64 timestamps and int64 attributes as decimal strings. Numeric forms must be safe JavaScript integers; unsafe numbers, negative uint64s, fractions, overflow and non-decimal timestamp strings reject the export before writes. Span calendar times must fit ClickHouse's existing millisecond index (1970 through 2299); event timestamps retain the full uint64 range. ProtoJSON special double strings (`NaN`, `Infinity`, `-Infinity`) are supported.

## Prompt provenance and sensitive data

Generation spans may identify the exact managed prompt version that produced the call. Set all three attributes exactly once on the span:

| Attribute | Value |
|---|---|
| `glasshouse.prompt.id` | Canonical public prompt slug (for example `support-agent`) |
| `glasshouse.prompt.version` | Positive safe integer (`intValue`; a string form must be canonical decimal such as `"7"`) |
| `glasshouse.prompt.content_hash` | 64-character lowercase hexadecimal content hash |

The tuple is atomic: a missing, duplicate, or malformed member means no provenance is recorded. Glasshouse accepts it only for observations classified as `generation`.

Glasshouse removes every incoming `glasshouse.prompt.*` attribute before it stores metadata or publishes events, including invalid and unknown keys. Do not send template source, rendered prompts or outputs, variables, or settings under that namespace: they are intentionally unavailable after ingest. Stored observation metadata is a versioned envelope containing sanitized attributes and, when valid, the typed provenance tuple.

## Redacting sensitive data

Glasshouse stores `input_text`, `output_text`, and sanitized OTLP attributes in a `metadata` JSON column. If your agents send PII or other sensitive data through the trace pipeline, configure redaction on the server side (set in the api container's env / compose env / .env):

```sh
# Redact input/output and all retained telemetry text values before persistence
GLASSHOUSE_REDACT_INPUT=true

# Strip these keys from the metadata column entirely (e.g. user emails, IPs)
GLASSHOUSE_REDACT_KEYS=user.email,user.ip,http.url
```

Both flags default to off (dev-friendly). In production we recommend `GLASSHOUSE_REDACT_INPUT=true` and a curated `GLASSHOUSE_REDACT_KEYS` list.

## What gets captured

Glasshouse accepts standard OTLP HTTP JSON (lower-camel field names) and protobuf trace exports at the same endpoint. It accepts `Content-Encoding: gzip` with a decompressed body limit equal to `API_MAX_BODY_BYTES`, so compressed input cannot bypass the request budget. A successful export returns the protocol's empty response (`{}` for JSON, empty protobuf for protobuf). OTLP errors use a `google.rpc.Status` response in the request encoding, with generic messages that do not disclose tenant or credential state.

An optional native gRPC TraceService listener is disabled by default. Set `OTLP_GRPC_PORT` to enable it; `OTLP_GRPC_HOST` defaults to `127.0.0.1` and only loopback/private bind addresses are accepted. Place it behind an operator-managed TLS edge. gRPC metadata must include exactly one `authorization` value and exactly one `x-glasshouse-project-id`; it uses the same Basic/Bearer authentication, Project authorization, provenance checks, redaction, and ingest lock as HTTP. Metrics and logs services are not registered and return `UNIMPLEMENTED`.

For IPv6 loopback, set `OTLP_GRPC_HOST=::1` without brackets; the receiver brackets the literal when constructing its gRPC bind target. The host must have that address available.

The CI interoperability regression first installs the version- and hash-locked Python dependency closure in `infra/otlp-sdk-requirements.txt` and performs an offline real-SDK provider construction/export check with an in-memory exporter. It then uses `.github/compose.otlp-sdk-integration.yaml`, with no explicit container, port, or volume names and dynamically allocated loopback ports. The harness rejects caller/Compose project overrides, validates the rendered Compose model for fixed names, external resources, fixed published ports, and only the predicted generated network/volume names, generates an unpredictable project and ownership marker, and fails preflight if either project-labeled resources or predicted resource names already exist. It stops/removes only exact container and network IDs that are atomically verified to carry both the generated marker and project label, and never removes volumes. Mocked fake-Docker tests cover collision, inventory, ownership, partial-startup, signal, and ID-truncation failures without a Docker daemon. Docker-backed fixture/path resolution and exporter execution remain hosted-CI verification; they are not claimed from a devcontainer without Docker.

Each span is normalized into:

| Glasshouse column | Source |
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

On the Observability trace-detail page, structured Observation attributes are shown as expandable JSON trees. The metadata tree opens fully expanded; use its compact **Collapse all** / **Expand all** control to fold or reveal the whole tree, or use individual node controls. Use **Copy value** to copy a node's JSON value or **Copy path** to copy its JSON path. Input and output remain text fields.

Event/link-bearing spans are retained. Each detailed Observation has an `otlp` envelope (`schema_version: 1`) containing resource and instrumentation scope attributes, both schema URLs, kind, trace state, flags, source dropped counts, full status (including message), span attributes, events (including exception attributes and times), and links (including IDs, flags, trace state and attributes). Links are context, not authorization or automatically followed cross-tenant reads. The inspector's **Events**, **Links**, **Resource**, and **Context** tabs expose this retained data using bounded JSON trees and copy controls. `otlp.truncated: true` explicitly reports retention omissions/shortening; it is distinct from SDK-reported dropped counts. List endpoints omit the detail envelope.

`start_time_unix_nano`, `end_time_unix_nano`, and `duration_nano` are nullable decimal strings alongside compatible UTC millisecond timestamps and numeric `duration_ms` (now permitting fractions). Ingest uses BigInt for timestamps, comparisons and subtraction, converting only the millisecond quotient for calendar indexing and the duration difference for compatible display. An end preceding its start rejects the export before writes rather than inventing a zero duration; missing/null ends remain in-flight. The inspector shows exact values; waterfall percentages subtract BigInt offsets before converting to display numbers. Resource timestamp attributes encoded as `intValue` remain decimal strings. Legacy/internal rows without source precision return null rather than fabricated nanos. Migration `0008_otlp_trace_fidelity.sql` adds nullable UInt64 columns, a precise duration companion, and the bounded Observation detail column without rewriting historical rows.

The tree is a bounded presentation: it renders at most 500 nodes per detail view, up to 100 children per object or array, and 12 nested levels. When any limit is reached, the UI identifies how many entries were omitted. These display limits do not change stored telemetry; omitted entries remain part of the retained metadata when available through the API. A limited tree is not evidence that ingestion or storage dropped the omitted data.

## Ingestion and query bounds

A single OTLP request accepts at most 2,000 spans (with a 512-span per scope limit), 512 events and 512 links per span, and 128 resource spans, scopes per resource, or attributes per record (including event/link/resource/scope attributes). Requests over these structural limits are rejected before persistence. Supported event/link spans receive ordinary full success. The HTTP body cap independently defaults to 1 MiB; operators may raise it with `API_MAX_BODY_BYTES`, and must also configure `OTLP_GRPC_MAX_RECEIVE_BYTES` for larger gRPC messages. Gzip cannot bypass the decompressed body limit.

The OTLP detail envelope is capped at 32 KiB serialized UTF-8 per Observation and 8 MiB across an export (including repeated resource context), with an 8 KiB string limit, depth 32 and 4,096 traversal values per envelope. Oversized content is shortened/omitted with `truncated: true`; the span itself remains retained. ClickHouse enforces the per-row detail byte ceiling. Detail shares its Observation's retention/deletion lifecycle. Recursive configured-key filtering applies to resource, scope, span, event and link attributes, including arrays/kvlists; fail-closed traversal drops uninspectable branches. `all_text` / `GLASSHOUSE_REDACT_INPUT` additionally redacts telemetry string/byte values, names, schema URLs, trace state and status/exception messages before retention. IDs, numeric values, attribute keys and source times remain structural data; do not encode secrets in them. The reserved `glasshouse.prompt.*` stripping contract also applies to the detail envelope. Redaction is not retroactive.

Known message objects and repeated-field arrays may nest at most 32 levels below the request root (depth 0). Exceeding that limit rejects the export with HTTP `400`/gRPC `INVALID_ARGUMENT` before persistence, rather than accepting an unvalidated subtree. Unknown extension contents do not count toward this traversal limit and remain subject to fail-closed attribute redaction. Known nested AnyValue fields are type-checked using the same recursive schema as the wire contract.

OTLP retries reuse table-namespaced ClickHouse insert-deduplication tokens derived from the original bounded, decompressed request bytes, their JSON/protobuf encoding, and trusted organization/project scope (including the resolved fallback Project). Hashing bytes never recursively serializes unknown extension trees. An identical request keeps its identity even if redaction policy or deployment redaction settings change between a committed Trace insert and a failed Observation insert. Every attempt still applies current authorization and redaction; deduplication does not rewrite an already committed row, and redaction changes are not retroactive.

Compression is transport-only for this identity: gzip and uncompressed exports with identical decompressed bytes share tokens. The two protobuf HTTP media aliases and the gRPC bridge use the same protobuf identity; JSON and protobuf remain separate. Different original bytes, including JSON whitespace/key order, ignored extensions, protobuf unknown fields, redacted values, or text beyond retention limits, get different identities even if they produce identical retained rows. Exporters should retry the original bytes rather than reserialize the request. Only the digest is passed to the writer; the raw body is not added to stored rows, events, responses, or logs. Digests are not a secrecy mechanism against guessing known/low-entropy payloads.

Deduplication is deliberately bounded by ClickHouse's 100,000-block history per table, not a permanent uniqueness guarantee; retries after that history has rolled over can insert duplicates. The wire-based token algorithm differs from earlier row-based tokens: an in-flight retry crossing that upgrade can insert a duplicate. There is no cross-version token compatibility or exactly-once guarantee.

Each Trace and Observation insert has a 30-second wall-clock deadline, in addition to the ClickHouse client's socket timeout. The writer passes an explicit `AbortSignal` to the pinned client and awaits cancellation, including while draining a stalled response body; it does not abandon a background insert with `Promise.race`. Deadline timers are cleared when the insert settles. This bounds each insert, not the entire ingest request or its authorization/lock acquisition.

Recognized transient storage failures, including this insert deadline and the pinned ClickHouse client's native insert timeout, return HTTP `503` or gRPC `UNAVAILABLE` with a generic message. A timeout can occur after a write has reached storage; aborting local I/O does not roll back a remote write, and these responses do not prove that no rows were written. Exporter retries retain the bounded deduplication behavior above; the writer does not automatically retry. Other internal failures remain HTTP `500`/gRPC `INTERNAL`.

Trace and Observation text is redacted before retention accounting, then safely clipped to 8 KiB UTF-8 per input/output field. The stored `input_retained_truncated` and `output_retained_truncated` flags report source clipping; legacy pre-bound rows are clipped safely at read time and report the same flags without rewriting history. REST and list-SSE excerpts are independently limited to 200 Unicode code points and carry `input_excerpt_truncated` or `output_excerpt_truncated` when presentation clips a field. In `GET /v1/traces/{id}`, the embedded `trace.input_text` and `trace.output_text` are those 200-code-point excerpts, while each detailed Observation input/output is its full retained field. Sanitized Observation metadata is retained as valid JSON up to 16 KiB; a `truncated: true` metadata marker identifies a clipped envelope. Observation lists and list-SSE events expose at most a 2 KiB metadata envelope and set `metadata_truncated: true` when it is omitted. ClickHouse enforces the same ceilings for new writes.

Trace and Observation list `limit` defaults to 50, accepts zero, and clamps a larger value to 200. Malformed, fractional, or negative limits return 400. The v1 `offset` parameter remains supported (including `offset=0`); new clients should use the opaque keyset `next_cursor` and must not combine it with a positive offset. `trace` and `observation` list-SSE event data uses the same Project-scoped row projection as its REST list, including the excerpts and truncation markers above. REST list/detail payloads stop at a 256 KiB raw UTF-8 JSON-body ceiling. A trace-detail SSE snapshot is capped by the smaller of that response budget and `SSE_MAX_PENDING_BYTES` after its complete `event`/`data` frame is serialized, so it can pass the authenticated frame-delivery queue. Partial REST and SSE pages expose `response_truncated` or `snapshot_truncated` with `next_cursor`. Trace and Observation list cursors are Project-scoped for stable `start_time, id` traversal. Trace-detail cursors are additionally trace-scoped, use ascending `start_time, observation_id` order, and fetch at most seven bounded Observations per page; detail SSE cursors have the same trace binding and can load later REST pages. The authenticated organization is not a client row field: Trace and Observation responses carry `project_id`, while the server derives organization scope from credentials.

## Organization usage dashboard

The authenticated organization homepage reports persisted telemetry across all active and archived Projects. `GET /v1/organization/usage?range=24h|7d|30d|90d` returns organization and per-Project counts plus a UTC time series. The range is a rolling interval ending at the response's `to` timestamp; `from` is inclusive and `to` is exclusive. The 24-hour range uses hourly buckets; longer ranges use daily UTC buckets. Empty buckets and Projects with no rows are included as zero.

The dashboard displays that returned `to` value in UTC as **Data through** and provides a keyboard-accessible **Refresh usage** button to refetch the selected range without navigating. The timestamp is the query's exclusive range end, not an ingestion watermark or the time telemetry was last updated.

Trace counts are rows in the retained `traces` table. Observation counts are rows in `observations`, broken out by `span`, `event`, `generation`, and `tool`. Records are attributed by `start_time`; these are storage-row counts, not unique logical telemetry counts, and therefore reflect ClickHouse's bounded insert-deduplication behavior described above. The dashboard selects only organization/project identifiers, start times, record type, and counts; it never returns trace or Observation payload content. Every request derives organization scope from the authenticated member and queries only that organization's eligible Projects. The dashboard is visibility-only: it does not change quotas, retention, ingestion, or Project-level access. Detailed traces and failures remain in Observability.

The compact service-health card reports Postgres, ClickHouse, and Valkey dependency availability. It does not indicate whether telemetry has been ingested. When the selected range is empty, the homepage keeps OTLP setup guidance; verify received telemetry in Observability.

**Query smoke measurement (2026-10-28):** ClickHouse 24.8.14.39 in an isolated container limited to 2 vCPU and 4 GiB processed a synthetic single-organization, 30-day workload with 20 Projects, 1,000,000 trace rows, and 10,000,000 Observation rows. The synthetic MergeTree tables used the production monthly partitioning and sort keys and the aggregation's projected columns, but omitted payload columns and secondary indexes. The production-shaped grouped aggregation completed in 0.252 seconds; a separate grouped count confirmed 20 Projects and 999,999 traces plus 9,999,999 observations (2,499,999 span; 2,500,000 each event, generation, and tool). Rows exactly at the upper bound were excluded. This validates query execution and half-open range behavior for that fixture only; it is not an API end-to-end latency result, production-scale benchmark, or service-level guarantee.

## Custom path

If your compatible sender needs an explicit full trace URL, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or its equivalent) to the complete receiver URL, for example `https://api.example.com/v1/traces`.

If you're sending spans to Glasshouse behind a reverse proxy with a different receiver mount, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to that proxy's complete trace URL.

## After sending — where do traces go?

Traces appear in the dashboard at `http://localhost:5173/observability`. Click a row to see the full span tree, input/output, and token usage. Project-scoped SSE delivers live updates.

## Production hardening (post-MVP)

- Replace Basic Auth with mTLS or signed JWT (the OTel SDKs support custom exporters / headers).
- Use TLS at the edge proxy (set `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.example.com`).
- Configure tenant routing with server-managed Basic credentials and select an authorized project with `x-glasshouse-project-id`.
- Enable trace sampling at the agent side for high-volume services (see OTel SDK samplers).
