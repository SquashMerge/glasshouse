# OTLP metrics

Glasshouse accepts real OTLP metric exports at `POST /v1/metrics` using
HTTP/JSON, HTTP/protobuf (`application/x-protobuf` or `application/protobuf`),
and optional gzip. The optional gRPC listener also registers
`opentelemetry.proto.collector.metrics.v1.MetricsService/Export`; it forwards
protobuf to the same authenticated handler. The listener's existing private-bind,
message-size and TLS-proxy requirements apply. TraceService and LogsService share
this listener and the same method-exact authentication boundary.

## Exporter configuration

Use an organization Admin-created ingestion credential for the selected Project:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.example.com"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $GLASSHOUSE_OTLP_INGEST_TOKEN,x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
```

The official HTTP metrics exporters append `/v1/metrics` to this generic base
endpoint. A signal-specific `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` must include
the full `/v1/metrics` path. gRPC exporters use the separately exposed listener
address and the same authorization and Project metadata. Follow your SDK's
header escaping and TLS settings. See [OTLP authentication](03-otel-ingest.md).

Bearer secrets authorize only trace/log/metric POST ingestion, never product reads
or other methods. Basic and local cookie sessions use their existing authority;
cookie presence retains precedence and requires CSRF for POST. Scope comes from
authentication plus the required `x-glasshouse-project-id`, never tenant-looking
payload attributes. A `glasshouse.project.id` resource attribute must occur at
most once, contain only an unextended UUID string value, and agree with the
selected Project, including in empty resource envelopes. Malformed, duplicate
and extended selectors reject before normalization or redaction can hide them;
all query Project selectors must also agree with the authorized header.
Current creator/account authority, credential digest, and
active Project are rechecked under the existing authorization locks immediately
before storage. Rotation, revocation, demotion, disablement and archival stop
later effects; they cannot undo an already admitted ClickHouse write.

## Stored data and limits

Migration `infra/db/clickhouse/0010_otlp_metrics.sql` creates a separate
tenant-constrained `metrics` MergeTree table. Each row is one data point, with:

- Gauge, Sum, Histogram, ExponentialHistogram, or Summary kind; description,
  unit, aggregation temporality and monotonicity are preserved.
- Resource/scope attributes, schema URLs, instrumentation scope name/version,
  dropped-attribute counts, metric metadata, and typed OTLP-JSON `data_point`.
- Exact UInt64 Unix nanoseconds and signed Int64 values as decimal strings on
  readback. Safe integer JSON numbers are accepted and canonicalized to strings;
  unsafe JavaScript integers are rejected. Double measurements, attribute doubles
  and sum/min/max retain NaN and infinities as ProtoJSON special strings and
  negative zero as the quoted numeric string `"-0"`, avoiding JSON's lossy
  `null`/zero conversion. Finite doubles, including quoted numeric inputs,
  preserve their numeric values. Distribution bounds/quantiles must be finite.
- Explicit and exponential bucket distributions, count/sum/min/max, zero count
  and threshold, quantiles, flags, and exemplar times, values, attributes and
  optional hex trace/span references. Exemplar references do not grant trace
  access and are not automatically dereferenced.

Validation completes before any insert. Invalid siblings reject the whole export;
there is no distribution truncation, synthetic cumulative snapshot, rate
calculation, or conversion between delta and cumulative data. Nonzero point
times, valid intervals, increasing explicit bounds/quantiles, bucket lengths,
nonnegative UInt64 counts, histogram count consistency, signed 32-bit scale,
and exemplar IDs/times are checked. Explicit histograms may omit both bounds
and buckets. Unset/null fields follow ProtoJSON defaults; null repeated elements
and duplicate attribute keys are rejected. Unknown message fields are ignored
and never persisted. Lower-camel OTLP field names are required.

Field numbers and distribution semantics follow the upstream
[OTLP metrics schema](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto);
special/quoted doubles use [ProtoJSON representations](https://protobuf.dev/programming-guides/json/#field-representation).

| Boundary | Ceiling |
|---|---|
| Compressed and decompressed HTTP body | `API_MAX_BODY_BYTES` (default 1 MiB) |
| Decompressed gRPC message | `OTLP_GRPC_MAX_RECEIVE_BYTES`, plus the HTTP body ceiling |
| Resource groups / scopes per resource | 128 / 128 |
| Metrics / data points per export | 2,000 / 2,000 |
| Attributes per resource, scope, point, metadata or nested key-value list | 128 |
| Attribute key / string value | 256 / 8,192 UTF-8 bytes |
| Nested AnyValue array | 128 values |
| Known structure nesting / inspected nodes | 32 / 100,000 |
| Buckets per point (positive + negative for exponential) | 4,096 |
| Exemplars / quantiles per point | 32 / 1,024 |
| Expanded normalized row / batch, before hashing or redaction | 64 KiB / 4 MiB |
| Serialized retained row / insert batch | 64 KiB / 4 MiB |
| Product read page | 200 rows / 256 KiB |

These are per-request and retention bounds, not a lifetime series quota or
transport rate limiter. Operators still need ingress rate limits and storage
capacity controls. Structural/retained-size violations return 400; body limits
return 413. Storage failures are sanitized; recognized transient failures return
503 (gRPC UNAVAILABLE). No successful export is acknowledged before insert
settlement. ClickHouse is not transactionally atomic with PostgreSQL or across
all partitions; uncertain writes may require retry/reconciliation.

## Redaction, identity, and retry

The deployment redaction floor plus the approved Project policy recursively
removes literal denied keys in resource, scope, metric metadata, point and
exemplar attributes, including arrays and key-value lists. `all_text` additionally
replaces string/byte attribute values and description text. Structural metric
names, units, scope names/versions, schema URLs, attribute keys and numeric values
remain; do not put secrets there. Validation bounds recursion before redaction.
Existing rows are not rewritten by later policy approval.

`series_id` is an HMAC-SHA-256 of the trusted tenant/Project, metric name/kind/
unit/temporality/monotonicity, resource identity/schema, scope identity/schema,
and original typed point attributes. Key-value order is canonical; array order
and value types are significant. Identity is computed before redaction so
distinct sensitive labels never alias after removal. Additive PostgreSQL migration
`90063_metric_identity_keys.sql` backfills a random 32-byte secret per existing
Project and provisions it for new Projects. Keys stay in PostgreSQL, are not
returned by product APIs, and cascade away on permanent Project deletion.
This prevents offline label guessing from exposed IDs without the key, but is
**not** anonymization: IDs preserve linkability and an actor able to ingest and
read in that Project can test guesses online. Avoid sensitive identifying labels.
Database administrators and PostgreSQL backups remain trusted with these keys.
Earlier unkeyed IDs are not rewritten or made confidential by this change.

Retry tokens hash bounded decompressed original bytes, an encoding discriminator,
and trusted scope. Identical protobuf bytes share identity across HTTP media
aliases, gzip, and gRPC; JSON remains separate. The exposed `point_id` HMACs that
identity plus the point's index using the same Project secret and a separate
domain. Internal retry digests remain unkeyed and trusted-infrastructure-only.
The table retains 100,000 recent insert block IDs;
deduplication is bounded, not permanent exactly-once storage. Every retry still
checks current authority and redaction. Semantically equivalent differently
encoded exports can store additional points. Deletion does not clear the retry
log, so an immediate identical-byte retry may still be suppressed.

## Readback, governance, and recovery

The authenticated **Metrics** page (`/metrics`) displays exact points, metric
kinds, temporalities, units, scopes, series IDs and expandable typed JSON. Use
the exact-name filter, refresh, and older-page controls. The product API is
`GET /v1/metrics?project_id=<uuid>&limit=50&name=<optional-exact-name>`; follow
`next_cursor` until null. Cursors bind Organization, Project and name filter, and
every read independently authorizes both tenant keys. They are pagination
positions, not authorization proofs or immutable snapshots. No metric SSE,
aggregation query language, charting or automatic exemplar trace navigation is
provided by this slice. The organization usage dashboard still counts traces
and Observations only.

Governance accepts optional `retention.metrics` from 1 through 3650 whole days.
Existing default policies remain unchanged: metric retention is disabled until
an Admin approves a policy containing it. Previews count expired physical points
by exact point time; each governed run deletes at most its physical-row budget
with a synchronous tenant-scoped mutation under the active Project/policy fence.
Repeated physical copies of one point ID are selected as a whole group; groups
larger than the batch are skipped. Choose a larger permitted batch or investigate
such repeated rows. Single-use previews, run leases and failure evidence follow
the existing [governance runbook](09-governance-runbook.md).

Permanent Project deletion repeats synchronous metrics cleanup before finalizing
the existing deletion job, including when retrying older trace/Observation
checkpoints. Other Projects and tenants are excluded from the mutation.
Whole-database native ClickHouse backups already include metrics and migration
bookkeeping; there is no separate metric backup file or Valkey payload. Follow
[backup/restore](backup-restore.md), pause all OTLP signals for a tighter recovery
point, and verify restored metric counts and exact typed values through authorized
readback before cutover. Retention/deletion does not erase older backup artifacts.

## Verification handoff

The preserved contract and real-storage suite are
`apps/api/tests/unit/otlp-metrics-contract.test.ts` and
`apps/api/tests/integration/otlp-metrics.test.ts`; fixtures include all five kinds
and real official Python HTTP/gRPC exporters. Additional parser regressions live
in `apps/api/tests/unit/metric-normalization.test.ts`. The real suite requires
the proven isolated private service network and the hash-locked Python SDK from
`infra/otlp-sdk-requirements.txt`; it creates only its disposable databases.
Run these plus normal format/lint/typecheck/build and API/web checks in the exact
isolated container. Regenerate/check `openapi.yaml` through the existing snapshot
commands and regenerate ignored clients there. No runtime verification is implied
by this documentation.
