# Release publisher security and outstanding gates

**Work in progress: no Release publisher is enabled or implemented.** The
candidate workflow is read-only and does not create tags, Releases, attestations,
or packages. Its success does not authenticate any future artifact. The
admission module contains reusable checks, not an independent GitHub client or
a publication gate. Do not attach publication credentials to it as-is.

## Required operator controls before enabling publication

1. Protect `main`: require reviews and the approved CI checks, restrict bypass,
   protect workflow and release-policy changes with appropriate code ownership,
   and verify the exact branch rules actually enforced by GitHub.
2. Protect the explicit release-tag namespace (only `vX.Y.Z` and `vX.Y.Z-rc.N`
   are intended), including creation, update and deletion. Limit creators and
   bypass actors; do not let PR authors freely tag arbitrary commits.
3. Put any Release-writing credential in a **protected environment**, not a
   repository secret or a write-enabled default workflow token. Restrict its
   deployment tag patterns, require independent trusted reviewers and prevent
   self-approval/bypass as the GitHub plan permits. Verify these settings and
   the effective permissions of the token before each enablement. The credential
   must have only the repository contents access needed to publish; do not grant
   package write access. PRs and dispatch runs must never obtain it.
4. A tag-supplied workflow and its scripts cannot establish their own
   trustworthiness. An attacker able to create a tag pointing to their own
   workflow can remove all in-workflow validation. Environment protection,
   protected tag rules and trustworthy reviewers are external prerequisites,
   not controls that an untrusted tag can prove. Confirm they apply to the
   actual job and tag, not merely to another workflow or branch.
5. Treat administrators, allowed tag creators, environment reviewers,
   credential holders, GitHub, the hosted runner, pinned actions, build inputs,
   package sources and any code run in the privileged job as trusted. The
   configuration must block unreviewed code from reaching that credential.
   Checks and publication are not atomic with later rule/tag changes; maintain
   those protections and sole-writer authority throughout the operation.

## Implementation still required

The future publisher must independently read the live tag, peel annotated tags,
verify the event, repository and checkout SHA, and prove that commit is on the
protected `main`. It must retrieve *all* relevant exact-SHA check evidence and
verify each required check's approved app, workflow identity, originating
repository, main-push event, success and completion. Missing, stale, duplicated,
unreadable or ambiguous evidence must deny. `release-admission.py` supplies
pure validation primitives, but the GitHub client, fixed policy, pagination and
wiring are not yet provided. Its inputs are not evidence unless independently
retrieved over an authenticated trusted channel.

Build once and exercise the actual Docker-load-compatible archive in a clean
Compose stack before provenance generation, upload or attestation. The current
candidate adds a real browser signed-out/API probe, a pinned historical API
upgrade with retained records, and a standalone bundle backup/isolated-restore
probe, but none has yet passed hosted CI. Coverage still needed includes
authenticated browser sessions, cross-tenant security, and meaningful worker
execution. A worker import smoke is not a job execution. The exact bytes that
pass these gates must be the bytes released; rebuilding later is not equivalent.

After those gates exist, implement secure release notes and provenance, draft
and prerelease handling, under-2-GiB Docker image archive, checksums, and
no-overwrite Release asset creation with exact remote readback. Fail closed on
partial upload, tag movement, unavailable API, conflicting release or asset,
wrong hash or missing checks. Do not publish to GHCR. The credential must not be
available to untrusted candidate code on the same runner; process environment
scrubbing is not a same-user security boundary. A separate privileged job must
verify independently authenticated artifacts before any write. Test recovery and
race/failure behavior before activation. Checksums alone are not provenance.
