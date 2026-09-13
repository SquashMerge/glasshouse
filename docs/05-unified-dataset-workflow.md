# Unified Dataset Workflow

## Evaluation definitions

`/v1/evaluations` creates a stable, project-scoped Evaluation identity with one ETag-revisioned definition draft. Publishing the draft creates an immutable, content-hashed Definition Version bound to a concrete immutable Dataset Version; publication is idempotent for equivalent canonical content and returns its stored durable publishing Actor ID as `published_by`. Definitions use only typed baseline evaluator mappings, a configured-LLM target selector, execution defaults, and thresholds. `/v1/evaluations/{slug}/runs` admits and queues a reproducible run by resolving that immutable version and storing its target, evaluator, deterministic sample, and per-item snapshot before work starts. Pre-contract Definition Versions are returned with `definition_contract: "legacy_untyped"` and cannot be admitted; their stored evaluator JSON, absent sampling/limits, and original content hash are never synthesized or changed. Historical Experiments and benchmark suites remain explicit legacy ad-hoc structural records; new Experiment/benchmark start requests must provide admission fields and cannot seed from mutable Dataset rows.

Canonical Evaluation slugs are required for archive, restore, tombstone, draft replacement, and publication. UUID Evaluation IDs remain a read-only compatibility selector for Evaluation, draft, and immutable-version detail or inspection requests.

**Status:** P2 Dataset lifecycle and P3 Evaluation identity, durable Runs, bounded evidence, comparison, and gates are implemented. The Agent Registry remains deferred; P4 ships only a client-reported introspection contract, not Agent execution or a target.

**Shipped Evaluation API:**

```http
GET    /v1/evaluations?project_id=
POST   /v1/evaluations?project_id=
GET    /v1/evaluations/compatibility?project_id=
GET    /v1/evaluations/{slug}?project_id=
DELETE /v1/evaluations/{slug}?project_id=                   # archive, If-Match
POST   /v1/evaluations/{slug}/restore?project_id=           # restore, If-Match
DELETE /v1/evaluations/{slug}/tombstone?project_id=         # tombstone, If-Match + confirmation_slug
GET    /v1/evaluations/{slug}/draft?project_id=
PUT    /v1/evaluations/{slug}/draft?project_id=             # If-Match
POST   /v1/evaluations/{slug}/draft/publish?project_id=     # If-Match
GET    /v1/evaluations/{slug}/versions?project_id=
GET    /v1/evaluations/{slug}/versions/{version}?project_id=
```

Archive, restore, and tombstone `204` responses return their quoted lifecycle
`ETag`.

**Future boundary:** Evaluation Run schedules and SDK invocation remain planned. Admission, configured-LLM execution, bounded evidence, comparison, and gates are shipped; existing `/v1/experiments` remains the distinct legacy ad-hoc execution API and is not an alias.

**Scope:** one project-scoped Dataset and Evaluation Definition foundation shared by the dashboard and REST API; this document preserves the future SDK and Evaluation Run roadmap separately.

## Decision summary (target model)

Astraea datasets work like prompts: a stable, named resource has immutable versions. A **Dataset** is the reusable logical collection; a **Dataset version** is the exact immutable item snapshot consumed by an evaluation. An **Evaluation definition** is a reusable, versioned recipe that binds one target selector, one dataset selector, mappings, evaluators, and execution defaults. A future **Evaluation run** is one execution of a definition revision against resolved immutable versions.

The shipped Definition target selector supports the configured-LLM contract before the Agent Registry exists. A future Agent/Manifest target uses the same selector and resolution boundary rather than creating a second Evaluation model. The dashboard and REST API use the same Evaluation identity/Definition Version entities; SDK invocation remains future work. There is no separate “UI dataset” or “SDK dataset,” and no Evaluation Run may execute a mutable draft.

### Target defaults for future execution

