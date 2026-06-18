#!/usr/bin/env bash
set -euo pipefail

# @makerchecker/sdk is on npm, so the build and tests need nothing vendored —
# `corepack pnpm install && corepack pnpm -r build` is enough on its own.
# This script vendors only what the live DEMOS need:
#   - the MakerChecker server source (compose.yml builds it for `make up`)
#   - OpenClaw (optional; only the real-OpenClaw e2e — SKIP_OPENCLAW=1 to skip)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/vendor"

# MakerChecker server source — compose.yml builds it for `make up`. Override
# MAKERCHECKER_REPO to use a fork or a local checkout; set SKIP_MAKERCHECKER=1 if
# you point compose at a prebuilt image instead.
if [ -z "${SKIP_MAKERCHECKER:-}" ] && [ ! -d "$ROOT/vendor/makerchecker/.git" ]; then
  echo "==> Cloning makerchecker (server source for the demos)"
  git clone --depth 1 "${MAKERCHECKER_REPO:-https://github.com/sammysltd/makerchecker}" "$ROOT/vendor/makerchecker"
fi

# OpenClaw — optional, only for loading the plugin into a real OpenClaw (L5).
if [ -z "${SKIP_OPENCLAW:-}" ] && [ ! -d "$ROOT/vendor/openclaw/.git" ]; then
  echo "==> Cloning openclaw (optional; SKIP_OPENCLAW=1 to skip)"
  git clone --depth 1 https://github.com/openclaw/openclaw "$ROOT/vendor/openclaw"
fi

echo "==> Installing and building"
corepack pnpm install
corepack pnpm -r --filter "./packages/**" build

echo "==> Done. Next: make up && make demo"
