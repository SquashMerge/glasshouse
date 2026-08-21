# Unified Dataset Workflow

**Status:** proposed implementation contract for roadmap P2/P3; it deliberately precedes the planned Agent Registry.
**Scope:** one project-scoped dataset system for dashboard-authored and SDK/API-authored evaluations.

## Decision summary

Astraea datasets work like prompts: a stable, named resource has immutable versions. A **Dataset** is the reusable logical collection; a **Dataset version** is the exact immutable item snapshot consumed by an evaluation. An **Evaluation definition** is a reusable, versioned recipe that binds one target selector, one dataset selector, mappings, evaluators, and execution defaults. An **Evaluation run** is one execution of a definition revision against resolved immutable versions.

The target selector deliberately supports the current configured-LLM execution target before the Agent Registry exists. A future Agent/Manifest target uses the same selector and resolution boundary rather than creating a second Evaluation model. The dashboard and SDK use the same API and entities. There is no separate “UI dataset” or “SDK dataset,” and no eval may execute a mutable draft.

### Opinionated defaults

| Decision | Default | Why |
|---|---|---|
| Run reproducibility | Pin the current published dataset version at run creation | “Passed” must remain explainable after later edits. |
| Editing | Dataset edits occur in a draft; **Publish version** creates the next immutable version | Avoid silently changing a regression suite. |
| Dataset binding | `pinned` is default; `latest_published` is allowed only for manually triggered/scheduled definitions, never CI gates | Convenience must not create nondeterministic CI. |
| Dataset item shape | Canonical `input`, optional `expected_output`, optional `metadata`; schema records field meaning/validation | Supports generic agents while keeping evaluator mapping explicit. |
| Dataset identity | Project-local immutable `slug`, human-editable `name`; a deleted slug is tombstoned | Stable code references and no accidental identity reuse. |
| Authoring provenance | Each version records `created_via` (`ui`, `api`, `sdk`, `trace_import`, `csv_import`) and actor/source metadata | Makes ownership and change origin visible without splitting products. |
| Execution | A definition revision resolves exactly one immutable target snapshot and one Dataset version before queueing; the target may be the current configured-LLM contract or, later, an Agent/Manifest version | This is the unit compared in results/CI. |
| Existing terminology | UI calls the reusable object **Evaluation** and its execution **Run**; current `/v1/experiments` remains a compatibility alias for a run during migration | Avoids breaking MVP clients while giving users one consistent vocabulary. |

## Jobs to be done

1. “Turn a bad production trace into a durable regression case, explain where it came from, and add it to the suite I already use.”
2. “Curate a dataset in the UI, publish it, attach it to an evaluation, and run it without writing a script.”
3. “Create/update the same dataset in code or CI, then run the same evaluation definition that product/QA uses in the UI.”
4. “Know exactly which dataset, evaluator, and agent version produced a result months later.”
5. “Safely improve a suite without silently changing a scheduled evaluation or a release gate.”

## Core concepts and relationships

```text
Project
 ├─ Dataset (stable id + slug; mutable metadata only)
 │   ├─ Dataset draft (private working state)
 │   └─ Dataset version 1..n (published immutable snapshot)
 │       └─ Dataset item snapshot 1..n
 ├─ Evaluation target
 │   ├─ configured-LLM target snapshot (P3)
 │   └─ Agent → Manifest version (P4; planned)
 ├─ Evaluation (stable reusable definition)
 │   └─ Evaluation definition version 1..n (immutable recipe)
 │       ├─ target selector → resolved target snapshot at run time
 │       └─ dataset selector → resolved Dataset version at run time
 └─ Evaluation run (formerly Experiment)
     ├─ resolved evaluation-definition version
     ├─ resolved dataset version
     ├─ resolved target snapshot (and manifest version when applicable)
     └─ Run item results, scores, trace links
```

### Canonical terms

