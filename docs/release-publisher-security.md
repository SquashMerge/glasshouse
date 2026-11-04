# Release publisher security and outstanding gates

The version-tag publisher is **disabled by default** (`RELEASE_PUBLISH_ENABLED`
must be set to `true`). Only a version-tag push triggers it. It builds one image
archive and one bundle archive, loads/extracts those exact files for testing,
checksums them and the SBOM, and transfers the same bytes to a separate
`release` environment job. That job rechecks the transferred checksums, attests
the archives and SBOM, creates a **draft** GitHub Release, uploads the assets
without clobbering, and reads back each asset's actual bytes to compare sizes
and SHA-256. It neither publishes to GHCR nor publishes the draft. A failure can
leave an incomplete draft; investigate and manually remove it only after verifying
its identity. Reruns refuse existing releases and drafts.

## Required trust and operator controls

**Do not enable yet.** A read-only GitHub query for `main` on 2026-11-04 returned
`protected: false`, and the `release` environment lookup returned HTTP 404. These
observations are not a full policy audit; recheck effective repository and
organization rules and plan support immediately before any enablement. A workflow
referencing a nonexistent environment can create one without protection rules
([GitHub documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).

Before enabling, an administrator must separately establish and verify:

1. Protected `main` with independent PR approval, the `POLICY` contexts in
   `infra/scripts/release-publisher.py` required from GitHub Actions, and review
   for workflow, release-policy, and security-sensitive changes. Restrict bypass.
2. Effective version-tag creation, update and deletion restrictions. Only narrowly
   authorized release maintainers may create version tags, and they must tag the
   independently reviewed current `main` commit. Restrict updates and deletion;
   the authorized tag creator is explicitly trusted. Verify inherited rules and
   bypass permissions as well as repository rules. A policy observed later cannot
   prove what policy protected the original tag creation.
3. A pre-created `release` environment restricted to appropriate version tags,
   with independent trusted reviewers, self-approval disabled and administrator
   bypass disabled where supported. Verify the protection is effective for the
   repository's plan and visibility, and verify token and attestation support.
   Reviewers must verify the workflow, commit, tag and controls before approval.
4. Trusted repository/environment administrators, GitHub, hosted runners,
   pinned actions, checked-out commit, dependencies and build inputs. A
   tag-supplied workflow cannot authenticate itself or guarantee its own
   environment gate; a malicious tag creator or administrator can defeat it.
   Keep protections and exclusive release-writer authority in force throughout.

The publisher deliberately does **not** query or enforce rulesets, bypass lists,
branch protection or environment configuration. These are external trust
requirements, not controls proved by its API checks. GitHub's ruleset API may
omit bypass actors without ruleset write authority; do not grant the publisher
administration permission to inspect them. A reviewer with appropriate access must
verify the actual effective controls independently.

## Admission and residual races

Admission requires an exact repository, tag-push event, canonical `vX.Y.Z` or
`vX.Y.Z-rc.N` tag, checkout and event commit, and resolves lightweight or annotated
tags against GitHub. The resolved commit must still be the **current** `main`
tip. It retrieves all check-run pages and requires each policy context exactly
once on that SHA, successful, from the approved Actions app; it checks each job
and workflow run's identity, workflow ID, repository, main-push origin and result.
Missing, ambiguous or unreadable evidence fails closed. Workflow IDs are
repository-specific and must be reviewed if workflows are recreated. API and ref
checks are repeated before draft creation and each upload; API checks and writes
are not atomic. Concurrent authorized changes to tags, main, policies, drafts or
assets can race those checks; neither current state nor a later ruleset proves
historical protection. Do not use this mechanism as a substitute for trusted
maintainers and administrators.

## Artifact and test limits

The non-publishing candidate workflow and publisher invoke the same candidate
script. The candidate uses `v0.0.0-rc.1`; the publisher uses its actual version
and transfers its own tested bytes. The candidate executes application and
dependency code on a read-only runner: it is not a sandbox preventing candidate
code from changing its own tests, checksums or outputs. The privileged job does
not execute downloaded archives, but its checked-out publisher code and Actions
are trusted with its authority. Checksums detect changed bytes, not malicious
content. Attestations bind bytes to workflow identity; they do not independently
prove tests meaningful or dependencies safe.

Tests include a reloaded image, image scan/SBOM identity, browser and synthetic
worker probes, a pinned historical upgrade, and a standalone backup/restore drill.
The bundle is tested by extracting its tarball and using the extracted directory;
the test adds a synthetic environment file only after extraction. A candidate
workflow's results do not prove that a different release's bytes were tested.

The non-publishing `Release publisher offline` CI job exercises the real Python
publisher admission, upload streaming and byte-readback code against a mocked
GitHub transport, with synthetic assets and no write credential. It checks the
workflow's transfer/attestation input lists and checksum shell gates; it also
exercises duplicate drafts, ref movement, partial upload failures and corrupted
readback. The bundle fixture is assembled by the real bundle builder, but its
image and SBOM are synthetic. The test does not execute the full candidate build,
artifact transfer or attestation action. In the devcontainer, run:

```sh
python3 -m unittest discover -s infra/scripts/tests -p 'test_release_publisher*.py' -v
```

The workflow checksum checks require GNU coreutils (the Alpine workspace's
BusyBox `sha256sum` does not support `--check`).

Offline mocks and workflow definitions are not evidence of a successful hosted
publisher run, a real GitHub Release, or a verified attestation. Live end-to-end
GitHub API behavior, uploaded-byte readback, attestation verification, and the
actual publisher's hosted candidate gates remain unverified. No repository
settings are changed by this implementation. Enablement needs separate review
and an operator-controlled dry run in an appropriately configured repository.