| Decision | Default | Why |
|---|---|---|
| Run reproducibility | Pin the current published dataset version at run creation | “Passed” must remain explainable after later edits. |
| Editing | Dataset edits occur in a draft; **Publish version** creates the next immutable version | Avoid silently changing a regression suite. |
| Dataset binding | `pinned` is default; `latest_published` is allowed only for manually triggered/scheduled definitions, never CI gates | Convenience must not create nondeterministic CI. |
| Dataset item shape | Canonical `input`, optional `expected_output`, optional `metadata`; schema records field meaning/validation | Supports generic agents while keeping evaluator mapping explicit. |
| Dataset identity | Project-local immutable `slug`, human-editable `name`; a deleted slug is tombstoned | Stable code references and no accidental identity reuse. |
| Authoring provenance | Each version records `created_via` (`ui`, `api`, `sdk`, `trace_import`, `csv_import`) and actor/source metadata | Makes ownership and change origin visible without splitting products. |
| Execution | A definition revision resolves exactly one immutable target snapshot and one Dataset version before queueing; the target may be the current configured-LLM contract or, later, an Agent/Manifest version | This is the unit compared in results/CI. |
| Existing terminology | The shipped reusable object is **Evaluation**; current `/v1/experiments` remains a distinct legacy ad-hoc execution API alongside Evaluation Runs | Avoids breaking MVP clients while giving users one consistent vocabulary. |

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
 │   ├─ configured-LLM Definition selector (shipped)
 │   └─ Agent → Manifest version (P4; planned)
 ├─ Evaluation (stable reusable definition)
 │   └─ Evaluation definition version 1..n (immutable recipe)
 │       ├─ target selector → resolved target snapshot at run time
 │       └─ dataset selector → resolved Dataset version at run time
  └─ Evaluation run (shipped P3; distinct from current Experiment)
     ├─ resolved evaluation-definition version
     ├─ resolved dataset version
     ├─ resolved target snapshot (and manifest version when applicable)
     └─ Run item results, scores, trace links
```

### Canonical terms

- **Dataset:** project-scoped named collection with a stable slug, description, tags, and version history. It is not itself a runnable snapshot.
- **Dataset draft:** editable working copy of the next dataset version. An Admin, or a User with access to the Project, can change it; a Read-only user cannot. A draft can be discarded; it is never selected by a run.
- **Dataset draft curation:** manual and import rows use the same versioned validation contract. Imports are atomic: duplicate keys in the submitted batch or the shared draft return per-row errors and never upsert or partially overwrite content. Any row that carries Trace or Observation provenance rereads that selected source on the server, applies the active redaction policy, stores safe project-scoped provenance and an explicit review state, and never publishes a Dataset.
- **Dataset version:** immutable ordered snapshot of items plus its schema/mapping contract. Displayed as `support-regression@12`.
- **Dataset item:** one test case. `input` is sent to the target; `expected_output` and `metadata` are evaluator inputs. Item identity remains stable across versions when carried forward.
- **Evaluation:** stable reusable definition, for example “Support quality gate.” It has a version history just as a prompt does.
- **Evaluation definition version:** immutable target selector, dataset selector, evaluator configuration, mappings, and run defaults. Displayed as `support-quality-gate@4`.
- **Evaluation run:** durable execution and results with resolved IDs/hashes; the existing MVP API/database term is the distinct legacy **Experiment**.

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

## Future Evaluation Run UX journeys

The following journeys describe intended UI and SDK workflows. They are not a
claim that the corresponding UI or SDK wrapper is shipped; the registered REST
surface is listed below.

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
2. A modal identifies the selected observation and asks for a destination dataset. Selecting **Create dataset** does not leave context.
3. The browser submits only `source_trace_id` and optional `source_observation_id`. Astraea rereads that project-scoped source on the server, applies the active redaction policy, and stores only the resulting safe draft content and provenance.
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

## Data model and target execution invariants

The Evaluation Run tables, resolution fields, and execution invariants in this
section describe the shipped P3 admission and execution contract. Schedules,
SDK invocation, and Agent Registry targets remain deferred.

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
- **Draft collision default:** one shared draft per Dataset. Save uses an ETag/revision; a conflict returns the current revision and a field-level current/requested diff. Clients must require an explicit refresh and retry; the server and UI never auto-merge curator changes. V2 may add personal drafts, but not before conflict visibility works.
- **External-key upsert:** the direct draft-item API upserts by `item_key` only. Import is deliberately different: an existing key is a row-level conflict so a bulk review cannot silently overwrite shared content. The server never deduplicates cases by JSON equality or model output.
- **Delete behavior:** archive Datasets by default. Project Admins alone may restore, export, or tombstone a Dataset. Tombstoning is a typed-slug-confirmed hard deletion and is rejected while immutable versions, historical/queued/scheduled runs, retention holds, benchmark links, or feedback links remain. A successful tombstone reserves the slug permanently.

Draft item removal uses `DELETE /v1/datasets/by-slug/{slug}/draft/items/{itemId}` with the draft `If-Match` ETag. Legacy `/items/{id}` write endpoints remain deprecated and return `409`; published versions are immutable.
- **Project isolation:** every lookup and foreign key includes project scope; cross-project attachment returns `404`, not an existence leak.

## API and SDK surface

The generated API exposes the registered REST routes below. Every Evaluation
route requires `?project_id=<UUID>` and server-side Project authorization. UI
journeys and SDK wrappers remain future work; generated clients do not add a
handwritten `client.evaluations` workflow.

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
GET    /v1/datasets/by-slug/{slug}/export?project_id=&format=csv|jsonl&representation=draft|version&version=
POST   /v1/datasets/by-slug/{slug}/restore?project_id= # Project Admin, If-Match Dataset revision
DELETE /v1/datasets/by-slug/{slug}/tombstone?project_id= # Project Admin, typed slug + If-Match Dataset revision

# Registered Evaluation definitions and Run execution
POST   /v1/evaluations?project_id=
GET    /v1/evaluations?project_id=
GET    /v1/evaluations/{slug}?project_id=
DELETE /v1/evaluations/{slug}?project_id=              # archive
POST   /v1/evaluations/{slug}/restore?project_id=
DELETE /v1/evaluations/{slug}/tombstone?project_id=
GET    /v1/evaluations/{slug}/draft?project_id=
PUT    /v1/evaluations/{slug}/draft?project_id=
POST   /v1/evaluations/{slug}/draft/publish?project_id=
GET    /v1/evaluations/{slug}/versions?project_id=
GET    /v1/evaluations/{slug}/versions/{version}?project_id=
POST   /v1/evaluations/{slug}/runs?project_id=
GET    /v1/evaluation-runs?project_id=
POST   /v1/evaluation-runs/compare?project_id=
GET    /v1/evaluation-runs/{id}?project_id=
GET    /v1/evaluation-runs/{id}/evidence?project_id=
GET    /v1/evaluation-runs/{id}/events?project_id=      # SSE notification stream
POST   /v1/evaluation-runs/{id}/cancel?project_id=
POST   /v1/evaluation-runs/{id}/retry?project_id=
PUT    /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id=
GET    /v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}?project_id=

# Existing Experiment execution API (shipped legacy ad-hoc surface, not an Evaluation Run alias)
POST   /v1/experiments                         # legacy JSON-body project_id adapter; optional query must normalize equal
GET    /v1/experiments?project_id=               # legacy run collection/read model
GET    /v1/experiments/{id}?project_id=          # legacy execution detail
GET    /v1/experiments/{id}/results?project_id=  # legacy execution results
GET    /v1/experiments/{id}/summary?project_id=  # legacy execution summary
GET    /v1/experiments/{id}/events?project_id=   # legacy execution SSE
POST   /v1/experiments/{id}/cancel?project_id=   # legacy execution cancellation
```

