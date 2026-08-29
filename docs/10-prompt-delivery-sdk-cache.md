# Prompt delivery SDKs and cache policy (planned P4)

> **Status: proposal, not shipped.** Astraea currently has project-scoped,
> immutable prompt versions plus a dashboard/API management path and labels. It
> does **not** yet ship Python, TypeScript, or Java SDKs, a label-based
> prompt-delivery endpoint, a local cache, or provider-cache adapters. The names
> and examples in this document define the intended contract; they are not
> importable APIs.

## Decision

Offer **prompt delivery** alongside the future Python, TypeScript, and Java
SDKs. The SDK resolves a managed prompt to an immutable version, renders it
locally, and emits the existing prompt-provenance tuple. It includes a small,
bounded cache of **prompt definitions**, not a cache of model responses.

This is intentionally narrower than a shared LLM gateway/cache:

- Astraea owns version selection, integrity, local availability behavior,
  provenance, and cache observability.
- The application still owns request-specific data, retrieval, conversation
  memory, authorization to business data, and the model invocation.
- The provider owns its own prefix-cache lifecycle. Astraea may translate a
  declarative cache intent into provider-specific hints, but cannot promise a
  provider hit, retention, or global eviction. OpenAI explicitly does not offer
  manual prompt-cache clearing, and Anthropic's cache entries are ephemeral and
  provider-managed.[1][3]

This is a better product boundary than trying to cache rendered prompts or
completions centrally. A central response cache has unsafe key semantics for
agent state, retrieval, tools, identity, and nondeterministic generation; it
also makes Astraea an inline availability and data-residency dependency.

## Product goals and non-goals

### Goals

1. **Immutable reproducibility.** Every resolved prompt carries `(project_id,
   slug, version, content_hash)` and an evaluation or generation can report the
   exact tuple.
2. **Fast and resilient retrieval.** A warm SDK request must be local and must
   not block on a control-plane fetch; label changes become visible within a
   declared freshness bound.
3. **Provider-aware efficiency.** The SDK preserves stable prefix structure and
   can pass supported provider cache directives without exposing provider
   mechanics in application code.
4. **Cross-language parity.** Python, TypeScript, and Java expose the same
   selection, freshness, fallback, invalidation, and telemetry semantics, with
   shared conformance vectors.
5. **Tenant-safe delivery.** Every delivery request is authenticated,
   project-scoped, server-authorized, and isolated in the local cache.

### Non-goals

- caching LLM outputs, tool results, embeddings, RAG results, or agent state;
- proxying or storing provider API credentials;
- rendering application variables in Astraea or sending those variables to the
  control plane;
- claiming that a client can force a provider to evict an ephemeral prefix
  cache; or
- requiring Redis, a sidecar, or a shared disk for normal SDK use.

## The core model: resolve first, render locally

A **Prompt resolution** is a server-authorized, immutable response:

```json
{
  "identity": {
    "project_id": "7ca2f4a9-...",
    "slug": "support-agent",
    "version": 12,
    "content_hash": "4d9387..."
  },
  "messages": [
    { "role": "system", "content": "You are a support specialist..." },
    { "role": "user", "content": "{{customer_question}}" }
  ],
  "model": "provider/model-id-or-null",
  "settings": { "temperature": 0.2 },
  "cache_policy": {
    "provider_prefix": "prefer",
    "static_components": ["system", "tools"]
  },
  "resolved_selector": { "kind": "label", "value": "production" }
}
```

`identity` is the cache and provenance identity. A mutable selector such as a
label is only an input to resolution; it is never the identity of the delivered
prompt. This means a promotion yields a new immutable entry rather than
mutating an existing cached object.

The SDK performs Mustache rendering locally and accepts variables only in the
application process:

```python
# Illustrative planned Python API — not currently shipped.
prompt = client.prompts.resolve("support-agent", label="production")
messages = prompt.render({"customer_question": question})

# Use the immutable identity for the generation's Astraea provenance.
with client.generation_provenance(prompt):
    answer = provider.responses.create(model=prompt.model, input=messages)
```

The TypeScript and Java forms use the same concepts:

```ts
// Illustrative planned TypeScript API.
const prompt = await astraea.prompts.resolve("support-agent", { label: "production" });
const messages = prompt.render({ customer_question: question });
```

```java
// Illustrative planned Java API.
ResolvedPrompt prompt = astraea.prompts().resolve(
    "support-agent", PromptSelector.label("production"));
List<Message> messages = prompt.render(Map.of("customer_question", question));
```

A future generated OpenAPI client carries transport types; thin handwritten
language wrappers provide the cache, rendering, provider adapter, and tracing
ergonomics. No SDK may silently substitute a different prompt when an exact
`version` was requested.

## Delivery API and authorization contract

P4 should add a distinct SDK namespace rather than overload the management
routes:

