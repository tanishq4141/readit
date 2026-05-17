#!/usr/bin/env bash
# Publish books/ and catalog/ to a public S3 prefix for OTA sync.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${READIT_S3_BUCKET:?READIT_S3_BUCKET is required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

PREFIX="${READIT_S3_PREFIX:-readit}"
PREFIX="${PREFIX#/}"
PREFIX="${PREFIX%/}"

STAGE="${ROOT}/dist/content-publish"
MANIFEST="${ROOT}/dist/content-manifest.json"

export CONTENT_VERSION="${CI_COMMIT_SHORT_SHA:-$(date -u +%Y%m%d%H%M%S)}"

echo "Generating content manifest..."
mkdir -p dist
node scripts/generate-content-manifest.mjs --out "$MANIFEST"

echo "Staging content under ${STAGE}..."
rm -rf "$STAGE"
mkdir -p "${STAGE}/catalog" "${STAGE}/books"

rsync -a \
  --exclude '.claude' \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.*' \
  "${ROOT}/books/" "${STAGE}/books/"

cp "${ROOT}/catalog/books.json" "${STAGE}/catalog/books.json"

S3_URI="s3://${READIT_S3_BUCKET}/${PREFIX}/"
echo "Syncing to ${S3_URI}..."
aws s3 sync "${STAGE}/" "${S3_URI}" --delete

echo "Uploading manifest (last)..."
aws s3 cp "$MANIFEST" "${S3_URI}content-manifest.json" \
  --content-type "application/json"

echo "Done. Version: $(node -e "console.log(require('./dist/content-manifest.json').version)")"
echo "Public base URL should match READIT_CONTENT_BASE_URL, e.g.:"
echo "  https://${READIT_S3_BUCKET}.s3.${AWS_DEFAULT_REGION}.amazonaws.com/${PREFIX}/"