`POST /v1/datasets` accepts `slug` optionally; new clients supply `?project_id=<UUID>`, while the compatibility adapter accepts the existing body `project_id` and rejects a nonmatching query/body pair. The server derives and reserves a normalized slug otherwise. Dataset slugs use the explicit `/by-slug/{slug}` namespace, so UUID-shaped slugs remain valid and cannot collide with retained `{id}` routes. The draft/version workflow described above remains a target contract until its routes are registered.

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
  "trigger_metadata": { "source": "ci", "build_number": 42 }
}
```

This is the current strict request shape. Dataset, target, and run overrides,
plus their UI presentation and CI SDK workflow, remain future work.

### Future Python SDK

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

Planned TypeScript SDK support mirrors these nouns and methods. SDK `ensure`,
`upsert`, and `publish` require idempotency keys by default in CI mode.
`evaluate(dataset=...)` remains a convenience method but creates an **ad hoc
run**; it must return the generated snapshot/definition IDs and should not
become a second durable definition model.

### Imports and exports

- Draft import uses the canonical API item shape and is capped at 500 rows. It runs the same authorization, validation, source-provenance reread, redaction, revision-history, and audit controls as manual curation. Duplicate submitted keys and keys already in the shared draft reject the entire request with `items/{row}/item_key` errors; import never silently upserts or partially overwrites a draft.
- Project Admin export requires an explicit `representation=draft` or `representation=version`; immutable-version export also requires its explicit version. Only CSV and JSONL are available. Every export is project-scoped, applies the currently approved redaction policy to input, expected output, and metadata, and preserves safe actor/source identifiers and capture context.
- Exports are generated in memory only after the complete representation is checked against a 500-item and 1,048,576-byte limit. Requests over either limit fail before any output is sent, rather than returning a partial file.

## UX information architecture

The existing dashboard exposes the shipped Definition foundation. Screens and
interaction rules below that depend on schedules or SDK execution are future UX
work. Shipped Run evidence, comparison, and gates remain server-authoritative.

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
| `/evaluation-definitions/:slug` | Definition overview | resolved/declared binding, used Dataset/target cards, version history, Run now, runs table. |
| `/evaluation-definitions/:slug/edit` | New definition draft | structured editor; changes never mutate published revision. |
| `/evaluations/:id` | Investigate an execution | immutable provenance header, live progress, result table, filters, side-by-side baseline comparison. This preserves bookmarked legacy Experiment run links. |

### Critical interaction rules

- The primary action is precise: **Publish v4**, **Run v3**, and **Run evaluation**; never generic “Save” where publication/execution matters.
- Every picker displays `slug@version`, item count, last published time, and whether it is **Pinned** or **Follow latest**.
- “Follow latest” has an amber nondeterminism warning and cannot be selected for release-gate/CI definitions.
- The run review header always states the resolved target, `dataset@N`, and `evaluation@N`; an Agent target includes `agent@hash` only after P4.
- Draft changes are visible but not conflated with published data. A source-trace import adds a badge “Unpublished; not used by runs.”
- Published versions are read-only. **Fork to draft** is the only editing affordance from a version page.
- Trace provenance is a link/chip with an access-aware empty state (“source expired or unavailable”), never a copied hidden payload.
- Users need not choose a JSON Schema expert mode for simple cases. The default grid exposes detected fields; **Schema & mappings** is an advanced drawer with a stable canonical preview.

## Migration and remaining execution work

1. **Preserve reads:** existing `datasets`/`dataset_items` remain readable. Backfill each existing dataset as `dataset@1`, preserving item UUID as `item_key`, order by `created_at, id`, and existing trace provenance.
2. **Add snapshot tables:** introduce Dataset/Evaluation version and draft tables in a new migration; do not alter past migrations. Every tenant-bearing child table gets a non-null `project_id`, composite Project-scoped foreign keys, `slug`, `latest_published_version`, audit/provenance fields, and tombstones. Backfill scope only from validated parents; delete or safely terminalize ambiguous legacy rows rather than assigning a Project by guesswork.
3. **Adapt experiments:** add `project_id`, `evaluation_id`, `evaluation_version_id`, `dataset_version_id`, a resolved target snapshot, and optional future `manifest_version_id` fields to Experiments. Use composite Project-scoped foreign keys for every resolved attachment. Backfill legacy Experiments with an implicit immutable “legacy ad hoc” definition/version rather than inventing historical intent.
4. **API compatibility:** retain the current UUID Dataset routes for one minor version: `GET /v1/datasets?project_id=<UUID>`, `GET /v1/datasets/{id}?project_id=<UUID>`, `GET /v1/datasets/{id}/items?project_id=<UUID>`, and `DELETE /v1/datasets/{id}/items/{itemId}?project_id=<UUID>`. `GET /v1/datasets/by-slug/{slug}/versions` and its `{version}` detail provide read-only immutable-version inspection. Retained `POST /v1/datasets` and `POST /v1/datasets/{id}/items` use the body-scoped adapter above; an optional query selector must match the body selector. Retain the complete legacy Experiment execution surface alongside shipped Evaluation Runs: `GET /v1/experiments?project_id=<UUID>`, `GET /v1/experiments/{id}?project_id=<UUID>`, `GET /v1/experiments/{id}/results?project_id=<UUID>`, `GET /v1/experiments/{id}/summary?project_id=<UUID>`, `GET /v1/experiments/{id}/events?project_id=<UUID>`, and `POST /v1/experiments/{id}/cancel?project_id=<UUID>`; retained `POST /v1/experiments` uses the body-scoped adapter. New Experiments return a `versioned` resolved Dataset Version ID; pre-version rows report `legacy_unversioned` and no resolved ID. Deprecate direct mutation of published `dataset_items`; route new writes through drafts.
5. **UI rollout:** Dataset/versioning and Evaluation identity/Definition Version
   routes are shipped. Future Evaluation Run work can switch “Run experiment”
   labels to “Run evaluation”; keep `Experiment` only in technical
   compatibility/API deprecation notices.

## Acceptance criteria for remaining work

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
