# Astraea UX and Verified Bug Backlog

**Review date:** 2026-07-27
**Repository:** `dsarlo/astraea`
**Checkout:** `/home/hermes/work/astraea`
**Branch:** `add-pr-template`
**Reviewed commit:** `28ba4fded7ef08b7a7aa09aec4db53a8eb579387`
**Working-tree status:** clean

## Review method and verification boundary

I inspected the repository instructions, README, Makefile, docs, Compose files, API routes/schemas/database adapters, React routes/components/hooks, and the unit/integration/E2E test setup. I installed from the committed lockfile with `bun install --frozen-lockfile` (no tracked changes).

Every item in the bug backlog below is included because it is either:

- directly demonstrated by source-level control flow/configuration;
- reproduced by an executed repository command; or
- a documented product defect/unfinished surface explicitly represented by the repository (for example, a route intentionally returning `501`).

I did not include speculative security or performance concerns.

## Verification summary

| Check | Result | Evidence |
|---|---|---|
| `bun install --frozen-lockfile` | Passed | 341 installs checked; no changes |
| `bun run typecheck` | Passed | API and web both exited 0 |
| `bun run build` | Passed | API bundle and Vite production build completed |
| `bun run lint` | Passed but ineffective | Both packages print `no lint configured yet` |
| `cd apps/api && bun test` | Failed | 90 passed, 3 failed, 3 import-time errors; missing auth env during app import causes integration/SSE suites to abort |
| `cd apps/web && bun run test` | Red test output | 9 `useEventSource` tests failed; the command wrapper reported exit 0 despite the failed test output |
| Docker smoke/runtime | Not executable here | `docker` is not installed on this host; no runtime claim is made |

# Priority list: user-experience enhancements

Priority is ordered by user impact, breadth, and how directly each item improves the product's primary workflow.

## P0 — Make the authenticated dashboard a useful product home

**Why first:** The current authenticated home is a foundation/status page rather than a workspace. A user can see two infrastructure links and health pills, but there is no recent-trace summary, failure count, latency signal, onboarding path, or direct route into the observability workflow.

**Evidence:** `apps/web/src/routes/index.tsx:3-41` renders only the “Astraea · MVP Foundation” heading, OpenAPI link, health link, and `HealthBadge`. The actual trace workflow is separate at `apps/web/src/routes/observability.tsx:28-55`.

**Recommended outcome:** Replace the foundation page with a dashboard containing recent traces, error-rate/latency cards, recent failed traces, ingestion status, and clear “send your first trace” onboarding. Keep infrastructure/API links in a secondary developer menu.

**Acceptance criteria:** A new user can reach recent traces, understand whether data is flowing, and take the next action without knowing an API route or opening `/reference`.

**Effort:** Medium.

## P0 — Make trace/span rows keyboard-accessible and semantically actionable

**Why:** The main data surfaces rely on pointer clicks. Keyboard users cannot reliably focus or activate rows, and screen readers are not told that rows are interactive.

**Evidence:** `apps/web/src/components/FilterableTable.tsx:213-228` renders every result through `HighlightedRow`; `apps/web/src/components/FilterableTable.tsx:314-321` attaches only `onClick` and `cursor-pointer` to a `<tr>`, with no `tabIndex`, keyboard handler, role, or focus styling. The same interaction drives both trace and span navigation at `apps/web/src/routes/observability.tsx:443-448` and `741-747`.

**Recommended outcome:** Use a real link/action in the first cell, or add a documented row interaction pattern with `tabIndex={0}`, Enter/Space activation, `aria-label`, and visible focus treatment. Preserve modifier-key behavior and copy/open-in-new-tab affordances where possible.

**Acceptance criteria:** Every row is reachable and activatable by keyboard, has an accessible name, and has a visible focus state in a browser test.

**Effort:** Small.

## P1 — Persist filters, time range, selected tab, and trace span selection in the URL

**Why:** Observability state disappears on refresh, back/forward navigation, or when sharing a link. This is especially costly for debugging workflows.

**Evidence:** Only the tab is read from the URL at `apps/web/src/routes/observability.tsx:28-36`. Filters and time range are initialized in local React state at `apps/web/src/routes/observability.tsx:255-259` and `apps/web/src/routes/observability.tsx:560-564`; the table itself also owns filter state at `apps/web/src/components/FilterableTable.tsx:104-107`. Trace detail already demonstrates the value of a shareable `?span=` deep link at `apps/web/src/routes/observability/traces/$id.tsx:25-27`.

