# Datasets, Evaluations, and Feedback — First-Pass Build Brief

**Status:** Implementation contract for the first production-capable slice.
**Repository baseline:** `origin/main` at `3002cf16b32fa7c52d223b38816ed2c204825867` (PRs #35–#37 merged).
**Objective:** Make existing project-scoped datasets and evaluation runs usable from the dashboard and public API, then add a small, human-reviewed feedback workflow on traces and observations. Build only the pieces the current repository can support safely. Document the versioned and automation-heavy loop as future work rather than simulating it now.

---

## 1. Current repository reality

The first pass must extend—not replace—the functionality that landed in the just-merged evaluation PRs:

| Existing capability | Repository evidence | First-pass consequence |
|---|---|---|
| Project-scoped dataset CRUD and trace/observation provenance | `apps/api/src/routes/datasets.ts`, `apps/api/src/db/datasets.ts`, `infra/db/migrations/0016_dataset_trace_provenance.sql` | Use these endpoints/storage as the single dataset system. Add UI and API helpers; do not create a parallel data store. |
| Dataset item shape is flexible JSON input + optional reference output + metadata | `apps/api/src/schemas/datasets.ts` | Manual authoring and feedback conversion use this exact shape. |
| Experiment runner executes every dataset item and emits trace evidence | `apps/api/src/routes/experiments.ts`, `apps/api/src/db/experiments.ts` | Dashboard evaluations are configured LLM runs against a chosen existing Dataset, not a new agent runtime. |
| Current evaluators are `exact_match` and `contains` | `apps/api/src/schemas/experiments.ts`, `apps/api/src/lib/evaluator.ts` | Expose only these choices. Validate that every item has reference output before starting a run whose evaluator requires one. |
| Scores are schema/API stubs | `apps/api/src/routes/scores.ts`, `apps/api/src/schemas/scores.ts`, `infra/db/migrations/0007_scores.sql` | Implement the narrow feedback-on-score path now; do not build a general metrics product. |
| The dashboard has only Observability and Prompts routes | `apps/web/src/App.tsx`, `apps/web/src/components/AppShell.tsx` | Add Datasets, Evaluations, and Feedback routes/navigation using the established TanStack Router, React Query, and `apps/web/src/lib/api.ts` patterns. |
| Trace detail already renders a selected observation and its sanitized input/output | `apps/web/src/routes/observability/traces/$id.tsx`, `apps/web/src/components/ObservationDetailPanel.tsx` | Add feedback and “add to dataset” actions at the trace/selected-observation context; do not build a second trace viewer. |
| Original first-pass authentication | superseded by durable Actor identity and Organization roles | Current feedback is per authenticated Actor and target; assignment remains out of scope. |

## 2. Product promise for this release

A team can:

1. Create a Dataset manually in the UI or via the existing REST API; add/edit JSON cases with optional expected output.
2. Open a trace or observation, explicitly copy its input/output into an existing dataset case while preserving `source_trace_id` and `source_observation_id`.
3. Start an admitted immutable Evaluation Run against that dataset from the dashboard or existing `POST /v1/experiments` compatibility API, follow its current status/results, and inspect evaluation traces.
4. Record thumbs-up/down feedback on a trace or observation. Feedback is stored as a standard `human.feedback` score with typed metadata.
5. Use a **Feedback** page to see positive and negative signals and a **Needs review** queue for negative feedback.
6. From a reviewed feedback item, explicitly add a redacted/edited case to an existing dataset and mark the feedback item as added to a dataset.

The release must make the lineage visible:

```text
feedback → source trace / observation → dataset item → evaluation run → result trace
```

No part of this flow changes a prompt, model, agent, evaluator, or production deployment automatically.

---

## 3. Build scope

### 3.1 Datasets dashboard

Add `/datasets` and `/datasets/$id`.

**List page**

- Requires selected project; mirror the prompts page loading, error, empty, and retry states.
- List existing datasets with name, description, item count, and updated timestamp.
- Provide **New dataset** with name/description validation matching `DatasetCreate`.

**Detail page**

- Show dataset identity and cases from the current dataset routes.
- Support manual add and delete of a case. The editor has separate JSON fields for `input` (required), `expected_output` (optional), and `metadata` (defaults to `{}`). Validate JSON locally and show the API error without discarding entered text.
- Show provenance badges/links when `source_trace_id` or `source_observation_id` is present.
- Do not add bulk import/export, drafts, labels, immutable versions, or editing an existing persisted item: current routes do not support these safely.

### 3.2 Evaluation dashboard

Add `/evaluations` and `/evaluations/$id` using **the existing Experiment resource**. The UI label may be “Evaluations”; preserve `/v1/experiments` and existing types/routes.

**Create/run evaluation**

- Select a Dataset from the selected project.
- Select an executable Evaluation Definition Version and its Dataset, then send the current `ExperimentCreate` admission shape: `project_id`, `dataset_id`, `evaluation_id`, `definition_version`, and `idempotency_key`. Name, Agent, model, prompt, evaluator, and execution overrides are not accepted by this compatibility starter.
- Before submit, load the dataset items. If an evaluator requires expected output and an item lacks it, block submission with an actionable count/link. Do not silently score missing references as failures.
- No agent selection: the real Agent registry/runtime is not implemented yet. `agent_id` remains absent/null, and the existing configured LLM runner is the only supported target.

**Run detail**

- Show live status using existing `/v1/experiments/{id}/events` SSE, summary, and per-item result rows.
- Link the user to the source dataset and evaluation-emitted traces when available.
- Provide cancellation only while `pending` or `running`; use the existing cancel endpoint.
- No experiment comparison, schedules, reusable evaluation definitions, custom scorers, or CI gate UI in this release.

### 3.3 Trace/observation → dataset flow

- Add a clearly named **Add to dataset** action in trace detail and selected Observation detail.
- Open a modal that requires the operator to choose an existing Dataset and displays editable JSON. Prefill `input` from the target’s sanitized input; prefill expected output from the selected target’s output only as a human-editable suggestion, never as automatically trusted ground truth.
- Submit the existing dataset-item route with `source_trace_id` and optional `source_observation_id`.
- Do not auto-create datasets or copy raw unsanitized OTLP metadata.

### 3.4 Feedback first pass

Feedback is standard metadata represented by a normal `scores` row:

```json
{
  "name": "human.feedback",
  "value": -1,
  "trace_id": "<32-hex OTLP trace id>",
  "observation_id": "<optional observation id>",
  "metadata": {
    "feedback": {
      "schema_version": 1,
      "sentiment": "negative",
      "reason": "incorrect_answer",
      "comment": "optional, sanitized, bounded text"
    }
  }
}
```

Required behavior:

- Support only `value: 1 | -1` and matching `sentiment: positive | negative`; reject arbitrary score names/values through the feedback command route.
- Require a project, a valid trace, and—when supplied—an observation belonging to that trace/project. Use not-found responses that do not disclose cross-project existence.
- Use a dedicated `POST /v1/feedback` instead of asking browser clients to write unrestricted scores. It must create the underlying score atomically with a small feedback-review row.
- Add `GET /v1/feedback` with project, sentiment, review status, trace, and observation filters; return only the safe feedback summary needed by the UI.
- Add a narrow review transition endpoint: `POST /v1/feedback/{id}/review` with `status: new | reviewed | dismissed | added_to_dataset` and optional bounded note. Treat this as workflow state separate from the immutable score.
- Negative feedback starts `new`; positive feedback is still listed but starts `reviewed`/non-queue by default. The Feedback page’s queue is negative feedback in `new` state.
- `POST /v1/feedback` requires an `Idempotency-Key` scoped to the Project. New feedback records the trusted server-resolved Actor and is unique for that Actor, Project, trace and optional Observation. A new key for the same target returns the original immutable feedback, even if its payload differs; reusing a key with another payload or Actor conflicts. `GET /v1/feedback/mine` reads only the current Actor's exact target, returning JSON null when none is recorded. Unknown legacy authors remain unknown, and historical duplicates and links are preserved.
- Comments and review notes are bounded plain text, rendered as text, and must not be inserted into ClickHouse trace/observation metadata or full-text search. Do not copy secrets/raw OTLP payloads into feedback rows.

**Feedback page**

Add `/feedback` with:

- **Needs review** tab: negative `new` items only.
- **All feedback** tab: positive and negative entries with sentiment, reason, target type, creation time, source trace/observation link, and review state.
- Filters for sentiment, review status, and target type; no semantic clustering.
- Review detail/action: mark reviewed or dismissed, or open the existing **Add to dataset** flow. Only mark `added_to_dataset` after the dataset item POST succeeds.

**Trace UI**

- Add compact thumbs-up/thumbs-down controls to the trace header and selected Observation panel.
- Negative feedback prompts for a required reason and optional comment; positive feedback may use an optional comment.
- Preserve the selected target label so a reviewer can distinguish trace-level from observation-level feedback.
- Success state must say “Recorded” / “Added to review queue,” not imply training, optimization, or a product fix.

### 3.5 Persistence and events

- Add **one new migration numbered after `0018_benchmark_evaluations.sql`**. Do not edit existing migrations.
- Extend `scores` minimally for observation-targeted feedback if needed; add tables/indexes for feedback review state and idempotency. Keep the score as the immutable signal and review state as mutable workflow metadata.
- Add repository functions and route-level dependency injection following `datasets.ts` and `experiments.ts`; test project isolation and error mapping.
- Publish a small, sanitized event-bus notification only if the existing event-bus pattern makes live Feedback UI practical without polling. Do not introduce a new queue/worker just for this first pass.

---

## 4. Explicitly deferred work (must be documented, not built)

Create/update a repository design document (for example `docs/06-dataset-feedback-future.md`) covering these future contracts. The implementation must not leave fake UI controls or partially implemented database states for them.

### Dataset and evaluation lifecycle

- Immutable Dataset Versions, mutable drafts, protected labels, content hashes, version diffs, rollback, and version-pinned evaluation runs.
- Saved reusable Evaluation Definitions distinct from Evaluation Runs; default dataset selectors and evaluation-version history.
- Dataset item editing/revisions, bulk import/export, schemas, dataset ownership/archive/tombstones, and CI-only version pins.
- First-class Python/TypeScript SDK convenience APIs for datasets/evaluations beyond generated REST clients.

### Agent execution and richer evaluation

- Agent registry, manifest versions, framework introspection, HTTP endpoint execution, and manifest-bound runs.
- Custom, LLM-as-judge, code, RAG, and calibrated evaluators; comparisons, schedules, CI gates, and protected environments.
- Experiment comparison/baselines and version-aware result analysis.

### Feedback flywheel maturity

- Ownership/assignment, multi-reviewer approval, and a feedback-specific content-free audit ledger.
- Dataset candidates versus active cases, explicit curator promotion, feedback-to-version lineage, and automated “protected by run” display.
- PII/secret detection/redaction workflows, retention/deletion controls, evidence snapshots, and policy approvals.
- Exact/semantic dedupe, feedback clusters, priority models, similarity search, notification/alerting, and cross-run failure analysis.
- Judge calibration, training/fine-tuning exports, prompt optimization, or any automatic evaluator/model/production mutation.

**Permanent safety rule:** raw positive/negative feedback is never ground truth and must never automatically change an evaluation gate, prompt, model, dataset, or deployment.

---

## 5. Implementation constraints

- Preserve project scoping on every new query, route, and UI fetch.
- Keep product terminology consistent: use **Observation** in API/data model; “span” remains a UI/OTel alias only.
- Preserve the existing trace viewer architecture, SSE conventions, API error envelopes, structured logging, Zod/OpenAPI source of truth, and `authedFetch` client pattern.
- Use current Bun workspace scripts. Before claiming verification, run the smallest relevant suites plus `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run build`, and targeted API/web tests. Run `make test-db-migrations` when changing migrations. Docker/provider flows must be reported honestly when unavailable.
- Update `docs/04-glossary.md` for every new public term/route/page, and update `docs/02-roadmap.md` to distinguish this first pass from the deferred maturity work.
- Do not modify the already merged dataset/evaluation behavior unless a regression test proves the change is necessary.

---

## 6. Acceptance criteria

1. Dashboard users can list/create datasets and manually add/delete JSON cases in the selected project.
2. Existing REST dataset CRUD remains compatible and project-scoped.
3. Dashboard users can create a supported evaluation against a selected dataset, see live status/results, and cancel it.
4. Evaluation creation rejects a reference-based evaluator if the selected dataset contains missing expected outputs.
5. Trace and selected Observation views can create a dataset item with source trace/observation provenance and an editable, sanitized payload preview.
6. `POST /v1/feedback` validates target ownership and writes exactly one `human.feedback` score plus review state under an idempotency key.
7. A malformed feedback payload, mismatched sentiment/value, bad trace, or cross-project observation produces a safe validation/not-found error and writes nothing.
8. The Feedback page shows all positive/negative feedback and a distinct negative Needs review queue.
9. A reviewer can transition a negative item to reviewed/dismissed or add it to an existing dataset; the last transition is only stored after successful dataset creation.
10. Feedback comments are bounded and safely rendered; they are not injected into ClickHouse trace metadata/search.
11. No implementation auto-promotes a case, invokes an LLM, changes a prompt/model/evaluator, or modifies production behavior from feedback.
12. The future design document, glossary, and roadmap explicitly capture versioning, agent manifests, SDK depth, RBAC/audit, candidate promotion, data-policy, dedupe, and automation as deferred work.
13. API, migration, and web tests cover the new behavior; all available repository quality gates pass.