- **Dataset:** project-scoped named collection with a stable slug, description, tags, and version history. It is not itself a runnable snapshot.
- **Dataset draft:** editable working copy of the next dataset version. An Admin, or a User with access to the Project, can change it; a Read-only user cannot. A draft can be discarded; it is never selected by a run.
- **Dataset draft curation:** manual and import rows use the same versioned validation contract. Trace, Observation, and reviewed Feedback capture rereads the selected source on the server, applies the active redaction policy, stores safe project-scoped provenance and an explicit review state, and never publishes a Dataset.
- **Dataset version:** immutable ordered snapshot of items plus its schema/mapping contract. Displayed as `support-regression@12`.
- **Dataset item:** one test case. `input` is sent to the target; `expected_output` and `metadata` are evaluator inputs. Item identity remains stable across versions when carried forward.
- **Evaluation:** stable reusable definition, for example “Support quality gate.” It has a version history just as a prompt does.
- **Evaluation definition version:** immutable target selector, dataset selector, evaluator configuration, mappings, and run defaults. Displayed as `support-quality-gate@4`.
- **Evaluation run:** an execution and its results. It records all resolved IDs/hashes; it is the thing called an `experiment` by the existing MVP API/database.

### P1 authorization prerequisites

The P2/P3 contract depends on the P1 Admin/User/Read-only model. Every request
must carry exactly one mandatory `project_id` selector. The server validates
that selector against the authenticated internal actor's organization and
Project membership, then applies every resource predicate with that same
Project. A slug or run ID alone never establishes scope or authorization.

| Operation | Admin | User with Project access | Read-only with Project access |
|---|---|---|---|
| View Datasets, Evaluations, Runs, and safe provenance | Allowed | Allowed | Allowed |
| Create/import/edit/discard Dataset drafts; validate/publish Dataset versions | Allowed | Allowed | Denied |
| Create/edit/publish Evaluation definitions; start/cancel ordinary runs | Allowed | Allowed | Denied |
| Archive/delete Dataset or Evaluation resources; configure protected gates/schedules | Allowed | Denied | Denied |

The API, worker, SSE subscription, and UI must all enforce this matrix. A
Read-only client must receive a server-side authorization failure for every
mutation or execution attempt, including a stale or hand-crafted request.

## User journeys

### 1. Create a UI-authored regression dataset and run it

1. User opens **Datasets** and selects **New dataset**.
2. They enter name, optional slug/description/tags, and choose **Start empty**, **Import CSV/JSONL**, or **From traces**.
3. The editor shows a required input mapping and optional expected-output/metadata mappings. For an empty dataset, Astraea offers a canonical row editor; for import, it previews source columns and requires the user to confirm mappings before any publish.
4. User adds/edits cases in the draft. Validation errors are per-cell and publishing is disabled until all rows meet the saved schema.
5. User selects **Publish v1**. The confirmation states item count, validation state, and that published versions cannot be edited. Astraea creates `dataset@1` and returns to its Overview.
6. User selects **Run evaluation**. If no evaluation exists, the inline wizard creates one with: selected dataset pinned to `@1`, selected target, evaluator(s), and a name. If one exists, the picker shows whether it pins a version or follows latest published.
7. The review screen shows the resolved target snapshot, Dataset version, evaluator versions/settings, estimated case count, and sample rate. **Start run** queues an immutable run.
8. Results link every failed case to its input, expected output, output, scores, generated trace, and source production trace when available.

### 2. Capture a production failure into an existing suite

1. On a trace/observation detail, user chooses **Add to dataset**.
2. A modal shows the selected observation’s extracted input/output and asks for a destination dataset. Selecting **Create dataset** does not leave context.
3. User maps source data to canonical fields and may redact/edit values. The modal always preserves `source_trace_id` and `source_observation_id`; it never imports secrets stripped at ingest.
4. If the destination has a draft, the case is added there. Otherwise Astraea creates a draft from the latest published version and labels it “Unpublished changes.”
5. Dataset Overview visibly shows “1 unpublished change.” The user must publish a new version before an attached pinned evaluation can consume it.
6. User can launch a comparison run from the publish confirmation: baseline `@N` versus candidate `@N+1`, same target/evaluators.

### 3. SDK/API owns the suite; UI remains the inspection and control plane