**Recommended outcome:** Make URL search params the single source of truth for tab, filter values, time range, and selected span. Add a copy-link action and preserve state across back/forward navigation.

**Acceptance criteria:** Reloading or sharing a filtered traces/spans URL reproduces the same view; a copied trace URL opens the same selected span.

**Effort:** Medium.

## P1 — Replace the wide filter row with a discoverable filter experience

**Why:** The current filter design is dense, hard to scan, and exposes query syntax through placeholders rather than controls or help. It also scales poorly on small screens.

**Evidence:** `apps/web/src/components/FilterableTable.tsx:179-190` places filter inputs in a table row aligned by column count. The spans view has eight filter fields (`apps/web/src/routes/observability.tsx:511-520`) and the table has nine columns (`455-509`), while the table wrapper only provides horizontal overflow at `apps/web/src/components/ui/table.tsx:4-8`.

**Recommended outcome:** Add a compact filter bar with labeled chips/popovers, type/status/model selectors, duration operators, a filter summary, saved views, and a responsive layout. Keep advanced text search available but do not make it the only discoverability mechanism.

**Acceptance criteria:** A user can add/remove filters without guessing syntax; filters remain usable at phone/tablet widths; active filters are visible without scrolling across the table.

**Effort:** Medium.

## P1 — Add explicit loading, reconnecting, stale-data, and retry UX

**Why:** A live observability UI must explain whether it is loading, disconnected, paused, stale, or empty. Current states are present but low-information and sometimes lack recovery actions.

**Evidence:** `FilterableTable` renders a plain error string with no retry action at `apps/web/src/components/FilterableTable.tsx:171-175`; the trace detail page can remain at “Waiting for snapshot…” at `apps/web/src/routes/observability/traces/$id.tsx:220-223`; stream state is reduced to a compact toggle at `apps/web/src/components/StreamToggle.tsx:42-59`.

**Recommended outcome:** Add inline retry/refresh, last-updated age, “showing cached data” messaging, a visible reconnect action, and a bounded snapshot timeout with a useful failure explanation.

**Acceptance criteria:** Every non-success state tells the user what happened and offers the next safe action; stale data is not visually indistinguishable from live data.

**Effort:** Small–medium.

## P2 — Give spans first-class context instead of displaying an empty Agent column

**Why:** The spans list suggests agent filtering/context, but every Agent cell is hard-coded to an em dash. This reduces scanability and makes the filter promise confusing.

**Evidence:** `SPAN_COLUMNS` defines Agent at `apps/web/src/routes/observability.tsx:481-486` with `cell: () => "—"`, while the same view exposes an `agent_id` filter at `511-520` and sends it in `buildSpanApiParams` at `522-531`.

**Recommended outcome:** Persist/derive agent identity in observation rows or remove the column/filter until the API can support it. Prefer a consistent agent/version/environment context panel in trace detail.

**Acceptance criteria:** The UI never shows a filter or column that cannot produce meaningful values; agent context is visible for supported telemetry.

**Effort:** Medium, depending on schema choice.

## P2 — Improve first-trace onboarding and developer handoff

**Why:** Empty states expose a raw endpoint path but do not provide a copyable SDK snippet, credential instructions, payload validation, or a way to confirm ingestion.

**Evidence:** `apps/web/src/routes/observability.tsx:425-430` and `724-728` tell users only to send data to `/v1/otel/v1/traces`; the README documents environment/header setup separately at `README.md:145-156`.

**Recommended outcome:** Add a first-run wizard with language-specific OTLP examples, copy buttons, auth/config checks, a generated sample trace, and a “verify ingestion” action.

**Acceptance criteria:** A new developer can copy one working example, send a trace, and see it arrive without manually translating README shell commands.

**Effort:** Medium.

## P3 — Make time-range input prevent invalid or ambiguous queries

**Why:** Custom ranges can be incomplete or reversed without inline validation, and the relative-range copy is awkward for non-hour values.

