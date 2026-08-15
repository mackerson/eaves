# Test Infrastructure

This directory contains test utilities, fixtures, and setup files for the Eaves project.

## Files

- **setup.ts** — Global test setup (RTL cleanup, partial `window.electron` stubs)
- **test-utils.tsx** — Thin React Testing Library re-export
- **database-utils.ts** — In-memory SQLite helpers (`createTestDatabase`, seed helpers)

## Running Tests

```bash
yarn test              # watch mode
yarn test:run          # once
yarn test:coverage     # once + coverage (thresholds in vitest.config.ts)
```

## Database Testing

Repository tests mock `logger` + `getDatabase`, then use the shared helpers:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MyRepository } from './MyRepository';
import { createTestDatabase, closeTestDatabase, seedAgent } from '@test/database-utils';
import type Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

describe('MyRepository', () => {
  let db: Database.Database | null = null;
  let repo: MyRepository;

  beforeEach(async () => {
    db = createTestDatabase(); // :memory: + production migrations
    seedAgent(db);             // when FKs require an agent row
    const databaseModule = await import('../services/database');
    vi.mocked(databaseModule.getDatabase).mockReturnValue(db);
    repo = new MyRepository();
  });

  afterEach(() => {
    closeTestDatabase(db);
    db = null;
  });
});
```

**Coverage note (`all: false`):** only files loaded during the run enter the denominator. Mock at module boundaries so untested MCP/plugin/AI graphs are not dragged in at 0%.

## Branch coverage

Prefer table-driven cases (`it.each`) that hit both sides of conditionals — branches is the binding gate.
