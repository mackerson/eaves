import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../services/migrations';
import { demoDataset } from './dataset';

/**
 * The demo dataset has to keep up with the schema, and left to itself it will
 * not — a table gets added, nothing breaks, and eighteen months later the
 * screenshots quietly show a product missing half its features.
 *
 * So every table is classified exactly once, here. Add a table and this test
 * fails until someone decides which it is. That decision is the point: "we
 * chose not to seed this" and "nobody thought about it" look identical in a
 * demo database, and only one of them is fine.
 */

/** Tables the demo scenario puts rows in. */
const SEEDED = new Set([
  'settings',              // userName
  'users',                 // the current user, created at first run
  'agents',
  'projects',
  'tasks',
  'notes',
  'channels',              // rooms and the 1:1 chats projected over them
  'channel_participants',
  'messages',
  'workflows',
  'routines',
  'memory_blocks',
  'activities',            // written as a side effect of everything above
  'usage_events',          // derived from the seeded agent turns by the loader
]);

/**
 * Tables the demo deliberately leaves empty, each with the reason. A reason
 * that stops being true is a prompt to move the entry up.
 */
const INTENTIONALLY_EMPTY: Record<string, string> = {
  mcp_servers: 'Needs a real MCP server to connect to; a dangling row would render as a broken integration.',
  note_labels: 'Labels are a per-user organisational habit, not a product feature worth staging.',
  conversation_folders: 'Folders only read well with enough conversations to need them. Worth revisiting when the demo grows.',
  message_attachments: 'Requires real files on disk at seed time, whose absolute paths would leak the machine that built the demo.',
  events: 'The calendar demo needs dates relative to the viewer, which the IPC loader cannot pin. Revisit with the in-process loader.',
  files: 'Same problem as attachments: real paths on a real disk.',
  bridge_sessions: 'Messaging bridges need external credentials.',
  bridge_configs: 'Messaging bridges need external credentials.',
  plugin_storage: 'Owned by plugins at runtime; seeding it would fake state no plugin agreed to.',
  plugin_state: 'Plugin enable/disable is whatever the install produced, not something the dataset should assert.',
  plugin_grants: 'Consent records. Fabricating consent is exactly the wrong thing to demo.',
  agent_memories: 'The shadow proposal queue is mid-review state; a demo of it needs the review UI in the same shot.',
  memory_entries: 'Archival memory is only legible in a screenshot alongside a search, which no static seed provides.',
  memory_vec_meta: 'Written by the embedder at runtime when semantic search is configured.',
  tool_approval_grants: 'A waiver only makes sense next to the approval it waived.',
  shadow_nudges: 'Internal queue with no user-facing surface of its own.',
  tool_session_states: 'Per-conversation tool toggles; the defaults are the interesting state.',
  sync_meta: 'Seeded by the schema baseline itself — device identity, not demo content.',
  sync_peers: 'Pairing needs a second device.',
  sync_changes: 'The replication oplog fills itself as the seed writes.',
  sync_row_state: 'Per-row replication bookkeeping, written by the sync triggers rather than by anything a user does.',
};

/** FTS5 shadow tables — implementation detail of an index, never seeded directly. */
const isFtsShadow = (name: string) =>
  /_(data|idx|content|docsize|config)$/.test(name) && /_fts_/.test(name.replace(/_(data|idx|content|docsize|config)$/, '_fts_'));

function userFacingTables(): string[] {
  const db = new Database(':memory:');
  runMigrations(db, 0);
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  db.close();
  return names.filter(n => !n.endsWith('_fts') && !isFtsShadow(n));
}

describe('demo dataset coverage', () => {
  it('classifies every table as seeded or deliberately empty', () => {
    const unclassified = userFacingTables().filter(
      t => !SEEDED.has(t) && !(t in INTENTIONALLY_EMPTY),
    );

    expect(
      unclassified,
      `New table(s) with no place in the demo dataset: ${unclassified.join(', ')}.\n` +
      `Add each to SEEDED (and put it in the dataset) or to INTENTIONALLY_EMPTY with a reason.`,
    ).toEqual([]);
  });

  it('does not claim to cover tables that no longer exist', () => {
    const tables = new Set(userFacingTables());
    const stale = [...SEEDED, ...Object.keys(INTENTIONALLY_EMPTY)].filter(t => !tables.has(t));

    expect(stale, `Classified but no longer in the schema: ${stale.join(', ')}`).toEqual([]);
  });

  it('every excuse says why', () => {
    for (const [table, reason] of Object.entries(INTENTIONALLY_EMPTY)) {
      expect(reason.length, `${table} needs a real reason, not a placeholder`).toBeGreaterThan(25);
    }
  });
});

/**
 * The content rules from dataset.ts, enforced. These screenshots go on a public
 * README, and the failure mode is not hypothetical: this project's own history
 * named a real beta tester in six commit messages before anyone noticed.
 */
describe('demo dataset content', () => {
  const everyString = JSON.stringify(demoDataset);

  it('contains no absolute filesystem paths', () => {
    expect(everyString).not.toMatch(/\/(home|Users)\//);
    expect(everyString).not.toMatch(/[A-Z]:\\\\Users/);
  });

  it('contains nothing shaped like a credential', () => {
    expect(everyString).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(everyString).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(everyString).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('is substantial enough to show the product working', () => {
    // Not a style rule — a demo with one message in it photographs as an empty
    // app, which is worse than no screenshot.
    expect(demoDataset.agents.length).toBeGreaterThanOrEqual(3);
    expect(demoDataset.chats.length).toBeGreaterThanOrEqual(2);
    const messages = [...demoDataset.chats, ...demoDataset.channels]
      .reduce((n, c) => n + c.messages.length, 0);
    expect(messages).toBeGreaterThanOrEqual(10);
  });

  it('references only agents it defines', () => {
    const keys = new Set(demoDataset.agents.map(a => a.key));
    const referenced = [
      ...demoDataset.chats.map(c => c.agent),
      ...demoDataset.channels.flatMap(c => c.agents),
      ...demoDataset.memories.map(m => m.agent),
      ...[...demoDataset.chats, ...demoDataset.channels]
        .flatMap(c => c.messages.map(m => m.from))
        .filter(f => f !== 'user'),
    ];
    const dangling = [...new Set(referenced)].filter(k => !keys.has(k));
    expect(dangling, `Agent keys used but never defined: ${dangling.join(', ')}`).toEqual([]);
  });

  /**
   * The trap that cost a seeding run: send-message resolves @mentions against
   * the channel's agent participants, so a mention that matches someone in the
   * room starts a real, billable turn. The loader seeds messages before anyone
   * joins, which is what makes mentions safe — this pins the invariant so a
   * future loader change cannot quietly start spending money.
   */
  it('only @mentions agents that are in the channel it is posted to', () => {
    for (const channel of demoDataset.channels) {
      const names = new Set(
        demoDataset.agents.filter(a => channel.agents.includes(a.key)).map(a => a.name),
      );
      for (const message of channel.messages) {
        for (const [, mentioned] of message.content.matchAll(/@([A-Za-z][\w-]*)/g)) {
          expect(
            names.has(mentioned),
            `#${channel.name} mentions @${mentioned}, who is not one of its agents. ` +
            `Either it is a typo, or the mention will never render as a real one.`,
          ).toBe(true);
        }
      }
    }
  });
});
