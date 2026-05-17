#!/usr/bin/env bash
# Publish books/ and catalog/ to GitLab Generic Package Registry (readit-content/latest).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${CI_API_V4_URL:?CI_API_V4_URL is required}"
: "${CI_JOB_TOKEN:?CI_JOB_TOKEN is required}"

PROJECT_ID="${READIT_CONTENT_PROJECT_ID:-${CI_PROJECT_ID:?CI_PROJECT_ID is required}}"
PACKAGE_NAME="${READIT_CONTENT_PACKAGE:-readit-content}"
PACKAGE_VERSION="${READIT_CONTENT_VERSION:-latest}"

export CONTENT_VERSION="${CI_COMMIT_SHORT_SHA:-$(date -u +%Y%m%d%H%M%S)}"

MANIFEST="${ROOT}/dist/content-manifest.json"
mkdir -p dist
node scripts/generate-content-manifest.mjs --out "$MANIFEST"

BASE_URL="${CI_API_V4_URL}/projects/${PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${PACKAGE_VERSION}"

upload_file() {
  local file_path="$1"
  local remote_path="$2"
  local encoded
  encoded="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$remote_path")"
  local url="${BASE_URL}/${encoded}"
  echo "Uploading ${remote_path} ..."
  curl --fail --silent --show-error \
    --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
    --upload-file "${file_path}" \
    "${url}"
}

echo "Publishing to ${BASE_URL}/"

while IFS= read -r rel_path; do
  [[ -z "$rel_path" ]] && continue
  upload_file "${ROOT}/${rel_path}" "${rel_path}"
done < <(node -e "
  const m = require('./dist/content-manifest.json');
  for (const f of m.files) console.log(f.path);
")

upload_file "$MANIFEST" "content-manifest.json"
echo "Done. Manifest version: $(node -e "console.log(require('./dist/content-manifest.json').version)")"