**Evidence:** `apps/web/src/components/TimeRangePicker.tsx:117-134` accepts free-form `from`/`to` values without checking that both exist or that `from <= to`; `138-141` formats “Last 5 minutes” as `(now → 0h5m ago)`.

**Recommended outcome:** Validate the range before querying, show a clear error, normalize timezone/display labels, and use human-friendly relative copy such as “from 5 minutes ago to now.”

**Acceptance criteria:** Invalid ranges cannot silently produce an empty result; timezone and boundary behavior are explicit.

**Effort:** Small.

## P1 — Preserve active navigation state and make the shell responsive

**Why:** Users need orientation in the app, and the current permanent sidebar/filter layout is not designed for narrow viewports.

**Evidence:** `apps/web/src/components/AppShell.tsx:53-55` computes active state only from the optional `currentPath` prop, but `apps/web/src/App.tsx:21-27` renders `AppShell` without passing it. The sidebar is always a sticky fixed-width element at `AppShell.tsx:60-67`, while main content uses fixed `px-6` padding at `150-153`; tables and filter rows rely on horizontal overflow at `apps/web/src/components/ui/table.tsx:4-8` and `FilterableTable.tsx:179-190`.

**Recommended outcome:** Derive the active link from the router location and add a mobile drawer/compact header. Move filters into a responsive filter bar rather than requiring a wide table scroll surface.

**Acceptance criteria:** The current section has active styling/`aria-current`, and a mobile viewport can open navigation and reach all filter controls without excessive horizontal scrolling.

**Effort:** Medium.

## P1 — Make the trace-detail splitter accessible and responsive

**Why:** The trace detail view's split layout is useful on desktop but is inaccessible to keyboard users and remains side-by-side on small screens.

**Evidence:** `apps/web/src/routes/observability/traces/$id.tsx:370-427` handles the splitter only with `onPointerDown`; its separator has no `tabIndex`, keyboard handlers, or `aria-valuemin`/`aria-valuemax`/`aria-valuenow`, and the split has no responsive breakpoint.

**Recommended outcome:** Add keyboard Arrow-key resizing and separator value semantics, then stack or otherwise adapt the panels below a mobile breakpoint.

**Acceptance criteria:** Keyboard users can focus and resize the separator, and mobile trace detail presents both the span tree and detail content without a cramped permanent split.

**Effort:** Medium.

## P2 — Expose span metadata/tags instead of presenting an empty Tags tab

**Why:** The detail UI promises tags/metadata inspection, but the current data contract does not provide a tags path.

**Evidence:** `apps/web/src/routes/observability/traces/$id.tsx:331-357` renders `No tags.`; `apps/web/src/lib/api.ts:27-42` exposes metadata but no tags field, and the observation list projection omits metadata as documented in the bug backlog below.

**Recommended outcome:** Map OTLP attributes into a searchable metadata/tags viewer, or remove/label the tab as unsupported until the backend contract is ready.

**Acceptance criteria:** A fixture with span attributes renders them in the detail view, and the empty state does not imply that data was inspected when it was never available.

**Effort:** Medium.

# Verified bug backlog

Severity: **P0** blocks the shipped stack or its primary authenticated path; **P1** breaks a core workflow or CI signal; **P2** is a reproducible correctness/UX defect with a workaround; **P3** is lower-impact.

## P0 — Docker Compose API environment is incomplete and contains a literal database password

**Observed behavior / verification:** The API's auth middleware throws at construction when `UI_USERNAME` or `UI_PASSWORD` is missing (`apps/api/src/middleware/auth.ts:32-37`). The Compose API service environment at `infra/compose.yaml:75-83` does not pass either variable, so the container cannot construct the `/v1/*` middleware from the values present in `infra/.env`. The same block sets `DATABASE_URL` to `postgres://${POSTGRES_USER}:***@postgres:5432/${POSTGRES_DB}` at line 78. `apps/api/src/db/postgres.ts:7-11` prefers `DATABASE_URL` over component variables, so the API attempts Postgres authentication with the literal password `***`.

**Reproduction evidence:** `cd apps/api && bun test` produced the exact import-time exception `basicAuthMiddleware: UI_USERNAME and UI_PASSWORD must be set in the environment` from `apps/api/src/middleware/auth.ts:36`, matching the Compose omission. A live Docker confirmation could not be run because this host has no `docker` executable; the configuration/source path is sufficient to verify the defect.