1. A developer creates a named dataset or obtains it by slug from an SDK script.
2. The script upserts items into a new draft using deterministic external keys, validates, and publishes it with a source Git SHA.
3. The script creates or updates an Evaluation definition with `dataset: { slug, version }`, or invokes an existing definition by slug.
4. The run appears in the exact same UI, with a **Created from SDK** badge and a link to the Git commit when supplied.
5. A UI user may inspect or fork the dataset but cannot silently change an SDK-pinned version. They can create a new UI draft/version, then deliberately update the definition/CI config to reference it.

### 4. UX-authored evaluation reused from CI

1. An evaluator creates “Checkout quality gate” in the UI and publishes definition `@3` with `checkout-regression@8` pinned.
2. CI invokes `client.evaluations.run(definition="checkout-quality-gate", version=3)`.
3. Astraea resolves the already-pinned definition and returns a run ID. CI waits for completion and evaluates the configured threshold.
4. If a user later edits either object, Astraea creates `dataset@9` and/or `evaluation@4`; CI continues using `@3` until its code is changed. The UI makes this intentional divergence obvious.

## Data model and invariants

### Logical tables

The schema may use copy-on-write/item-link storage internally, but the API contract is snapshot semantics.

| Entity | Required fields | Invariants |
|---|---|---|
| `datasets` | `id`, `project_id`, `slug`, `name`, `description`, `tags`, `latest_published_version`, timestamps, deletion audit fields | `(project_id, slug)` unique; `slug` never reused after deletion; name may change. |
| `dataset_drafts` | `id`, `project_id`, `dataset_id`, `base_version`, `schema`, `created_by`, `created_via`, timestamps | `project_id` is non-null and must match the Dataset through a composite Project-scoped foreign key; at most one active draft per Dataset by default; optimistic `revision` prevents overwrites. |
| `dataset_draft_items` | `id`, `project_id`, `draft_id`, stable `item_key`, `position`, `input`, `expected_output`, `metadata`, provenance | `project_id` is non-null and must match the draft; `item_key` unique within draft; position deterministic; item payload validates against draft schema. |
| `dataset_versions` | `id`, `project_id`, `dataset_id`, integer `version`, `schema`, `item_count`, `content_hash`, publication/audit metadata | `project_id` is non-null and must match the Dataset; `(dataset_id, version)` unique; immutable after publish; content hash covers canonical schema + ordered item snapshot. |
| `dataset_version_items` | `id`, `project_id`, `dataset_version_id`, `item_key`, `position`, payload, provenance | `project_id` is non-null and must match the Dataset version; immutable; `position` unique per version; payload is a snapshot, not a live reference. |
| `evaluations` | `id`, `project_id`, `slug`, `name`, description/tags, `latest_published_version` | Same stable-ID/tombstone behavior as datasets. |
| `evaluation_versions` | `id`, `project_id`, `evaluation_id`, integer `version`, `target_selector`, `dataset_binding`, `evaluators`, `mappings`, `run_defaults`, `content_hash` | `project_id` is non-null and must match the Evaluation through a composite Project-scoped foreign key; immutable; all referenced resources must be project scoped. |
| `evaluation_runs` | `id`, `project_id`, IDs for Evaluation/version, Dataset/version, resolved target snapshot, optional Agent/Manifest version, status, trigger/audit metadata | `project_id` is non-null and composite foreign keys require its Evaluation version, Dataset version, and optional Agent/Manifest version to belong to that same Project. Resolved references cannot change; Agent/Manifest fields are populated only for a P4 Agent target. |
| `evaluation_run_items` | `id`, `project_id`, `run_id`, `dataset_version_item_id`, output, scores, status, `trace_id` | `project_id` is non-null and must match both the Run and the Dataset version item; one result per sampled Dataset item; trace provenance is separate from generated trace link. |

### Storage tenancy invariant

Every tenant-bearing Dataset/Evaluation table has a non-null `project_id`.
PostgreSQL records use composite Project-scoped foreign keys—for example,
`(project_id, dataset_id)` for Dataset children and `(project_id,
dataset_version_id)` / `(project_id, evaluation_version_id)` for a Run—so a
valid individual UUID cannot cross a Project boundary. Parent tables expose the
needed unique `(project_id, id)` keys for those constraints.

