# Agent Introspection Contract

`agent-introspection.v1` is an immutable, framework-neutral, **client-reported** supplementary evidence contract. It is not an Agent Registry, manifest, target, executor, Agno adapter, SDK transport, or verified agent execution. Reports never affect Evaluation Run status/results/scores/costs, comparisons, or gates.

## Routes and trust

```http
PUT /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id={project_id}
GET /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id={project_id}
```

All selectors are UUIDs. PUT requires `ingest`; GET requires `product_read`; both send `Cache-Control: no-store`. Missing, mismatched, cross-Project, archived, revoked, and unauthorized identities are non-disclosing `404`s. The server derives organization, Project, actor, Run-item, and task association. Every returned report retains `source: "client_reported"`.

## Strict v1 contract

The OpenAPI schema is normative. The strict report has `contract_version: "agent-introspection.v1"`, safe-token adapter metadata, all eleven capability declarations, `capture` with `source: "client_reported"` and `content_mode: "references_only"`, outcome, completeness, unique omissions, and ordered events.

`SafeToken` is `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. No object permits unknown keys. Maximum normalized report is 256 KiB; there are at most 256 events, each canonical event is at most 4 KiB, each event has at most eight references, and there are at most 16 unique omissions. The exact capability keys are `agent_lifecycle`, `model_calls`, `tool_calls`, `workflows`, `teams`, `handoffs`, `retries`, `streaming`, `trace_linkage`, `content_references`, and `cost`; each appears exactly once. Events cannot use a capability declared unsupported or unknown.

Events use contiguous zero-based sequence, unique UUID event IDs, an earlier-only parent ID, operation ID, optional lowercase trace/span IDs, bounded references, and strict type-specific detail. v1 types are `agent.started`, `agent.completed`, `agent.failed`, `agent.cancelled`, `model.started`, `model.completed`, `model.failed`, `tool.started`, `tool.completed`, `tool.failed`, `workflow.started`, `workflow.completed`, `workflow.failed`, `team.started`, `team.completed`, `team.failed`, `handoff`, `retry`, `stream.summary`, and `error`. Retry/stream/error operation references must already exist. Complete reports start with one root agent start and end with the matching root terminal event; partial reports require omissions, and a missing terminal is valid only for unknown incomplete reports with an omission.

References are typed locators/digests only, never authorization proof. The contract rejects prompts, raw inputs/outputs, tool arguments/results, provider payloads, stack traces, credentials, URLs/headers/environment values, arbitrary metadata, and framework state before persistence.

## Replay, retention, and versioning

The request hash covers recursively key-sorted normalized content while preserving array order, contract version, server-derived organization/Project/actor, and path Run/task/invocation IDs. First PUT returns `201`; an identical replay returns the original report as `200` with `replayed: true`; changed content or actor conflicts with `409`. Invalid reports return `400`; normalized oversize returns `413 PAYLOAD_TOO_LARGE`; rejected content is not echoed or logged.

Reports are retained with the Evaluation Run until authorized permanent Project deletion. Absence means unavailable, never success. Shared fixtures include Agno-shaped normalized data and a fixture-only second framework; neither proves framework support. Any v1 field, event, lifecycle, or content-policy change requires a new contract version.