**Impact:** `make dev` can build services but the API cannot reliably start/authenticate or pass its health check in the documented Compose workflow.

**Likely fix:** Pass `UI_USERNAME`, `UI_PASSWORD`, and the real database password through Compose safely, or omit `DATABASE_URL` in Compose and pass `POSTGRES_*` variables so the fallback constructs a correct URL. Add a rendered-config assertion and a container smoke check.

## P1 — API integration and SSE tests import the app before setting required auth environment

**Observed behavior / verification:** `apps/api/tests/integration/api.test.ts:24` imports `src/index` before `beforeAll` sets `UI_USERNAME` and `UI_PASSWORD` at lines `30-33`. `src/index.ts:21` invokes `basicAuthMiddleware()` during module initialization. `apps/api/tests/unit/trace-events.test.ts` has the same import-time dependency. Running `cd apps/api && bun test` reproduced three import-time errors and reported `90 pass, 3 fail, 3 errors`.

**Impact:** The standard backend test command is red in a clean environment and never exercises the affected integration/SSE suites.

**Likely fix:** Set required test env before dynamic app import, add a test setup file, or make app construction explicit and injectable. Keep a test that proves missing production env fails fast.

## P1 — Frontend SSE test suite has nine reproducible failures, while the wrapper reports success

**Observed behavior / verification:** Running `cd apps/web && bun run test` after installing the lockfile dependencies produced nine failed `useEventSource` tests, including failures for initial connection/frame delivery, oversized frames, reconnect, RAF coalescing, visibility handling, pause state, and unmount cleanup. Examples include `undefined is not an object (evaluating 'fakeStreams[0].enqueue')` and an expected `open` status remaining `closed`. The command wrapper returned exit code 0 despite the failed Vitest output.

**Impact:** The SSE transport's regression suite cannot currently validate the behavior it claims to cover, and CI can miss the red state if it trusts the wrapper exit code.

**Likely fix:** Repair the Vitest/React test harness and fake-stream lifecycle first, then ensure the package script propagates Vitest's failure status. Add a CI assertion that fails on any failed test count.

**Scope note:** This item is a verified test/release defect; the output alone does not prove that all nine failures are production-hook defects.

## P1 — Root `bun test` runs excluded E2E/smoke files and produces misleading failures

**Observed behavior / verification:** Running `bun test` at the repository root caused Bun to discover `apps/web/tests/smoke.spec.ts` and E2E files despite the web Vitest config excluding them, then failed on missing `@playwright/test`; it also ran browser-dependent auth tests without the configured jsdom environment, producing `window is not defined`. The intended package scripts are `apps/api/package.json:14` and `apps/web/package.json:13`, while the root script is only `"test": "bun --filter '*' test"` at `package.json:17`.

**Impact:** The documented/root test command is not a reliable aggregate test command and mixes Bun discovery with Vitest/Playwright configuration.

**Likely fix:** Make the root script call `bun run --cwd apps/api test` and `bun run --cwd apps/web test` (or equivalent explicit package scripts), and reserve E2E for `test-e2e` with its server prerequisites.

## P2 — Invalid pagination input is not rejected and can become a database error

**Observed behavior / verification:** `handleListTraces` and `handleListObservations` parse query values with `Number()` and only clamp the upper limit/lower offset (`apps/api/src/routes/traces.ts:26-28` and `129-131`). `limit=abc` or `offset=abc` becomes `NaN`; negative limits remain negative because `Math.min(-1, 200)` is `-1`. Those values are passed directly to ClickHouse as typed query parameters by `apps/api/src/db/traces-query.ts:141-144` and `246-249`, so malformed client input reaches the database instead of returning a 400 validation response.

**Impact:** Bad URLs or manually edited filters produce an opaque 500/query failure rather than an actionable validation error.

**Likely fix:** Validate with Zod route query schemas, require finite integers, clamp both bounds, and return a structured 400 envelope. Add tests for non-numeric, zero, negative, and over-limit values.

## P2 — Custom time ranges can be reversed or incomplete without validation

