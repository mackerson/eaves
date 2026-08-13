# Enclave Plugins

This directory is populated by `yarn setup:plugins`, which clones plugin repos from GitHub and symlinks them here.

## Setup

```bash
yarn setup:plugins        # Clone and link all plugins
yarn setup:plugins:pull   # Pull latest for existing clones
```

Plugins are cloned to `../plugins/` (sibling directory) and symlinked here.

## Plugin Repos

See `bundled-plugins.json` in the project root for the full list, or
[docs/plugin-build-system.md](../docs/plugin-build-system.md) for tiers and
what ships. Writing a plugin: [docs/plugin-development.md](../docs/plugin-development.md).
