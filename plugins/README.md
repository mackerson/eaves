# Enclave Plugins

This directory is populated by `npm run setup:plugins`, which clones plugin repos from GitHub and symlinks them here.

## Setup

```bash
npm run setup:plugins        # Clone and link all plugins
npm run setup:plugins:pull   # Pull latest for existing clones
```

Plugins are cloned to `../plugins/` (sibling directory) and symlinked here.

## Plugin Repos

See `bundled-plugins.json` in the project root for the full list of plugins and their GitHub repos.