A Run writes its Project ID and all resolved references atomically before it is
queued. Workers, recovery, result persistence, SSE snapshots/live events, and
all detail/list queries predicate on that persisted Project ID as well as the
resource ID; they never recover scope from a client request or an unscoped
parent lookup. The same Project is used for generated trace writes and
ClickHouse reads. Migration backfills must derive each child Project only from a
validated parent relationship; ambiguous or unscoped historical rows are not
attributed by guesswork and must be removed or terminalized safely.

### Payload contract

```ts
type DatasetCase = {
  item_key: string;              // caller supplied or server UUID; stable across versions
  input: Record<string, unknown>; // required target input
  expected_output?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>; // filterable labels, cohort, severity, etc.
  provenance?: {
    source_trace_id?: string;
    source_observation_id?: string;
    external_id?: string;        // source-system id; never a dedupe key by itself
  };
};

type DatasetSchema = {
  input_schema?: Record<string, unknown>;           // JSON Schema subset
  expected_output_schema?: Record<string, unknown>; // JSON Schema subset
  metadata_schema?: Record<string, unknown>;        // JSON Schema subset
  required_input_paths?: string[];                  // JSON Pointer paths
};

type DatasetBinding =
  | { mode: "pinned"; dataset_slug: string; version: number }
  | { mode: "latest_published"; dataset_slug: string };

type EvaluationTarget =
  | {
      kind: "configured_llm";
      provider: "openai_compatible" | "codex_cli";
      model: string;
      system_prompt?: string;
      settings: Record<string, unknown>;
    }
  | {
      kind: "agent_manifest"; // P4; unavailable until the Agent Registry ships.
      agent_id: string;
      manifest: { mode: "pinned"; version: string };
    };

type EvaluationDefinition = {
  target: EvaluationTarget;
  dataset: DatasetBinding;
  mappings: {
    invocation_input: Record<string, string>; // target field -> JSON Pointer in item.input
    expected_output?: string;                 // JSON Pointer in item.expected_output
  };
  evaluators: Array<{ evaluator_id: string; version?: number; config: Record<string, unknown>; required: boolean }>;
  run_defaults: { sample?: { mode: "all" } | { mode: "count"; count: number; seed: number }; concurrency?: number; timeout_seconds?: number };
};
```

### Required behavior

- **Publish is atomic:** validation, hash generation, version allocation, snapshot creation, and `latest_published_version` update commit together.
- **Run resolution is atomic:** a transaction resolves the Evaluation version, Dataset selector, target snapshot, evaluator versions, and deterministic sample. The resolved values are written before work is queued. A Manifest version is required only after the P4 Agent target is selected.
- **Ordering is data:** item order is preserved in a dataset version and used for deterministic sampling/reporting; it is not incidental database insertion order.
- **Draft collision default:** one shared draft per dataset. Save uses an ETag/revision; conflicting edits require refresh/merge. V2 may add personal drafts, but not before conflict visibility works.
- **External-key upsert:** API/SDK upserts match `item_key` only. The server never deduplicates cases by JSON equality or model output.
- **Delete behavior:** archive datasets/evaluations by default. A version referenced by a run cannot be physically removed. Hard delete requires no versions/runs or a privileged retention job.

Draft item removal uses `DELETE /v1/datasets/by-slug/{slug}/draft/items/{itemId}` with the draft `If-Match` ETag. Legacy `/items/{id}` write endpoints remain deprecated and return `409`; published versions are immutable.
- **Project isolation:** every lookup and foreign key includes project scope; cross-project attachment returns `404`, not an existence leak.

## API and SDK surface

All operations use the existing `/v1` auth/project conventions and generated OpenAPI clients. **Every new endpoint below requires exactly one `?project_id=<UUID>` selector, including POST, detail, SSE, and cancel.** The SDK supplies that selector from its explicit Project configuration; the server still verifies membership and applies Project-scoped resource predicates. The current Dataset endpoints remain available during migration under the explicit body-scoped compatibility rule below; new endpoints make draft/version semantics explicit.

### REST

