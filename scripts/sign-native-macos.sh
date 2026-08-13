#!/usr/bin/env bash
# Ad-hoc codesign native addons and Electron.app on macOS.
#
# Apple Silicon's AMFI kills any process that loads unsigned executable pages
# with SIGKILL / CODESIGNING Invalid Page. electron-rebuild, fresh Electron
# installs, and nvm-triggered rebuilds all produce unsigned binaries, so we
# re-apply an ad-hoc signature after any step that touches them.
#
# Safe to run repeatedly: `codesign --force` overwrites existing signatures.
# No-op on non-Darwin platforms.

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "sign-native-macos: codesign not found, skipping"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

signed=0

if [ -d node_modules ]; then
  while IFS= read -r -d '' nodefile; do
    codesign --force --sign - "$nodefile" >/dev/null 2>&1 || true
    signed=$((signed + 1))
  done < <(find node_modules -name '*.node' -type f -print0)
fi

ELECTRON_APP="node_modules/electron/dist/Electron.app"
if [ -d "$ELECTRON_APP" ]; then
  codesign --force --deep --sign - "$ELECTRON_APP" >/dev/null 2>&1 || true
  signed=$((signed + 1))
fi

echo "sign-native-macos: signed $signed target(s)"