```text
GET /v1/sdk/prompts/{slug}/resolve?project_id=<UUID>&version=<positive-int>
GET /v1/sdk/prompts/{slug}/resolve?project_id=<UUID>&label=<label>
```

Exactly one selector is required. `version` is an immutable pin; `label` is a
late-bound deployment selector. `project_id` is mandatory on every request;
the server derives the organization and Actor from authentication, verifies
active Project access, and predicates the lookup on that Project. A client
cache key must include the control-plane origin, authenticated-client identity
fingerprint, and project ID, as well as the selector or resolved immutable
identity. It must never contain the raw credential.

The response includes a strong validator for the resolved immutable identity.
SDKs use `If-None-Match` for revalidation and treat `304 Not Modified` as a
fresh confirmation of the same object. Label changes must result in a changed
response validator and a new immutable identity. Management authorization,
prompt editing, label promotion, and SDK delivery are separate permissions;
P4 must define the operation-by-role matrix and reject a direct/stale request
at the server boundary.

The API must return typed, non-content-bearing failures for missing scope,
invalid selector combinations, an inaccessible Project, a missing prompt, and
a missing label. It must not reveal whether a prompt exists in another Project.

## Cache design

### Recommended baseline: two policy layers, one required cache

Do **not** ship the old mandatory three-tier cache design. A durable on-disk
cache is useful for some long-lived services and cold-start-sensitive runtimes,
but it increases secret/data handling, migration, and corruption surface area.
The baseline is deliberately smaller:

| Layer | Default | Contents | Behavior |
|---|---|---|---|
| L1 process memory | Required | resolved immutable prompt definitions | bounded weighted LRU, single-flight fetches, fresh and stale-while-revalidate states |
| L2 local durable store | Opt-in | the same definitions plus validators, never rendered variables | encrypted/permission-restricted runtime-specific store, bounded independently, used only after integrity validation |
| Control plane | Required on cold miss or revalidation | canonical prompt definitions | authenticated conditional GET; server-side caching is an implementation detail |

The L1 cache is sufficient for ordinary services. L2 is an explicit deployment
choice for applications where restart survival has more value than the local
storage risk. It is not a cross-language shared SQLite database: each SDK owns
its runtime-local storage and concurrency semantics.

### Freshness, authorization, and availability

Each `resolve` call accepts a policy with explicit, bounded behavior:

```text
fresh_ttl          default 60 seconds; a fresh entry returns immediately only while its delivery capability is valid
max_stale          caller-selected bounded outage window, capped by the delivery capability; stale is never indefinite
revalidate         background by default; blocking only when caller selects strict mode
cache_mode         default | bypass | refresh | offline
```

- **Delivery capability:** every resolution carries a server-signed,
  project-scoped capability containing the control-plane origin, authenticated
  client identity, resolved Prompt identity, authorization epoch, and short,
  absolute `not_after` time. It uses the same trusted-key/rotation mechanism as
  a signed fallback bundle. The SDK verifies it and checks it *before every
  cache return*. It must reauthorize with the control plane before it expires,
  and must fail closed if the clock is unsafe or the capability is expired. The
  server advances/rejects the epoch when delivery access is revoked, the Project
  is archived/deleted, or the prompt is deleted. The server defines a hard
  maximum capability lifetime that callers cannot extend. This deliberately
  bounds—not erases—the authorization-revocation window; a local cache is never
  an indefinite authorization grant.
- **Fresh:** return immediately only while the associated delivery capability
  is valid; otherwise reauthorize before returning the entry.
- **Stale while revalidate:** return the last known immutable resolution and
  initiate one background conditional fetch, but only while its delivery
  capability remains valid. This preserves the request path while converging
  deployments. Langfuse documents the same high-availability
  stale-while-revalidate pattern for prompt SDK retrieval.[2]
- **Strict:** wait for revalidation and fail rather than using stale data. Use
  this for CI, evaluation, or a release gate—not the normal production path.
- **Offline:** use only a matching immutable local entry or a supplied signed
  fallback bundle with a still-valid delivery capability; never use a label
  whose final resolution cannot be known.
- **Error fallback:** return a stale entry only inside `max_stale`; then use a
  signed fallback bundle only when it carries a verified, currently valid
  delivery capability bound to the same client and immutable Prompt identity.
  Otherwise raise a typed `PromptUnavailable` error.

A fallback is a `PromptBundle` with an immutable identity and content hash, not
a bare prompt string. This preserves trace/evaluation provenance and makes a
fallback reviewable. A development-only escape hatch may accept an inline
fallback, but it must be visibly untracked and must not claim managed-prompt
provenance.

#### Signed fallback bundles

