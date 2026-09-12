# Agent Introspection Contract

`agent-introspection.v1` is an immutable, framework-neutral, **client-reported** supplementary evidence contract. It is not an Agent Registry, manifest, target, executor, Agno adapter, SDK transport, or verified agent execution. Reports never affect Evaluation Run status/results/scores/costs, comparisons, or gates.

## Routes and trust

```http
PUT /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id={project_id}
GET /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id={project_id}
```

`project_id` is a client-selected UUID selector that the server authorizes against the authenticated organization and Project membership. The Run, task, and invocation path selectors are UUIDs. PUT requires `ingest`; GET requires `product_read`; both send `Cache-Control: no-store`, including validation, authentication, and non-disclosing failures. Missing, mismatched, cross-Project, archived, revoked, and unauthorized identities are non-disclosing `404`s. The server derives organization, actor, and the Run-item/task association. Every returned report retains `source: "client_reported"`.

## Strict v1 contract

OpenAPI defines the transport shape and generated-client types. The server-side v1 validator is normative for semantic invariants that OpenAPI cannot express, including canonical byte limits, capability/cardinality checks, references-only content safety, event ordering, retry progression, and lifecycle consistency. The strict report has `contract_version: "agent-introspection.v1"`, safe-token adapter metadata, all eleven capability declarations, `capture` with `source: "client_reported"` and `content_mode: "references_only"`, outcome, completeness, unique omissions, and ordered events.

`SafeToken` is `^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$`. No object permits unknown keys. Maximum normalized report is 256 KiB; there are at most 256 events, each canonical event is at most 4 KiB, each event has at most eight references, and there are at most 16 unique omissions. The exact capability keys are `agent_lifecycle`, `model_calls`, `tool_calls`, `workflows`, `teams`, `handoffs`, `retries`, `streaming`, `trace_linkage`, `content_references`, and `cost`; each appears exactly once. Events cannot use a capability declared unsupported or unknown.

Events use contiguous zero-based sequence, unique UUID event IDs, an earlier-only parent ID, operation ID, optional lowercase trace/span IDs, bounded references, and strict type-specific detail. v1 types are `agent.started`, `agent.completed`, `agent.failed`, `agent.cancelled`, `model.started`, `model.completed`, `model.failed`, `tool.started`, `tool.completed`, `tool.failed`, `workflow.started`, `workflow.completed`, `workflow.failed`, `team.started`, `team.completed`, `team.failed`, `handoff`, `retry`, `stream.summary`, and `error`. Retry/stream/error operation references must already exist. Known outcomes require exactly one root `agent.started` and one final root terminal with the same operation and `agent_key`; a terminal child or a second root is invalid. Partial reports require omissions, and a missing terminal is valid only for unknown incomplete reports with an omission. A non-null model `cost_usd` requires supported `cost` capability.

References are typed locators/digests only, never authorization proof. A `prompt_version` reference is either a UUID or canonical lowercase `prompt-id@positive-version`; mixed-case and slash-delimited prompt tokens are rejected. The contract rejects prompts, raw inputs/outputs, tool arguments/results, provider payloads, stack traces, credentials, URLs/headers/environment values, arbitrary metadata, and framework state before persistence.

## Examples

```http
PUT /v1/evaluation-runs/22222222-2222-4222-8222-222222222222/tasks/33333333-3333-4333-8333-333333333333/agent-introspection/55555555-5555-4555-8555-555555555555?project_id=11111111-1111-4111-8111-111111111111
Content-Type: application/json
```

```json
{
  "contract_version": "agent-introspection.v1",
  "capture": { "source": "client_reported", "content_mode": "references_only", "sampling": "full" },
  "outcome": "succeeded",
  "completeness": "complete"
}
```

The complete request also supplies the eleven capability declarations and ordered events defined above. A successful first write returns `201` with the stored report and `replayed: false`; an equivalent UUID-casing replay returns `200` with `replayed: true`. A semantic report over 256 KiB returns `413 PAYLOAD_TOO_LARGE`; invalid references, lifecycle, or capability combinations return `400` without echoing report content.

## Replay, retention, and versioning

The request hash covers recursively key-sorted normalized content while preserving array order, contract version, server-derived organization/Project/actor, and path Run/task/invocation IDs. First PUT returns `201`; an identical replay returns the original report as `200` with `replayed: true`; changed content or actor conflicts with `409`. Invalid reports return `400`; normalized oversize returns `413 PAYLOAD_TOO_LARGE`; rejected content is not echoed or logged.

Reports are retained with the Evaluation Run until authorized permanent Project deletion. Absence means unavailable, never success. Shared fixtures include Agno-shaped normalized data and a fixture-only second framework; neither proves framework support. Any v1 field, event, lifecycle, or content-policy change requires a new contract version.
