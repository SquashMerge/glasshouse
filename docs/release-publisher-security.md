# Release publisher security and outstanding gates

The protected-tag publisher is **disabled by default** (`RELEASE_PUBLISH_ENABLED`
must be set to `true`). Its workflow has only a version-tag push trigger; PRs and
manual dispatches have no publishing job. It builds one image archive and one
bundle archive, loads/extracts those exact files for testing, then transfers the
same bytes to a separate environment-gated job. That job independently repeats
admission, verifies the transfer, attests both archives, creates a **draft** GitHub
Release, uploads the archives and checksum manifest without clobbering, and
reads each remote asset back to compare its byte count and SHA-256. It does not
publish to GHCR or turn a draft into a public release. A failed upload can leave
an incomplete draft: investigate and manually remove it only after establishing
its identity; reruns intentionally refuse existing drafts/assets.

The definitions and offline tests are not evidence of a successful hosted run,
a real GitHub Release, or a verified attestation. Current repository settings
have not been changed by this implementation. Live end-to-end GitHub API behavior,
permissions, uploaded-byte readback, attestation verification, and the hosted
candidate gates remain unverified. Do not enable without a separate review and
an operator-controlled dry run in an appropriately configured repository.

## Required operator controls before enabling publication

1. Protect `main`, require at least one independent approval and the check
   contexts in `POLICY` in `infra/scripts/release-publisher.py`, and bind each
   context to the GitHub Actions app. Protect workflow and release-policy changes
   with code ownership; restrict bypass and verify effective rules in GitHub.
   Admission requires the release commit to remain the current `main` tip, not
   merely an ancestor, and verifies each check's workflow ID, app, repository,
   push event, branch, completed success, exact SHA and uniqueness. Reruns that
   create duplicate matching checks are denied rather than arbitrarily selected.
2. Configure active protected tag rules. The current conservative implementation
   only accepts a ruleset whose sole inclusion is the *exact* `refs/tags/vX.Y.Z`
   or `refs/tags/vX.Y.Z-rc.N`, no exclusions or bypass actors, and creation,
   update and deletion rules. Wildcard rules are deliberately not treated as
   proof of coverage. A creation restriction without bypass can prevent creation
   of the tag; coordinating protected creation, removal of any temporary bypass,
   and a rerun requires an explicit operator procedure. A ruleset observed after
   tag creation does **not** prove the creation was protected. Do not treat the
   in-workflow check as proof of that historical fact.
3. Create the `release` GitHub environment before enabling the variable. Restrict
   deployments to the intended tag patterns, require independent trusted
   reviewers, disable self-approval and administrator bypass where supported,
   and verify its enforcement and token permissions. The job's `contents: write`
   token is environment gated and has no package-write permission. GitHub plans
   and repository visibility can limit environment protection or attestations;
   fail closed if the required protections are unavailable. No code can prove
   that a tag-supplied workflow has not removed its own environment gate.
4. Confirm tag creators, environment reviewers, GitHub, the hosted runner,
   pinned actions, checked-out commit, dependencies and build inputs are trusted.
   Reviewers must verify the actual workflow, tag, commit and rules before
   approving. A tag-supplied workflow cannot establish its own trustworthiness.
   Protect all relevant changes, limit bypass, and maintain sole-writer authority
   and the protections throughout the operation; API checks and writes are not
   atomic with tag/rule changes. Repository/environment administrators remain
   trusted. The script rechecks admission before each upload but cannot prevent a
   race against an authorized concurrent rule, tag or release mutation.
5. Configure the exact policy values, ruleset/branch visibility and token scopes
   required to read all pages of checks, workflow runs, jobs and rules. The pinned
   workflow IDs are repository-specific and must be reviewed if workflows are
   recreated. Missing or unreadable evidence, ambiguous checks, redirects,
   malformed responses, 403s and rate limits deny. The rules API's effective
   coverage and availability must be verified against the actual repository plan.

## Artifact and test limits

The publisher's standalone candidate script intentionally mirrors the candidate
workflow while preserving the versioned image and bundle archives across testing
and upload. This duplicates test orchestration: changes to either path must be
reviewed together, or both should be refactored to a shared reusable workflow.
The candidate executes untrusted-by-default application/dependency code on a
read-only runner and has no release-write token. It is not a sandbox against the
candidate code modifying its own tests, checksums or outputs. The privileged job
runs separately and does not execute downloaded archives, but its checked-out
publisher code and Actions are trusted with its authority. Checksums detect byte
changes, not malicious content. Attestations bind bytes to a workflow identity;
they do not independently prove that tests were meaningful or dependencies safe.

Tests include a reloaded image, image scan/SBOM identity, browser and synthetic
worker probes, a pinned historical upgrade, and a standalone backup/restore drill.
Their definitions have not yet passed on hosted CI for this publisher. The bundle
is tested by extracting its tarball and using the extracted directory; the test
adds a synthetic environment file only after extraction, not to the archive.
Compression and test behavior can change with runner and tool versions. The
candidate workflow's separate results do not prove that these release bytes were
tested; only a successful corresponding publisher run can support that claim.
