#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

before="$(git status --porcelain=v1)"
output="$(PUBLISH_SKIP_TESTS=1 bash ./publish.sh --dry-run)"
after="$(git status --porcelain=v1)"

if [[ "$before" != "$after" ]]; then
  echo "publish.sh --dry-run modified the working tree" >&2
  exit 1
fi

if [[ "$output" != *"Dry run complete"* ]]; then
  echo "publish.sh --dry-run did not report successful validation" >&2
  exit 1
fi

echo "publish.sh dry-run is non-mutating"
