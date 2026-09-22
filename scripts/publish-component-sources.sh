#!/usr/bin/env bash
# Attaches the source code of the components the AGPL obliges a release to make available
# alongside the app's own: PineTS and Vela PineTS (both AGPL-3.0), and Vela, the charting
# library they plug into. The app's own source is the release's tag; these are the exact
# upstream versions in package-lock.json, taken from the upstream projects' version tags.
# A copy next to the installers keeps the "Corresponding Source" available even if an
# upstream repository moves or disappears.
#
# Run by the `checksums` job in .github/workflows/release.yml before SHA256SUMS is made, so
# the sums cover these files too. Safe to run again: an earlier copy is replaced.
#
# Needs GH_TOKEN, GITHUB_REPOSITORY (owner/name) and RELEASE_ID in the environment, and
# gh, curl and node on the PATH.

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${RELEASE_ID:?RELEASE_ID is not set (the build job reports it)}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# "<npm package> <upstream GitHub repository>": each tags its releases v<version>.
components=(
  "pinets LuxAlgo/PineTS"
  "@luxalgo/vela-pinets LuxAlgo/Vela-pinets"
  "@luxalgo/vela luxalgo/vela"
)

releases="repos/$GITHUB_REPOSITORY/releases"
gh api "$releases/$RELEASE_ID" --jq '.assets[] | [.id, .name] | @tsv' > "$work/assets.tsv"

for entry in "${components[@]}"; do
  read -r package repo <<< "$entry"
  version="$(node -e '
    const entry = require(process.argv[1]).packages["node_modules/" + process.argv[2]];
    if (!entry) process.exit(1);
    console.log(entry.version);
  ' "$root/package-lock.json" "$package")" || {
    echo "$package is not in package-lock.json" >&2
    exit 1
  }
  name="$(basename "$package")-$version-source.tar.gz"

  echo "Fetching $repo v$version"
  curl -sSfL -o "$work/$name" "https://github.com/$repo/archive/refs/tags/v$version.tar.gz"

  old_id="$(awk -F'\t' -v n="$name" '$2 == n { print $1 }' "$work/assets.tsv")"
  if [ -n "$old_id" ]; then
    echo "Replacing the earlier $name"
    gh api --method DELETE "$releases/assets/$old_id"
  fi

  curl -sSf -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$work/$name" \
    "https://uploads.github.com/$releases/$RELEASE_ID/assets?name=$name" > /dev/null
  echo "Attached $name"
done
