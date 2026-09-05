#!/bin/bash
set -euo pipefail

# Packages packages/vscode into a .vsix and publishes it to plugins.elide.dev for manual installs, mirroring
# elide-intellij/tools/deploy.sh: presigned R2 upload of the archive, then a metadata upsert.
#
# Env: ELIDE_PLUGINS_URL (or PLUGINS_URL), ELIDE_PLUGINS_KEY. Requires jq and a vsce (bunx @vscode/vsce).

if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed"
    exit 1
fi

PLUGINS_URL="${ELIDE_PLUGINS_URL:-${PLUGINS_URL}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/packages/vscode"
MANIFEST="$PACKAGE_DIR/package.json"

PUBLISHER=$(jq -r '.publisher' "$MANIFEST")
NAME=$(jq -r '.name' "$MANIFEST")
DISPLAY_NAME=$(jq -r '.displayName // .name' "$MANIFEST")
DESCRIPTION=$(jq -r '.description // ""' "$MANIFEST")
VERSION=$(jq -r '.version' "$MANIFEST")
ENGINE=$(jq -r '.engines.vscode // ""' "$MANIFEST")
REPOSITORY=$(jq -r 'if .repository == null then "" elif (.repository | type) == "string" then .repository else .repository.url end' "$MANIFEST")

EXTENSION_ID="${PUBLISHER}.${NAME}"
VSIX_FILE="$PACKAGE_DIR/${NAME}-${VERSION}.vsix"

echo "Publishing extension:"
echo "ID=$EXTENSION_ID"
echo "Display name=$DISPLAY_NAME"
echo "Version=$VERSION"
echo "Engine=${ENGINE:-n/a}"
echo "Repository=${REPOSITORY:-n/a}"

# Build from the workspace root: packages/vscode bundles `@elide/ide-core`, whose `dist/` is only produced by the
# core package's own build, so a package-local build would leave the import unresolvable.
echo "Packaging..."
(cd "$ROOT" && bun run build)
(cd "$PACKAGE_DIR" && bun run package)

if [[ ! -f "$VSIX_FILE" ]]; then
    echo "Error: package did not produce $VSIX_FILE"
    exit 1
fi

url_encode() {
    jq -rn --arg str "$1" '$str | @uri'
}

ENCODED_ID=$(url_encode "$EXTENSION_ID")
ENCODED_VERSION=$(url_encode "$VERSION")

echo "Getting presigned upload URL..."
UPLOAD_URL=$(curl --fail -s \
  -H "x-api-key: ${ELIDE_PLUGINS_KEY}" \
  "${PLUGINS_URL}/vscode/files/presign?id=${ENCODED_ID}&version=${ENCODED_VERSION}")

echo "Uploading extension archive..."
curl --fail -# \
  -X PUT \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$VSIX_FILE" \
  "$UPLOAD_URL"
echo "Archive uploaded"

echo "Updating extension metadata..."
METADATA_JSON="$(jq -n \
  --arg publisher "$PUBLISHER" \
  --arg name "$NAME" \
  --arg displayName "$DISPLAY_NAME" \
  --arg description "$DESCRIPTION" \
  --arg version "$VERSION" \
  --arg engineVersion "$ENGINE" \
  --arg repositoryUrl "$REPOSITORY" \
  '{
    publisher: $publisher,
    name: $name,
    displayName: $displayName,
    description: $description,
    version: $version
  } +
  (if $engineVersion != "" then {engineVersion: $engineVersion} else {} end) +
  (if $repositoryUrl != "" then {repositoryUrl: $repositoryUrl} else {} end)'
)"

curl --fail -s \
  -H "x-api-key: ${ELIDE_PLUGINS_KEY}" \
  -H "Content-Type: application/json" \
  "${PLUGINS_URL}/vscode/extensions?id=${ENCODED_ID}" \
  -d "$METADATA_JSON"
echo
echo "Extension published: ${PLUGINS_URL}/vscode/files?id=${ENCODED_ID}"
