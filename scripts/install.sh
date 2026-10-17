#!/usr/bin/env bash
# One-time setup after cloning: install deps, build everything, put `loom` on your PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "need Node 22+"; exit 1; }
command -v docker >/dev/null || echo "note: Docker is needed for FalkorDB (loom starts it for you)"
command -v pnpm >/dev/null || npm i -g pnpm@9.15.0
pnpm install
pnpm -r build 2>/dev/null || true
pnpm build:hook && pnpm build:mcp && pnpm build:cli && pnpm build:ui
(cd packages/cli && npm link >/dev/null)
echo; echo "done. try:  loom demo      (dashboard + live StaleBench showdown)"
echo "            cd your-repo && loom init   (use Loom on your own project)"