```http
# Dataset catalog and versions
GET    /v1/datasets?project_id=&q=&tag=
POST   /v1/datasets                          # new contract supplies ?project_id; legacy JSON-body project_id adapter remains valid
GET    /v1/datasets/by-slug/{slug}?project_id=
PATCH  /v1/datasets/by-slug/{slug}?project_id=       # metadata only
GET    /v1/datasets/{id}/items?project_id=            # shared draft when one exists; otherwise latest published items
GET    /v1/datasets/{id}/published-items?project_id=  # latest immutable published items only; execution preflight
GET    /v1/datasets/by-slug/{slug}/versions?project_id=
GET    /v1/datasets/by-slug/{slug}/versions/{version}?project_id=
POST   /v1/datasets/by-slug/{slug}/drafts?project_id= # optional explicit fork; default creates from latest
GET    /v1/datasets/by-slug/{slug}/draft?project_id=
PUT    /v1/datasets/by-slug/{slug}/draft/items/{itemKey}?project_id=  # upsert; If-Match draft revision
DELETE /v1/datasets/by-slug/{slug}/draft/items/{itemId}?project_id=
POST   /v1/datasets/by-slug/{slug}/draft/import?project_id= # CSV/JSONL/trace selections; async for large input
POST   /v1/datasets/by-slug/{slug}/draft/validate?project_id=
POST   /v1/datasets/by-slug/{slug}/draft/publish?project_id=
POST   /v1/datasets/by-slug/{slug}/draft/discard?project_id=

# Evaluations (reusable definitions) and runs
GET    /v1/evaluations?project_id=
POST   /v1/evaluations?project_id=            # create logical evaluation + draft definition
GET    /v1/evaluations/{slug}?project_id=
PATCH  /v1/evaluations/{slug}?project_id=      # metadata only
GET    /v1/evaluations/{slug}/versions?project_id=
GET    /v1/evaluations/{slug}/draft?project_id=
PUT    /v1/evaluations/{slug}/draft?project_id=
POST   /v1/evaluations/{slug}/draft/validate?project_id=
POST   /v1/evaluations/{slug}/draft/publish?project_id=
POST   /v1/evaluations/{slug}/runs?project_id= # body may choose definition version and run overrides
GET    /v1/evaluation-runs/{id}?project_id=
GET    /v1/evaluation-runs/{id}/results?project_id=
GET    /v1/evaluation-runs/{id}/summary?project_id=
GET    /v1/evaluation-runs/{id}/events?project_id= # SSE
POST   /v1/evaluation-runs/{id}/cancel?project_id=

# Temporary Experiment compatibility alias/read model (one minor version)
POST   /v1/experiments                         # legacy JSON-body project_id adapter; optional query must normalize equal
GET    /v1/experiments?project_id=               # legacy run collection/read model
GET    /v1/experiments/{id}?project_id=          # alias for EvaluationRun
GET    /v1/experiments/{id}/results?project_id=  # alias for EvaluationRun results
GET    /v1/experiments/{id}/summary?project_id=  # alias for EvaluationRun summary
GET    /v1/experiments/{id}/events?project_id=   # alias for EvaluationRun SSE
POST   /v1/experiments/{id}/cancel?project_id=   # alias for EvaluationRun cancellation
```

`POST /v1/datasets` accepts `slug` optionally; new clients supply `?project_id=<UUID>`, while the compatibility adapter accepts the existing body `project_id` and rejects a nonmatching query/body pair. The server derives and reserves a normalized slug otherwise. Dataset slugs use the explicit `/by-slug/{slug}` namespace, so UUID-shaped slugs remain valid and cannot collide with retained `{id}` routes. `POST /v1/datasets/by-slug/{slug}/draft/publish?project_id=<UUID>` accepts a required `expected_revision` and optional `message`, `source_git_sha`, and `idempotency_key`. Duplicate publish requests with the same idempotency key return the original version.

Draft-facing screens use `GET /v1/datasets/{id}/items` to show the shared editable state. Evaluation and benchmark preflight use `GET /v1/datasets/{id}/published-items`, so unpublished additions or removals cannot change executable cases until an explicit publish succeeds.

#### Legacy POST scope adapter

