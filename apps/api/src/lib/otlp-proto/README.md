# OTLP logs wire schema

These four schemas are vendored from the maintained upstream
[`open-telemetry/opentelemetry-proto` v1.11.1](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.1/opentelemetry/proto),
the current release when updated on 2026-11-06:

- `common/v1/common.proto`
- `resource/v1/resource.proto`
- `logs/v1/logs.proto`
- `collector/logs/v1/logs_service.proto`

Only explanatory comments/whitespace were removed; all declarations, field
numbers/types, reservations, options and services are retained. They are licensed
under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0), copyright
OpenTelemetry Authors (2019/2020). The remainder of Glasshouse retains BUSL-1.1.

Update the four files together against an upstream release. Do not patch a
single field into the old exporter's generated root: that root predates
`LogRecord.event_name` (field 12, introduced in proto v1.5.0). Runtime parsing
uses a private protobufjs root and bundled text imports, with no network access
or shared generated-root mutation. The independent Python official-schema
fixture and fixed hex regression must continue to pass when updating.
