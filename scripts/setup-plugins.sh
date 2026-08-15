#!/usr/bin/env bash
#
# Setup plugin development environment
#
# Clones plugin repos into ../plugins/ (sibling to this repo) and
# creates symlinks in ./plugins/ so the dev server picks them up.
#
# Usage:
#   ./scripts/setup-plugins.sh          # Clone & link all plugins
#   ./scripts/setup-plugins.sh --pull   # Pull latest for existing clones
#   ./scripts/setup-plugins.sh --clean  # Remove symlinks (not clones)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$(dirname "$SCRIPT_DIR")"
PLUGINS_SRC="${CORE_DIR}/../plugins"
PLUGINS_LINK="${CORE_DIR}/plugins"

# Read bundled-plugins.json
MANIFEST="${CORE_DIR}/bundled-plugins.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Error: bundled-plugins.json not found at ${MANIFEST}"
  exit 1
fi

# Parse plugin entries (requires jq)
if ! command -v jq &> /dev/null; then
  echo "Error: jq is required."
  echo "  Arch:          sudo pacman -S jq"
  echo "  Debian/Ubuntu: sudo apt install jq"
  echo "  macOS:         brew install jq"
  exit 1
fi

PLUGINS=$(jq -r '.plugins[] | "\(.name) \(.repo) \(.ref)"' "$MANIFEST")

# How to reach GitHub. This used to be hardcoded to `git@github-personal:` — an
# SSH host alias that exists in exactly one developer's ~/.ssh/config, so
# everyone else got "Could not resolve hostname github-personal", plugins/ stayed
# empty, and `yarn build` then failed in copy-plugins.js with "Missing bundled
# plugin(s)". CLAUDE.md documents this script as required after cloning.
#
# Default to HTTPS, which works unauthenticated for public repos and in CI.
# Override with EAVES_GIT_PROTO=ssh, or point EAVES_GIT_HOST at your own
# SSH alias.
CLONE_PROTO="${EAVES_GIT_PROTO:-https}"
GIT_HOST="${EAVES_GIT_HOST:-github.com}"

clone_url() {
  if [ "$CLONE_PROTO" = "ssh" ]; then
    echo "git@${GIT_HOST}:${1}.git"
  else
    echo "https://${GIT_HOST}/${1}.git"
  fi
}

# Handle --clean flag
if [ "${1:-}" = "--clean" ]; then
  echo "Removing plugin symlinks from ${PLUGINS_LINK}/"
  while IFS=' ' read -r name repo ref; do
    if [ -L "${PLUGINS_LINK}/${name}" ]; then
      rm "${PLUGINS_LINK}/${name}"
      echo "  Removed ${name}"
    fi
  done <<< "$PLUGINS"
  echo "Done. Plugin clones in ${PLUGINS_SRC}/ are untouched."
  exit 0
fi

# Ensure directories exist
mkdir -p "$PLUGINS_SRC"
mkdir -p "$PLUGINS_LINK"

echo "Plugin source: ${PLUGINS_SRC}"
echo "Plugin links:  ${PLUGINS_LINK}"
echo ""

while IFS=' ' read -r name repo ref; do
  clone_path="${PLUGINS_SRC}/${name}"

  if [ -d "${clone_path}/.git" ]; then
    if [ "${1:-}" = "--pull" ]; then
      echo "Pulling ${name}..."
      git -C "$clone_path" pull --ff-only 2>&1 | sed 's/^/  /'
    else
      echo "Exists: ${name} (use --pull to update)"
    fi
  else
    echo "Cloning ${name} from ${repo} (${CLONE_PROTO})..."
    git clone "$(clone_url "$repo")" "$clone_path" 2>&1 | sed 's/^/  /'
    if [ "$ref" != "main" ]; then
      git -C "$clone_path" checkout "$ref" 2>&1 | sed 's/^/  /'
    fi
  fi

  # Create symlink if not already present
  link_path="${PLUGINS_LINK}/${name}"
  if [ -L "$link_path" ]; then
    echo "  Linked: ${name} (exists)"
  elif [ -d "$link_path" ]; then
    echo "  Warning: ${link_path} is a real directory, not a symlink. Skipping."
  else
    ln -s "$clone_path" "$link_path"
    echo "  Linked: ${name} -> ${clone_path}"
  fi

  echo ""
done <<< "$PLUGINS"

echo "Done! Run 'yarn dev' to start with plugins."