During the one-minor-version compatibility window, retained `POST /v1/datasets`,
`POST /v1/datasets/{id}/items`, and `POST /v1/experiments` continue to accept
the existing JSON-body `project_id` contract. They may also receive the new
`?project_id=<UUID>` selector: if both are present they must be the same after
UUID normalization or the server rejects the request as conflicting scope;
if only the legacy body selector is present, the request remains valid. If
neither selector is present, it fails before routing. Retained `GET` and
`DELETE` routes, which have no compatible body selector, require the query
selector. OpenAPI and generated SDKs expose the legacy body-scoped POST shapes
as deprecated adapters and the query-scoped shapes as the new contract.

`POST /v1/evaluations/{slug}/runs?project_id=<UUID>` accepts:

```json
{
  "definition_version": 3,
  "dataset_override": { "mode": "pinned", "dataset_slug": "checkout-regression", "version": 8 },
  "target_override": { "kind": "configured_llm", "provider": "openai_compatible", "model": "gpt-4.1", "settings": {} },
  "run_overrides": { "sample": { "mode": "count", "count": 25, "seed": 42 } }
}
```

Overrides are permitted in manual/API runs and displayed as **Run overrides**. CI-gate tokens must reject dataset or target overrides unless the evaluation definition explicitly permits them. `latest_published` is resolved at request time and the resulting version is stored on the run.

### Python SDK

```python
from astraea import Astraea

client = Astraea(project="support")

# Create once, then mutate a draft through a stable slug.
dataset = client.datasets.ensure(
    slug="support-regression",
    name="Support regression",
    schema={"required_input_paths": ["/question"]},
)
draft = dataset.draft(from_version="latest")
draft.upsert(
    item_key="refund-policy-001",
    input={"question": "Can I get a refund?"},
    expected_output={"answer": "..."},
    metadata={"severity": "high", "cohort": "refund"},
)
version = draft.publish(message="Add refund regression", source_git_sha="abc123")

# Reuse a UI-created definition exactly, suitable for CI.
run = client.evaluations.run(
    definition="support-quality-gate",
    version=3,
)
summary = run.wait(timeout=900)
summary.assert_thresholds()  # raises a typed CI-friendly failure

# Code-authored definition, explicit reproducible binding.
evaluation = client.evaluations.ensure(
    slug="support-quality-gate",
    name="Support quality gate",
)
evaluation.publish({
    "target": {"kind": "configured_llm", "provider": "openai_compatible", "model": "gpt-4.1", "settings": {}},
    "dataset": {"mode": "pinned", "dataset_slug": dataset.slug, "version": version.number},
    "mappings": {"invocation_input": {"message": "/question"}, "expected_output": "/answer"},
    "evaluators": [{"evaluator_id": "exact_match", "config": {}, "required": True}],
})
```

TypeScript mirrors these nouns and methods. SDK `ensure`, `upsert`, and `publish` require idempotency keys by default in CI mode. `evaluate(dataset=...)` remains a convenience method but creates an **ad hoc run**; it must return the generated snapshot/definition IDs and should not become a second durable definition model.

### Imports and exports

- UI accepts CSV and JSONL. CSV import requires an explicit mapping review; JSONL accepts canonical `DatasetCase` directly.
- SDK/API batch upsert supports JSONL streaming and a server-side import job for large suites. Maximum synchronous batch is 500 items; larger imports return `202` and an import-job event stream.
- Export always names a concrete version: JSONL canonical cases, optional CSV flattening, and a manifest containing schema/version/content hash. Never export an ambiguous “latest” by default.

## UX information architecture

### Global navigation

- **Datasets** — catalog, curation, provenance, version history, and entry point to runs.
- **Evaluations** — reusable definitions, their version history, schedules/gates, and run history.
- **Runs** — cross-evaluation run list; deep links from definition, Dataset, target, and CI.
- Existing **Observability** trace/observation pages get **Add to dataset** as a contextual action, not a separate workflow.

### Dataset screens

| Route | Primary purpose | Key UI elements |
|---|---|---|
| `/datasets` | Find/create reusable suites | search, tags, latest published version, draft badge, used-by count, last run, New dataset. |
| `/datasets/new` | Create/import | source choice, name/slug/description, schema/mapping setup, import preview. |
| `/datasets/:slug` | Safe overview | latest version, draft status, schema, item count, Used by evaluations, run history, **Edit draft**, **Run evaluation**. |
| `/datasets/:slug/draft` | Curate safely | editable virtualized grid, field/mapping drawer, provenance chips, validation summary, publish/discard. |
| `/datasets/:slug/versions/:n` | Inspect immutable evidence | read-only data grid, content hash, publish note/actor/source, compare-to selector, export. |

