#!/bin/bash
set -euo pipefail

# Packages packages/vscode into a .vsix and publishes it to plugins.elide.dev for manual installs, mirroring
# elide-intellij/tools/deploy.sh: presigned R2 upload of the archive, then a metadata upsert. The archive is left at
# dist/<name>-<version>.vsix for later release steps.
#
# Env: ELIDE_PLUGINS_URL (or PLUGINS_URL), ELIDE_PLUGINS_KEY; BAZEL_FLAGS (e.g. `--config=ci`). Requires jq and Bazel
# (bazelisk).

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
VSIX_FILE="$ROOT/dist/${NAME}-${VERSION}.vsix"

echo "Publishing extension:"
echo "ID=$EXTENSION_ID"
echo "Display name=$DISPLAY_NAME"
echo "Version=$VERSION"
echo "Engine=${ENGINE:-n/a}"
echo "Repository=${REPOSITORY:-n/a}"

# Bazel builds `@elide/ide-core`, the bundle and the archive from a clean checkout.
echo "Packaging..."
# shellcheck disable=SC2086 # BAZEL_FLAGS is a list of flags
(cd "$ROOT" && bazel build ${BAZEL_FLAGS:-} //packages/vscode:vsix)
# shellcheck disable=SC2086
BUILT_VSIX="$ROOT/$(cd "$ROOT" && bazel cquery ${BAZEL_FLAGS:-} --output=files //packages/vscode:vsix 2>/dev/null)"
mkdir -p "$(dirname "$VSIX_FILE")"
cp -f "$BUILT_VSIX" "$VSIX_FILE"
chmod u+w "$VSIX_FILE"

url_encode() {
    jq -rn --arg str "$1" '$str | @uri'
}

ENCODED_ID=$(url_encode "$EXTENSION_ID")
ENCODED_VERSION=$(url_encode "$VERSION")

echo "Getting presigned upload URL..."
UPLOAD_URL=$(curl --fail -sS \
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

curl --fail -sS \
  -H "x-api-key: ${ELIDE_PLUGINS_KEY}" \
  -H "Content-Type: application/json" \
  "${PLUGINS_URL}/vscode/extensions?id=${ENCODED_ID}" \
  -d "$METADATA_JSON"
echo
echo "Extension published: ${PLUGINS_URL}/vscode/files?id=${ENCODED_ID}"
