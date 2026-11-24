#!/usr/bin/env bash
set -euo pipefail

tag="${1:?release tag is required}"
tested_sha="${2:?tested commit SHA is required}"
: "${GH_REPO:?GH_REPO is required}"
bash "$(dirname "$0")/validate-release-tag.sh" "$tag"
[[ "$tested_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Expected a full tested commit SHA\n' >&2; exit 1; }

# gh exits nonzero for API failures, and set -e prevents a failed lookup from publishing.
release_tags="$(gh api --paginate "/repos/$GH_REPO/releases?per_page=100" --jq '.[].tag_name')"
release_exists=false
while IFS= read -r release_tag; do
  if [[ "$release_tag" == "$tag" ]]; then
    release_exists=true
    break
  fi
done <<< "$release_tags"
if [[ "$release_exists" == true ]]; then
  printf 'release for tag %s already exists; refusing to create or replace it\n' "$tag" >&2
  exit 1
fi

# Resolve the explicit tag ref (including annotated tags), not an ambiguous bare name.
tag_sha="$(gh api "/repos/$GH_REPO/commits/refs%2Ftags%2F$tag" --jq '.sha')"
if [[ "$tag_sha" != "$tested_sha" ]]; then
  printf 'release tag %s no longer points to the tested commit; refusing to create a draft\n' "$tag" >&2
  exit 1
fi

gh release create "$tag" glasshouse-image.tar.gz glasshouse-compose.tar.gz SHA256SUMS --verify-tag --draft --generate-notes