### Evaluation screens

| Route | Primary purpose | Key UI elements |
|---|---|---|
| `/evaluations` | Find reusable recipes | target, dataset binding, evaluator count, latest version, last run, gate/schedule status. |
| `/evaluations/new` | Build definition | stepper: target → dataset → mappings → evaluators → defaults/review. |
| `/evaluations/:slug` | Definition overview | resolved/declared binding, used Dataset/target cards, version history, Run now, runs table. |
| `/evaluations/:slug/edit` | New definition draft | structured editor; changes never mutate published revision. |
| `/evaluation-runs/:id` | Investigate an execution | immutable provenance header, live progress, result table, filters, side-by-side baseline comparison. |

### Critical interaction rules

- The primary action is precise: **Publish v4**, **Run v3**, and **Run evaluation**; never generic “Save” where publication/execution matters.
- Every picker displays `slug@version`, item count, last published time, and whether it is **Pinned** or **Follow latest**.
- “Follow latest” has an amber nondeterminism warning and cannot be selected for release-gate/CI definitions.
- The run review header always states the resolved target, `dataset@N`, and `evaluation@N`; an Agent target includes `agent@hash` only after P4.
- Draft changes are visible but not conflated with published data. A source-trace import adds a badge “Unpublished; not used by runs.”
- Published versions are read-only. **Fork to draft** is the only editing affordance from a version page.
- Trace provenance is a link/chip with an access-aware empty state (“source expired or unavailable”), never a copied hidden payload.
- Users need not choose a JSON Schema expert mode for simple cases. The default grid exposes detected fields; **Schema & mappings** is an advanced drawer with a stable canonical preview.

## Migration from the current MVP

1. **Preserve reads:** existing `datasets`/`dataset_items` remain readable. Backfill each existing dataset as `dataset@1`, preserving item UUID as `item_key`, order by `created_at, id`, and existing trace provenance.
2. **Add snapshot tables:** introduce Dataset/Evaluation version and draft tables in a new migration; do not alter past migrations. Every tenant-bearing child table gets a non-null `project_id`, composite Project-scoped foreign keys, `slug`, `latest_published_version`, audit/provenance fields, and tombstones. Backfill scope only from validated parents; delete or safely terminalize ambiguous legacy rows rather than assigning a Project by guesswork.
3. **Adapt experiments:** add `project_id`, `evaluation_id`, `evaluation_version_id`, `dataset_version_id`, a resolved target snapshot, and optional future `manifest_version_id` fields to Experiments. Use composite Project-scoped foreign keys for every resolved attachment. Backfill legacy Experiments with an implicit immutable “legacy ad hoc” definition/version rather than inventing historical intent.
4. **API compatibility:** retain the current UUID Dataset routes for one minor version: `GET /v1/datasets?project_id=<UUID>`, `GET /v1/datasets/{id}?project_id=<UUID>`, `GET /v1/datasets/{id}/items?project_id=<UUID>`, and `DELETE /v1/datasets/{id}/items/{itemId}?project_id=<UUID>`. Retained `POST /v1/datasets` and `POST /v1/datasets/{id}/items` use the body-scoped adapter above; an optional query selector must match the body selector. For the same window, retain the complete Experiment surface as query-scoped aliases for Evaluation Runs: `GET /v1/experiments?project_id=<UUID>`, `GET /v1/experiments/{id}?project_id=<UUID>`, `GET /v1/experiments/{id}/results?project_id=<UUID>`, `GET /v1/experiments/{id}/summary?project_id=<UUID>`, `GET /v1/experiments/{id}/events?project_id=<UUID>`, and `POST /v1/experiments/{id}/cancel?project_id=<UUID>`; retained `POST /v1/experiments` uses the body-scoped adapter. Return `dataset_version` when known. Deprecate direct mutation of published `dataset_items`; route new writes through drafts.
5. **UI rollout:** ship datasets/versioning first; then evaluation definitions; then switch “Run experiment” labels to “Run evaluation.” Keep `Experiment` only in technical compatibility/API deprecation notices.