**Observed behavior / verification:** `TimeRangePicker` emits custom ranges whenever either field changes (`apps/web/src/components/TimeRangePicker.tsx:117-134`), and `toApiParams` independently includes whichever endpoint is non-empty (`40-50`). There is no check for missing endpoints or `from > to`; the API then receives a contradictory/partial range.

**Impact:** Users can silently get zero results or an unexpectedly open-ended query with no explanation.

**Likely fix:** Validate in the picker and before query construction; show an inline error and do not issue the request until the range is valid. Add component tests for missing and reversed ranges.

## P2 — Observation agent filtering is implemented as an arbitrary metadata substring match

**Observed behavior / verification:** The spans UI exposes an `agent_id` filter (`apps/web/src/routes/observability.tsx:511-520`) and the API accepts it (`apps/api/src/routes/traces.ts:132-143`), but the database implementation explicitly substitutes `positionCaseInsensitiveUTF8(metadata, {agent_id: String}) > 0` at `apps/api/src/db/traces-query.ts:185-190`. The spans table simultaneously hard-codes its Agent display column to `"—"` at `apps/web/src/routes/observability.tsx:481-486`.

**Impact:** A search for an agent can match unrelated metadata text, while the result does not show which agent matched. This is a verified correctness/UI contract defect, not merely a missing feature.

**Likely fix:** Persist a normalized `agent_id` on observations (or join through a well-defined resource/trace field), filter on that field, return it in the schema, and render it. Until then, remove or relabel the filter as metadata search.

## P3 — Non-trace API surfaces are intentionally wired to 501 stubs but are exposed as available product contract

**Observed behavior / verification:** Routes for agents, experiments, prompts, datasets, and scores import `notImplemented` from `apps/api/src/routes/_stub.ts`; that helper returns HTTP 501. The roadmap explicitly records these surfaces as “Not started” at `docs/02-roadmap.md:8-10`, while the OpenAPI/smoke workflow advertises and checks their collection roots (`infra/scripts/smoke.sh:45-65`).

**Impact:** Users and SDK consumers can discover apparently real endpoints that are guaranteed to fail, which creates a misleading product/API experience.

**Likely fix:** Either hide unfinished routes from the user-facing navigation/OpenAPI contract until implemented, or mark them clearly as preview/not available with next-step guidance and a roadmap link. Do not count the current 501 behavior as a runtime regression; it is a verified product completeness/contract issue.

## P1 — Multi-span OTLP ingestion overwrites the trace-level summary with the last span

**Observed behavior / verification:** `apps/api/src/routes/otlp.ts:62-72` normalizes every span and executes `traces.set(trace.trace_id, trace)` for each one. When multiple spans share a trace ID, the final span replaces the earlier trace summary. The existing test at `apps/api/tests/unit/otlp-publish.test.ts:141-176` verifies only that one trace event is emitted, not which span supplies its name/timestamps/status.

A static repro against the checked-out source confirmed the loop and last-write-wins assignment: `Verified: later spans overwrite earlier trace summaries`.

**Impact:** Trace list/detail summaries can show a child span's name, timing, status, and content instead of the root trace's aggregate identity.

**Likely fix:** Aggregate by trace ID using the root span or explicitly compute trace-level start/end/status/name/input/output from all spans. Add a multi-span regression test that asserts the selected summary.

## P1 — API timestamps contradict the declared response schema

**Observed behavior / verification:** `apps/api/src/db/gen-ai-attrs.ts:61-68` formats timestamps as `YYYY-MM-DD HH:MM:SS.fff`, while `apps/api/src/schemas/traces.ts:11-12,36-37` declares `z.string().datetime()`, which expects an ISO/RFC3339 form such as `2023-11-14T22:13:20.000Z`. The values are persisted unchanged by `apps/api/src/db/traces-writer.ts:14-15,39-40`.

**Impact:** Consumers validating responses against the published OpenAPI/Zod contract can reject otherwise valid trace and observation responses.

**Likely fix:** Normalize API responses to RFC3339, or explicitly change the schema and generated clients to accept the ClickHouse-specific format. Prefer RFC3339 at the public boundary.

## P1 — Trace detail has no visible stream error or timeout state

**Observed behavior / verification:** `apps/web/src/routes/observability/traces/$id.tsx:109-252` invokes `useTraceStream` but renders only the stream toggle and “Waiting for snapshot…” when no snapshot has arrived. `apps/web/src/hooks/useTraceStream.ts:143-146` calls `useEventSource` without an `onError` handler.