`PromptBundle/v1` is a signed, canonical payload containing: schema version;
canonical control-plane origin; Project ID; immutable Prompt identity; messages,
safe validated settings, and cache policy; `issued_at` and absolute `not_after`;
the complete server-signed delivery capability; signer key ID; and the content
hash. The bundle `not_after` may not exceed the embedded capability's
`not_after`. The SDK serializes the payload with the defined canonical JSON
algorithm and verifies an Ed25519 signature over those bytes.

Trusted public keys are bootstrapped from the authenticated control plane and
rotated by key ID with bounded overlap; SDK configuration may pin the initial
key set for an offline deployment. Verification is fail-closed: the signature,
key ID, issuer/origin, Project, content hash, schema version, clock window, and
authorization epoch must all match the configured client and requested prompt.
No private key, raw credential, or arbitrary user-provided public key belongs in
the bundle or ordinary SDK configuration. A bundle that fails verification may
only be used as an explicitly unmanaged local fallback and may not emit managed
prompt provenance.

### Cache keys, invalidation, and eviction

There are two different cache records:

1. **Selector records** map `(origin, client fingerprint, project, slug,
   label)` to a resolved immutable identity plus validator and freshness state.
   They are revalidated and may be locally invalidated.
2. **Immutable records** use `(origin, client fingerprint, project, slug,
   version, content_hash)`. Their content identity remains correct until
   evicted because a published version never changes, but they are never
   eligible to serve without a current delivery capability.

This split is the primary invalidation mechanism: a label promotion creates a
new selector result and a new immutable record. It avoids an unsafe distributed
"delete this object from every process now" promise.

The SDK exposes local controls:

```text
client.prompts.cache.invalidate(selector_or_identity)  # local process/store only
client.prompts.cache.clear(project_id=...)             # local scoped removal
client.prompts.prefetch([...])                          # explicit warm-up
```

A later opt-in delivery-event feed or webhook may invalidate **label selector
records** after a verified, content-free version-change event. It is an
acceleration, never a correctness dependency; ETag revalidation remains the
source of truth. Push events may not carry prompt source, rendered values, or
credentials.

Eviction is resource protection, not deployment invalidation. Both L1 and L2
must enforce maximum entry count, byte size, and estimated template-token size;
evict least-recently-used immutable records first and expire selector records
by freshness. Active objects remain usable after eviction. SDK telemetry records
an eviction reason without prompt source or variable values.

### Data handling and integrity

- Cache prompt templates and safe, schema-validated settings only. Never cache
  rendered prompts, Mustache variables, user messages, retrieval passages,
  model outputs, API keys, authorization headers, or raw OTLP payloads.
- Memory is the default. An opt-in durable store must be encrypted or protected
  by the platform's approved local-secret mechanism, owned by the application
  user, and bounded; it must support atomic replacement and corruption recovery.
- Validate response schema and content hash before caching. A mismatch is a
  typed integrity failure, clears the affected local record, and is observable
  without logging source content.
- Cache management APIs operate only within the configured client scope. One
  Project or authenticated service identity can never evict or read another's
  entries.

## Provider prefix-cache adapters

The provider adapter is a **best-effort performance layer**, not the Astraea
prompt-delivery cache. Provider APIs differ: OpenAI matches exact reusable
prefixes and supports cache keys/breakpoints for current GPT-5.6-family
behavior, while Anthropic supports automatic or explicit breakpoints with
short-lived cache controls.[1][3]

A resolved prompt therefore carries a provider-neutral intent, for example
`provider_prefix: "off" | "prefer" | "require"`, plus a structural component
ordering contract. The SDK adapter may translate it only when the selected
provider/model supports it:

| Intent | SDK behavior |
|---|---|
| `off` | make no cache-specific provider change |
| `prefer` | preserve static-first ordering and send supported provider hints; fall back safely when unsupported |
| `require` | fail before provider dispatch if the model/adapter cannot honor the requested cache mode |

The prompt assembly order is part of the versioned contract:

```text
stable system instructions
stable tool definitions
pinned examples / reference material
-- provider cache boundary, when supported --
conversation summary and recent turns
request-specific retrieval
current user input
```

Only stable content belongs before the boundary. Exact-prefix reuse is defeated
when timestamps, user-specific data, retrievals, or frequently changing tools
appear early. Both OpenAI and AWS provider guidance make the same
static-prefix-before-variable-content recommendation.[1][4]

The SDK reports provider usage fields when exposed (`cached_input_tokens`,
`cache_write_tokens`, provider cache mode/breakpoint result) but never calls a
provider token count a cache hit unless the provider returned that measurement.
It must not schedule artificial warm-up calls by default: they can cost money,
consume rate limit, and may produce unwanted provider side effects. Warming is
an explicit adapter capability with a documented cost model.

## Provenance, evaluation, and observability

Every generation built from a resolved managed prompt must set exactly the
existing atomic OTLP tuple:

```text
astraea.prompt.id = slug
astraea.prompt.version = version
astraea.prompt.content_hash = content_hash
```

The SDK must not add template source, rendered values, cache entries, or other
fields under the `astraea.prompt.*` namespace; the ingestion contract strips
that namespace after typed provenance extraction. Cache telemetry is emitted as
safe SDK metrics/log events, not prompt content:

```text
prompt_resolution_total{result=fresh|stale|miss|offline|fallback}
prompt_cache_evictions_total{layer,reason}
prompt_revalidation_total{result=modified|not_modified|error}
prompt_provider_cache_tokens{kind=read|write}
```

A future dashboard view should join cost/latency/cache measurements to the
immutable prompt tuple and compare them only against equivalent model, provider,
and workload dimensions. It must never infer a provider cache hit from a local
SDK hit. Versioned prompts, component-level token budgets, and measured cache
usage should be evaluated together; otherwise a lower token count can hide a
quality regression.[4]

## Cross-SDK compatibility requirements

Before any language SDK is released, publish language-neutral conformance cases
covering:

- selector validation, URL encoding, mandatory project scope, and typed errors;
- response schema and canonical content-hash verification;
- fresh, stale, strict, offline, fallback, and `304` behavior under a fake
  clock;
- delivery-capability expiry, role revocation, prompt-delivery-permission
  removal, Project archive/delete, and prompt deletion; each must prevent a
  cache return before the next local use after the capability boundary;
- single-flight revalidation and bounded LRU/byte/token eviction;
- label promotion race: stale label result, new immutable resolution, and
  concurrent callers;
- template rendering parity and error behavior; and
- OTLP provenance emission with no rendered-variable leakage.
- signed-bundle canonicalization, signature/key rotation, origin/Project/hash
  binding, expiration/epoch rejection, and a proof that an unverified bundle
  cannot emit managed provenance.

Python, TypeScript, and Java may differ in idiom (sync/async APIs, threads,
coroutines), but they may not differ in the above observable behavior. SDK
versions negotiate a versioned delivery schema; a newer server response cannot
be silently accepted by an older SDK if its security-sensitive fields are
unknown.

## Phased delivery and gates

This belongs after the roadmap's Dataset, Evaluation, identity, authorization,
and Agent foundations—not as a shortcut around them.

1. **Contract first:** define the `PromptResolution` OpenAPI schema, role matrix,
   project-scoped authorization, ETag semantics, content-hash algorithm, and
   cross-language conformance fixtures. Update the glossary and OTLP contract.
2. **Read path:** add the SDK delivery endpoint and one generated client; prove
   authorization, missing-scope behavior, immutable-version selection, label
   resolution, and `304` semantics with migration/integration coverage.
3. **SDK core:** implement one reference SDK, then ship the same bounded
   delivery core in Python, TypeScript, and Java: resolution, local rendering,
   provenance, L1 cache, verified fallback bundles, and cache metrics. This is
   deliberately a cross-language contract package—not three framework/Agent
   execution integrations—and it must remain free of framework introspection.
4. **Optional durable cache:** add it only after threat modeling, operational
   documentation, corruption tests, size-bound tests, and a safe key-storage
   story for each runtime.
5. **Provider adapters:** introduce provider/model capability matrices and
   measured cache-token telemetry. Every adapter needs tests showing unsupported
   behavior, exact static/dynamic boundary preservation, and no accidental
   request-data caching.
6. **Promotion gates:** before a deployment label moves, compare the candidate
   against its predecessor on a pinned evaluation; show quality, input-token,
   latency, and provider-cache evidence. Promotion remains human-controlled.

## Acceptance criteria for P4

P4 prompt delivery is not complete until all of these are true:

- a normal production request has a bounded local resolution path and never
  renders/sends request variables to Astraea;
- the exact resolved identity is recorded on generation provenance and works
  with the existing prompt-provenance read path;
- all delivery, cache-control, event, worker, and telemetry paths enforce the
  same server-authorized organization/Project boundary;
- a label promotion converges through validated revalidation even when a push
  event is lost, and no SDK promises global instantaneous invalidation;
- cache data is bounded, segregated, integrity-checked, and free of rendered
  user/request content;
- local cache and offline use are always gated by a checked, bounded
  server-signed delivery capability; revocation/archive/deletion cannot become
  an indefinite cached authorization decision;
- a fallback bundle can emit managed provenance only after fail-closed signature,
  origin/Project/hash, expiry, and authorization-epoch verification;
- Python, TypeScript, and Java pass the same conformance suite; and
- provider-cache claims are backed by provider response telemetry and a
  documented capability matrix, not inference from local-cache behavior.

## Sources

[1] https://platform.openai.com/docs/guides/prompt-caching
[2] https://langfuse.com/docs/prompt-management/features/caching
[3] https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
[4] https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf03-bp02.html