## Acceptance criteria

### Dataset lifecycle

1. Creating a dataset via UI, API, or either SDK produces the same `datasets` resource and appears once in `/datasets` with an accurate `created_via` badge.
2. A user can create a draft from empty, CSV, JSONL, or trace/observation selection; every trace-created case retains trace and observation provenance after publishing.
3. Publishing a valid draft creates exactly one immutable numbered dataset version with a deterministic content hash and ordered item snapshot. Retrying the same idempotent publish does not create another version.
4. Invalid mappings/schema violations identify rows/fields and block publication; a validation failure creates no version.
5. Editing a dataset after publication changes only a draft. A completed past run continues to render the original dataset version and contents.
6. A UI or SDK item upsert with the same `item_key` updates one draft item; JSON-equal items with different keys remain distinct.
7. Deleting/archive behavior never removes a version or item snapshot referenced by an evaluation run.
8. For every Dataset route, Admin and Project-granted User requests succeed only inside their authorized Project; Read-only mutation/import/publish/archive requests are denied server-side, and same-slug cross-Project requests return the same non-disclosing not-found result as absent resources.
9. Database constraints reject cross-Project draft/version/run attachments even when an application caller bypasses a route guard; worker recovery and SSE use the persisted non-null Project scope and cannot emit or write against another Project.

### Evaluation attachment and execution

10. A published Evaluation definition can attach a Dataset by pinned version. The definition page shows the exact `dataset@version`, resolved target selector, evaluators, and mappings.
11. Starting a run records immutable resolved IDs/hashes for Evaluation definition, Dataset version, target snapshot, optional Agent/Manifest version, evaluator versions, and deterministic sample before queueing work.
12. A run launched from the UI, SDK, or REST against the same definition version produces the same resolved provenance header and executes through the same runner.
13. `latest_published` resolves once at run creation and persists the resulting Dataset version. It cannot be used by a CI-gate token or definition marked as a release gate.
14. Manual run overrides are recorded and visually labeled; gate/CI credentials reject undeclared target/Dataset overrides with a clear `403`/validation error.
15. Each run result links its Dataset item snapshot, generated trace, scores, output, and source production trace (when available) without exposing unavailable source data.
16. Every Evaluation, Run, result, SSE, cancellation, and `/v1/experiments` compatibility request requires the explicit Project selector and applies the same Admin/User/Read-only authorization matrix; Read-only execution attempts fail before work is queued.

### UX and quality

17. A first-time authorized User can create a Dataset, publish it, create an Evaluation, and start a run without raw JSON. Advanced mappings remain available without changing the canonical stored shape.
18. Every destructive or irreversible boundary is explicit: discard draft, archive resource, publish version, and start run each state its effect and target version.
19. Dataset/Evaluation list pages remain usable at 10,000 items/100 versions: server pagination/filtering and virtualized item grids; loading, empty, permission, conflict, and unavailable-provenance states are specified and tested.
20. Generated OpenAPI schemas, Python/TypeScript SDK types, REST handlers, and UI fixtures use the same Dataset-version/Evaluation-definition contract and mandatory Project selector; no UI-only field or SDK-only payload is required for core workflows.
21. Migration tests prove legacy Dataset items and Experiments remain visible and that new immutable snapshots do not alter historic result rendering.

## Open questions deliberately deferred

- **Multi-turn cases:** reserve `input`/`expected_output` as JSON objects so `messages` can be a field, but do not ship conversation-specific orchestration in v1.
- **Multiple datasets per definition:** v1 supports one dataset binding. Composite suites should be a new materialized dataset version, not hidden run-time concatenation; add composition after provenance/compare UX is proven.
- **Personal branching/review approvals:** v1 uses one shared draft plus optimistic concurrency. Add personal drafts and approval workflows only after RBAC/audit-log work.
- **Binary/multimodal attachments:** v1 stores JSON and trace links; introduce content-addressed object storage references later without changing the `DatasetCase` contract.
- **Scheduled evaluation cadence and baseline policy:** definitions reserve schedule/threshold fields, but scheduling and release policy are separate features. Their introduction must preserve pinned-version defaults.
