#!/bin/bash
# Reset Eaves development environment to defaults
# This script deletes the local database and user data

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    USER_DATA_DIR="$HOME/Library/Application Support/eaves"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux. Honour XDG_CONFIG_HOME — Electron does, so hardcoding
    # ~/.config/eaves meant this script could not clean an isolated profile
    # (the QA harness runs the app under its own XDG_CONFIG_HOME) and would
    # instead reach for the developer's real data.
    USER_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/eaves"
else
    # Windows (Git Bash)
    USER_DATA_DIR="$APPDATA/eaves"
fi

DB_DIR="$USER_DATA_DIR/eaves-data"
PLUGINS_DIR="$USER_DATA_DIR/plugins"
LOGS_DIR="$USER_DATA_DIR/logs"

echo -e "${YELLOW}Eaves Development Environment Reset${NC}"
echo ""
echo "This will delete:"
echo "  - Database: $DB_DIR"
echo "  - User plugins: $PLUGINS_DIR"
echo "  - Logs: $LOGS_DIR"
echo ""
echo -e "${RED}WARNING: This action cannot be undone!${NC}"
echo ""

# Check if force flag is set
if [[ "$1" != "--force" ]]; then
    read -p "Are you sure you want to continue? (yes/no): " -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]es$ ]]; then
        echo "Reset cancelled."
        exit 0
    fi
fi

# Kill any running Eaves processes (not all Electron apps!).
#
# Match on this checkout's own path rather than the literal "personal/eaves",
# which only matched one developer's directory layout. Anywhere else it killed
# nothing and the script went on to rm -rf the database out from under a still
# running app.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo -e "${YELLOW}→ Stopping Eaves processes...${NC}"
pkill -f "${REPO_ROOT}.*electron" || true
pkill -f "${REPO_ROOT}.*yarn dev" || true
pkill -f "${REPO_ROOT}.*vite" || true
sleep 1

# Refuse to delete data belonging to an app we could not stop: the whole point
# of the kill above is that nothing has the SQLite file open when we remove it.
if pgrep -f "${REPO_ROOT}.*electron" > /dev/null; then
    echo -e "${RED}Eaves is still running — refusing to delete its data.${NC}"
    echo "  Quit the app and re-run, or kill it manually."
    exit 1
fi

# Delete directories
if [ -d "$DB_DIR" ]; then
    echo -e "${YELLOW}→ Deleting database...${NC}"
    rm -rf "$DB_DIR"
    echo -e "${GREEN}✓ Database deleted${NC}"
else
    echo "  Database directory not found (already clean)"
fi

if [ -d "$PLUGINS_DIR" ]; then
    echo -e "${YELLOW}→ Deleting user plugins...${NC}"
    rm -rf "$PLUGINS_DIR"
    echo -e "${GREEN}✓ User plugins deleted${NC}"
else
    echo "  User plugins directory not found (already clean)"
fi

if [ -d "$LOGS_DIR" ]; then
    echo -e "${YELLOW}→ Deleting logs...${NC}"
    rm -rf "$LOGS_DIR"
    echo -e "${GREEN}✓ Logs deleted${NC}"
else
    echo "  Logs directory not found (already clean)"
fi

echo ""
echo -e "${GREEN}✓ Development environment reset complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Run 'yarn dev' to start with fresh defaults"
echo "  2. Default agent, project, and channel will be created"
echo "  3. Check .env for user name and API keys"
echo ""
