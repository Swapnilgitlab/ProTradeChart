#!/usr/bin/env bash
# Attaches a SHA256SUMS file to a GitHub release (a draft is fine).
#
# It downloads what the release actually holds, hashes those files with checksums.mjs, and
# uploads the result, so the sums describe exactly what people will download rather than
# what a build machine thought it uploaded. Signatures (.sig) and latest.json are skipped:
# they aren't downloads to verify, and latest.json changes as each platform finishes.
#
# Run by the `checksums` job in .github/workflows/release.yml once every platform's build has
# uploaded. Safe to run again: an earlier SHA256SUMS is replaced.
#
# Needs GH_TOKEN, GITHUB_REPOSITORY (owner/name) and RELEASE_ID in the environment, and
# gh, curl and node on the PATH.

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${RELEASE_ID:?RELEASE_ID is not set (the build job reports it)}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/files"

releases="repos/$GITHUB_REPOSITORY/releases"

# One "id<TAB>name" line per asset.
gh api "$releases/$RELEASE_ID" --jq '.assets[] | [.id, .name] | @tsv' > "$work/assets.tsv"

old_sums_id=""
downloaded=0
while IFS=$'\t' read -r id name; do
  case "$name" in
    SHA256SUMS) old_sums_id="$id" ;;
    *.sig | latest.json) ;;
    *)
      echo "Downloading $name"
      # The redirect goes to another host, which must not be sent the token; curl drops the
      # Authorization header across hosts on its own.
      curl -sSfL \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/octet-stream" \
        -o "$work/files/$name" \
        "https://api.github.com/$releases/assets/$id"
      downloaded=$((downloaded + 1))
      ;;
  esac
done < "$work/assets.tsv"

if [ "$downloaded" -eq 0 ]; then
  echo "Release $RELEASE_ID has no downloads to checksum." >&2
  exit 1
fi

node "$here/checksums.mjs" "$work/files" --out "$work/SHA256SUMS"

if [ -n "$old_sums_id" ]; then
  echo "Replacing the earlier SHA256SUMS"
  gh api --method DELETE "$releases/assets/$old_sums_id"
fi

curl -sSf -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "@$work/SHA256SUMS" \
  "https://uploads.github.com/$releases/$RELEASE_ID/assets?name=SHA256SUMS" > /dev/null

echo "Attached SHA256SUMS to release $RELEASE_ID"
