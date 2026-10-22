#!/usr/bin/env bash
# client/t.js → 압축본을 사이트 리포의 docs/public/t.js로 복사
# 사용법: npm run build:client  (SITE_DIR로 사이트 리포 경로 변경 가능)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
site="${SITE_DIR:-$root/../devcol-site/devcol-build}"
if [ ! -d "$site/docs/public" ]; then
  echo "Site repo not found: $site/docs/public" >&2
  exit 1
fi
out="$site/docs/public/t.js"
npx terser "$root/client/t.js" -c -m --comments '/^ DevCol/' -o "$out"
bytes=$(wc -c < "$out" | tr -d ' ')
echo "Wrote $out ($bytes bytes)"
if [ "$bytes" -ge 2048 ]; then
  echo "t.js must stay under 2KB" >&2
  exit 1
fi