**Impact:** A failed, slow, or repeatedly reconnecting stream is indistinguishable from a trace with no observations; users lack an explanation or recovery action.

**Likely fix:** Add explicit connecting/error/stale states, a retry action, and a bounded snapshot timeout.

## P2 — Observation list rows omit metadata promised by the frontend contract

**Observed behavior / verification:** `apps/web/src/lib/api.ts:27-41` declares `ObservationRow.metadata: string`, but `OBSERVATION_COLUMNS` at `apps/api/src/db/traces-query.ts:70-71` omits `metadata`; that projection is used by `listObservations` at `246-251`. The detail query includes metadata at `73-74`, so the inconsistency is specific to the list endpoint.

**Impact:** Any list consumer that expands or inspects metadata receives an absent field despite the shared row type saying it is required.

**Likely fix:** Include metadata in the list projection or remove it from the list response type and make the distinction explicit.

## P2 — OTLP ingest is mounted at runtime but absent from the generated OpenAPI document

**Observed behavior / verification:** `apps/api/src/routes/otlp.ts:14-40` defines the route and `apps/api/src/index.ts:25` mounts the raw handler, but `apps/api/src/openapi.ts:88-113` never registers `otlpIngestRoute`. A static source check confirmed the runtime mount exists while `register(otlpIngestRoute` is absent from the OpenAPI app.

**Impact:** The primary ingestion endpoint is undiscoverable from `/openapi.json` and `/reference`, undermining the documented integration path.

**Likely fix:** Register the route's schema in OpenAPI while retaining the raw handler implementation, or explicitly add the path during document generation.

## P2 — Documented trace URLs are stale and do not match the router

**Observed behavior / verification:** `README.md:132-143` documents `/traces` and `/traces/:id`, while `apps/web/src/App.tsx:37-47` registers `/observability` and `/observability/traces/$id`. The observability page itself navigates to the latter path at `apps/web/src/routes/observability.tsx:443-448,741-747`.

**Impact:** Users following the documented URLs do not reach the intended trace screens.

**Likely fix:** Update README and any generated/deployment documentation, then add a route smoke assertion for the documented URLs.

## P2 — Lint and formatting commands are false-positive quality gates

**Observed behavior / verification:** Both package manifests define `lint` and `format` as `echo 'no lint configured yet'` (`apps/web/package.json:11-12`, `apps/api/package.json:12-13`). Running `bun run lint` exits 0 while performing no analysis.

**Impact:** The release workflow can report a clean lint gate while source contains lint or formatting defects.

**Likely fix:** Configure the repository's intended formatter/linter and make CI fail on violations; until then, rename these scripts or report them as unavailable rather than passing.

## P2 — Health failures are presented as confirmed dependency outages

**Observed behavior / verification:** `apps/web/src/components/HealthBadge.tsx:48-55` renders Postgres, ClickHouse, and Valkey as individually `down` for any health request error, even when the request failed before component-level statuses were available.

**Impact:** A network/API outage is misdiagnosed as three independent database outages.

**Likely fix:** Use an `unknown`/`unavailable` state for transport errors and preserve component-level `down` only when the API returned a degraded health payload.

## P2 — Authentication drops the original deep-link destination

**Observed behavior / verification:** `apps/web/src/components/AuthGate.tsx:9-20` always navigates unauthenticated users to `/login` without retaining the current location. This affects deep links such as `/observability/traces/:id`.

**Impact:** Users must manually find their trace again after signing in, interrupting investigation workflows.

**Likely fix:** Pass the original pathname/search to login and redirect back after successful authentication.

# Suggested execution order

1. Fix Compose environment/database wiring and make the authenticated stack boot deterministically.
2. Repair test entrypoints and SSE/API test setup so red behavior is trustworthy.
3. Fix trace aggregation and public timestamp/response-contract mismatches.
4. Make rows keyboard-accessible and add retry/stale/reconnect states.
5. Turn the dashboard into a real operational home and improve first-trace onboarding.
6. Persist observability state in URLs and redesign the filter experience.
7. Correct observation metadata/agent identity and validate custom time ranges.
8. Repair OpenAPI/README route drift and replace no-op quality gates.
