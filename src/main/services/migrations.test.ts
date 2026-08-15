import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { migrations, runMigrations } from './migrations';
import { legacyMigrations } from './__fixtures__/legacyChain';

// The newest migration's version. The v75 baseline is still where a fresh
// database's schema comes from; anything after it is an incremental migration
// on top, so HEAD moves and the baseline does not.
const HEAD = 76;

/** The squashed baseline every fresh database starts from. */
const BASELINE = 75;

// The schema the retired v52..v74 chain produced, frozen as executable SQL.
// It is the only surviving witness to what the squashed migrations did, and
// the parity test below is what stops the baseline drifting away from it.
const V74_FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'schema-v74.sql'), 'utf8');

const EXPECTED_TABLES = [
  'activities', 'agent_memories', 'agents', 'bridge_configs', 'bridge_sessions',
  'channel_participants', 'channels', 'conversation_folders', 'events', 'files', 'mcp_servers',
  'memory_blocks', 'memory_entries', 'memory_fts', 'memory_fts_config', 'memory_fts_data', 'memory_fts_docsize', 'memory_fts_idx', 'memory_vec_meta',
  'message_attachments', 'messages', 'messages_fts', 'messages_fts_config', 'messages_fts_data', 'messages_fts_docsize', 'messages_fts_idx', 'note_labels', 'notes',
  'plugin_grants', 'plugin_state', 'plugin_storage', 'projects', 'routines', 'settings',
  'shadow_nudges', 'sync_changes', 'sync_meta', 'sync_peers',
  'sync_row_state', 'tasks', 'tool_approval_grants', 'tool_session_states', 'users', 'workflows',
];

// Tables retired by the fold-chats-into-channels + calendar-unify squash. A
// public build has never created them; the assertion is that the flattening
// did not quietly reintroduce one.
const RETIRED_TABLES = [
  'chats', 'chat_participants', 'chat_messages', 'chat_message_attachments',
  'milestones', 'deadlines',
];

function tableNames(db: Database.Database): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>).map(r => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
}

/**
 * Schema as a comparable map, insensitive to the things that legitimately
 * differ between DDL that was typed and DDL that SQLite rewrote.
 *
 * Comments go (the baseline explains itself; ALTER TABLE never carried them),
 * whitespace collapses, spacing around commas and parens is dropped — `ALTER
 * TABLE ADD COLUMN` appends ` , col TYPE` where hand-written DDL has `, col
 * TYPE` — and the quotes SQLite puts around a renamed table's name are
 * stripped, since `channels` reached v74 via a rebuild-and-rename.
 *
 * What survives normalization is everything that decides behaviour: column
 * names, types, defaults, CHECK constraints, foreign keys, trigger bodies.
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/CREATE TABLE "([^"]+)"/g, 'CREATE TABLE $1')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();
}

function schemaOf(db: Database.Database): Map<string, string> {
  const rows = db.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ type: string; name: string; sql: string }>;
  return new Map(rows.map(r => [`${r.type} ${r.name}`, normalizeSql(r.sql)]));
}

/** A database as a v74 build left it: chain-built schema, stamped version. */
function v74Database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(V74_FIXTURE);
  db.pragma('user_version = 74');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * A database as some older build actually left it, built by replaying the
 * pre-squash chain up to `version`.
 *
 * The chain lives in __fixtures__/legacyChain.ts precisely so this is possible:
 * the migrations that produced v52..v74 are gone from the product, so without
 * a frozen copy there would be nothing to generate a realistic old database
 * from.
 */
function legacyDatabase(version: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of legacyMigrations) {
    if (m.version > version) break;
    // Mirrors the runner: a table rebuild needs foreign keys off, and the
    // pragma is ignored inside a transaction.
    if (m.requiresForeignKeysOff) {
      db.pragma('foreign_keys = OFF');
      m.migrate(db);
      db.pragma('foreign_keys = ON');
    } else {
      m.migrate(db);
    }
    db.pragma(`user_version = ${m.version}`);
  }
  return db;
}

function freshDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  return db;
}

/**
 * A database with the v75 baseline applied and nothing after it.
 *
 * The parity claim below is about the *baseline* — that it reproduces what the
 * retired v52..v74 chain built. Migrations added after it are supposed to
 * change the schema, so comparing a fully-migrated database against the v74
 * fixture would fail for exactly the reason it should.
 */
function baselineDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  migrations.find(m => m.version === BASELINE)!.migrate(db);
  db.pragma('foreign_keys = ON');
  return db;
}

describe('runMigrations (baseline v75)', () => {
  it('builds the whole schema on a fresh DB and stamps user_version at HEAD', () => {
    const db = freshDatabase();

    expect(db.pragma('user_version', { simple: true })).toBe(HEAD);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    db.close();
  });

  it('starts from the squashed baseline and only moves forward from there', () => {
    const versions = migrations.map(m => m.version);

    expect(versions[0]).toBe(BASELINE);
    expect(versions[versions.length - 1]).toBe(HEAD);
    // Strictly ascending and unique — two migrations at one version would let
    // the runner skip whichever it saw second.
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('does not create any of the retired chat_* / milestones / deadlines tables', () => {
    const db = freshDatabase();

    const tables = new Set(tableNames(db));
    for (const t of RETIRED_TABLES) {
      expect(tables.has(t)).toBe(false);
    }
    db.close();
  });

  it('re-running at HEAD is a no-op, not a rejection', () => {
    const db = freshDatabase();
    expect(() => runMigrations(db, HEAD)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(HEAD);
    db.close();
  });
});

/**
 * The squash's load-bearing claim: a database built by the old chain and one
 * built by the new baseline are the same database.
 *
 * Without this the flattening is unverifiable — the migrations that made the
 * v74 schema no longer exist, so nothing else in the suite can tell you a
 * column was dropped on the way through.
 */
describe('v75 baseline parity with the v52..v74 chain', () => {
  it('reproduces the chain-built schema object for object', () => {
    const fresh = baselineDatabase();
    const chain = new Database(':memory:');
    chain.exec(V74_FIXTURE);

    const built = schemaOf(fresh);
    const expected = schemaOf(chain);

    // Compared as maps so a failure names the object that differs rather than
    // dumping two 800-line schemas side by side.
    expect([...built.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, sql] of expected) {
      expect(`${name}: ${built.get(name)}`).toBe(`${name}: ${sql}`);
    }
    fresh.close();
    chain.close();
  });

  it('upgrades a v74 database without disturbing its rows', () => {
    const db = v74Database();
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','P','',1)`).run();
    db.prepare(`INSERT INTO channels (id, name, type, project_id, created_at) VALUES ('c-1','general','public','p-1',1)`).run();
    db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
      VALUES ('m-1','c-1','u-1','human','still here',1)
    `).run();
    const before = schemaOf(db);

    runMigrations(db, 74);

    expect(db.pragma('user_version', { simple: true })).toBe(HEAD);
    // The baseline itself is a no-op on a v74 database; only the migrations
    // added after it may change the schema, and only additively. Anything
    // dropped or rebuilt here would be data loss on a live database.
    const after = schemaOf(db);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, sql] of before) {
      if (name === 'table routines') continue; // gained `output` in v76
      expect(`${name}: ${after.get(name)}`).toBe(`${name}: ${sql}`);
    }
    expect(columnNames(db, 'routines')).toContain('output');
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('m-1')).toEqual({ content: 'still here' });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

});

describe('conversations: channels, chats and folders share one table', () => {
  it('carries the columns a 1:1 chat needs on channels', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'channels');
    // A 1:1 chat is a channels row with type='direct' + agent_id set, so the
    // chat-specific columns live on channels — all nullable, so group and
    // project channels are unaffected.
    for (const col of ['id', 'name', 'type', 'project_id', 'agent_id',
      'archived_at', 'last_message_at', 'tags', 'user_persona']) {
      expect(cols).toContain(col);
    }
    db.close();
  });

  it('admits every channel subtype and rejects anything else', () => {
    const db = freshDatabase();
    const insert = (id: string, type: string) => db.prepare(
      `INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, 1)`
    ).run(id, id, type);

    for (const type of ['public', 'project', 'direct', 'work']) {
      expect(() => insert(`c-${type}`, type)).not.toThrow();
    }
    expect(() => insert('c-x', 'nonsense')).toThrow();
    db.close();
  });

  it('messages carries channel_id + is_draft (drafts work in 1:1s)', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'messages');
    expect(cols).toContain('channel_id');
    expect(cols).toContain('is_draft');
    expect(cols).toContain('parent_message_id');
    expect(cols).toContain('branch_index');
    db.close();
  });

  it('creates conversation_folders with its sync triggers', () => {
    const db = freshDatabase();

    expect(columnNames(db, 'channels')).toContain('folder_id');
    expect(columnNames(db, 'conversation_folders')).toEqual(
      ['id', 'project_id', 'name', 'position', 'created_at'],
    );

    const triggers = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_sync_conversation_folders%' ORDER BY name"
    ).all() as Array<{ name: string }>).map(t => t.name);
    expect(triggers).toEqual([
      'trg_sync_conversation_folders_delete',
      'trg_sync_conversation_folders_insert',
      'trg_sync_conversation_folders_update',
    ]);
    db.close();
  });

  it('folder writes land in the sync oplog', () => {
    const db = freshDatabase();
    db.prepare(
      "INSERT INTO conversation_folders (id, name, position, created_at) VALUES ('f1', 'Work', 0, 1)"
    ).run();
    const change = db.prepare(
      "SELECT table_name, row_id, op FROM sync_changes WHERE table_name = 'conversation_folders'"
    ).get() as { table_name: string; row_id: string; op: string } | undefined;
    expect(change).toEqual({ table_name: 'conversation_folders', row_id: 'f1', op: 'insert' });
    db.close();
  });

  // A deleted task must not take a work session's transcript with it, and a
  // deleted parent channel must not delete the session either.
  it('detaches a work session rather than cascading when its task or parent goes away', () => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','P','',1)`).run();
    db.prepare(`INSERT INTO agents (id, name, description, system_prompt, model, provider, color, created_at) VALUES ('a-1','A','','','m','anthropic','#fff',1)`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, content, created_at) VALUES ('t-1','p-1','do the thing',1)`).run();
    db.prepare(`INSERT INTO channels (id, name, type, project_id, created_at) VALUES ('c-1','general','public','p-1',1)`).run();
    db.prepare(`
      INSERT INTO channels (id, name, type, agent_id, task_id, parent_channel_id, created_at)
      VALUES ('ws-1','session','work','a-1','t-1','c-1',3)
    `).run();

    db.prepare(`DELETE FROM tasks WHERE id = 't-1'`).run();
    db.prepare(`DELETE FROM channels WHERE id = 'c-1'`).run();

    const row = db.prepare('SELECT task_id, parent_channel_id FROM channels WHERE id = ?').get('ws-1');
    expect(row).toEqual({ task_id: null, parent_channel_id: null });
    db.close();
  });
});

describe('calendar: milestones and deadlines are event subtypes', () => {
  it('events carries the folded columns and dropped the polymorphic back-refs', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'events');
    // milestone → status; deadline → priority + is_hard, all nullable.
    expect(cols).toContain('status');
    expect(cols).toContain('priority');
    expect(cols).toContain('is_hard');
    expect(cols).toContain('type');
    // Polymorphic back-refs dropped in favor of the child-side FKs
    // (tasks.event_id, notes.event_id).
    expect(cols).not.toContain('related_type');
    expect(cols).not.toContain('related_id');
    db.close();
  });

  it('refuses a subtype column on the wrong subtype', () => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','P','',1)`).run();
    const insert = (id: string, type: string, cols: string, vals: string) => db.prepare(
      `INSERT INTO events (id, project_id, title, start_time, type, created_at, updated_at${cols})
       VALUES (?, 'p-1', 'E', 1, ?, 1, 1${vals})`
    ).run(id, type);

    expect(() => insert('e-1', 'milestone', ', status', ", 'upcoming'")).not.toThrow();
    expect(() => insert('e-2', 'event', ', status', ", 'upcoming'")).toThrow();
    expect(() => insert('e-3', 'deadline', ', priority', ", 'high'")).not.toThrow();
    expect(() => insert('e-4', 'milestone', ', priority', ", 'high'")).toThrow();
    db.close();
  });

  it('tasks and notes keep the child-side event_id FKs', () => {
    const db = freshDatabase();
    expect(columnNames(db, 'tasks')).toContain('event_id');
    expect(columnNames(db, 'notes')).toContain('event_id');
    db.close();
  });
});

describe('settings and agents', () => {
  it('keeps both view pointers and puts every provider key in api_keys_json', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'settings');
    for (const col of [
      'id', 'user_name', 'current_project_id', 'current_agent_id',
      'current_channel_id', 'current_user_id', 'current_chat_id', 'default_agent_id',
      'system_agent_id',
      'theme', 'light_theme', 'dark_theme', 'background_type', 'background_value',
      'background_opacity', 'background_blur', 'oobe_completed',
      'workflow_review_required', 'update_mode', 'api_keys_json',
      'openrouter_sticky_provider', 'font_family', 'custom_font_family',
      'font_scale', 'line_spacing', 'user_avatar', 'memory_embedding',
      'created_at', 'updated_at',
    ]) {
      expect(cols).toContain(col);
    }
    // No per-provider key columns: every provider key lives in api_keys_json.
    for (const col of [
      'anthropic_api_key', 'openai_api_key', 'google_api_key',
      'ollama_api_key', 'lmstudio_api_key',
    ]) {
      expect(cols).not.toContain(col);
    }
    db.close();
  });

  it('defaults the scheduler to running and sticky providers to on', () => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO settings (id, user_name, created_at, updated_at) VALUES (1, 'U', 1, 1)`).run();
    const row = db.prepare(
      'SELECT routines_paused AS paused, openrouter_sticky_provider AS sticky FROM settings WHERE id = 1'
    ).get() as { paused: number; sticky: number };
    expect(row.paused).toBe(0);
    expect(row.sticky).toBe(1);
    db.close();
  });

  it('agents table has every column the app writes', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'agents');
    for (const col of [
      'id', 'name', 'description', 'provider', 'model', 'temperature', 'color',
      'created_at', 'system_prompt', 'avatar', 'max_tokens', 'max_steps',
      'instruct_template', 'stopping_strings', 'context_variables', 'context_formatting',
      'default_tools', 'prompt_cost_per_1m', 'completion_cost_per_1m',
      'channel_behavior', 'archetype', 'context_window', 'debug_logging',
      'compaction_mode', 'tool_send_mode', 'prompt_template',
    ]) {
      expect(cols).toContain(col);
    }
    db.close();
  });
});

describe('workflows and routines', () => {
  const build = () => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1', 'P', '', 1)`).run();
    return db;
  };

  it('has the review gate columns', () => {
    const db = freshDatabase();
    const cols = columnNames(db, 'workflows');
    expect(cols).toContain('review_status');
    expect(cols).toContain('created_by');
    db.close();
  });

  it('treats a routine that has never run as unknown, not failing', () => {
    const db = build();
    db.prepare(`
      INSERT INTO routines (id, project_id, name, cron_schedule, enabled, created_at, updated_at)
      VALUES ('r-1', 'p-1', 'Nightly', '0 3 * * *', 1, 1, 1)
    `).run();

    const row = db.prepare('SELECT last_status, consecutive_failures AS fails FROM routines WHERE id = ?')
      .get('r-1') as { last_status: string | null; fails: number };
    expect(row.last_status).toBeNull();
    expect(row.fails).toBe(0);
    db.close();
  });

  it('constrains last_status to the known outcomes', () => {
    const db = build();
    db.prepare(`
      INSERT INTO routines (id, project_id, name, cron_schedule, enabled, created_at, updated_at)
      VALUES ('r-1', 'p-1', 'Nightly', '0 3 * * *', 1, 1, 1)
    `).run();

    expect(() =>
      db.prepare(`UPDATE routines SET last_status = 'kinda' WHERE id = 'r-1'`).run()
    ).toThrow();
    db.close();
  });

  it('defaults workflows and routines to unpinned', () => {
    const db = build();
    db.prepare(`
      INSERT INTO workflows (id, project_id, name, dag_definition, created_at, updated_at)
      VALUES ('w-1', 'p-1', 'W', '{}', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO routines (id, project_id, name, cron_schedule, created_at, updated_at)
      VALUES ('r-1', 'p-1', 'R', '0 3 * * *', 1, 1)
    `).run();

    expect(db.prepare('SELECT pinned FROM workflows WHERE id = ?').get('w-1')).toEqual({ pinned: 0 });
    expect(db.prepare('SELECT pinned FROM routines WHERE id = ?').get('r-1')).toEqual({ pinned: 0 });
    db.close();
  });
});

describe('tool approval waivers', () => {
  const build = () => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','P','',1)`).run();
    db.prepare(`
      INSERT INTO agents (id, name, description, system_prompt, model, provider, color, created_at)
      VALUES ('a-1','A','','','m','anthropic','#fff',1)
    `).run();
    db.prepare(`INSERT INTO channels (id, name, type, created_at) VALUES ('c-1','general','public',1)`).run();
    return db;
  };

  const grant = (db: Database.Database) => db.prepare(`
    INSERT INTO tool_approval_grants (id, container_id, agent_id, tool_name, granted_at)
    VALUES ('g-1','c-1','a-1','bash',1)
  `).run();

  it('stores one waiver per tool, agent and conversation', () => {
    const db = build();
    grant(db);
    expect(() => grant(db)).toThrow(); // UNIQUE — granting twice is not two waivers
    db.close();
  });

  // A waiver is bounded by the thing it was about. Deleting the conversation
  // must not leave a standing permission behind for a container id that could
  // later be reused.
  it('drops waivers when the conversation goes away', () => {
    const db = build();
    grant(db);
    db.prepare(`DELETE FROM channels WHERE id = 'c-1'`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM tool_approval_grants').get()).toEqual({ c: 0 });
    db.close();
  });

  it('drops waivers when the agent is deleted', () => {
    const db = build();
    grant(db);
    db.prepare(`DELETE FROM agents WHERE id = 'a-1'`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM tool_approval_grants').get()).toEqual({ c: 0 });
    db.close();
  });
});

describe('activity attribution', () => {
  it('defaults audience to system so unknown event types fail closed', () => {
    const db = freshDatabase();
    db.prepare(`
      INSERT INTO activities (id, type, category, source, timestamp, created_at)
      VALUES ('act-1','something:new','misc','core',1,1)
    `).run();
    expect(db.prepare(`SELECT audience FROM activities WHERE id = 'act-1'`).get())
      .toEqual({ audience: 'system' });
    db.close();
  });

  it('leaves agent_id nullable — plenty of activity has no single agent behind it', () => {
    const db = freshDatabase();

    const agentCol = (db.pragma('table_info(activities)') as Array<{ name: string; notnull: number }>)
      .find(c => c.name === 'agent_id');
    expect(agentCol).toBeDefined();
    expect(agentCol!.notnull).toBe(0);

    // Routines own a schedule, not an agent, and a workflow run spans however
    // many agent nodes it has.
    db.prepare(`
      INSERT INTO activities (id, type, category, source, audience, timestamp, created_at)
      VALUES ('act-1','routine:execution:started','routine','core','user',1,1)
    `).run();
    expect(db.prepare(`SELECT agent_id FROM activities WHERE id = 'act-1'`).get())
      .toEqual({ agent_id: null });
    db.close();
  });

  it('indexes attributed rows for per-agent lookup', () => {
    const db = freshDatabase();
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_activities_agent'`
    ).get();
    expect(idx).toBeDefined();
    db.close();
  });
});

describe('sync change capture', () => {
  it('installs triggers for the synced-table set and nothing for retired tables', () => {
    const db = freshDatabase();

    const triggers = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
    ).all() as Array<{ name: string }>).map(t => t.name);

    // Direct channels replicate through the channels/messages/channel_participants
    // triggers like every other channel — there are no chat_* triggers.
    const syncedTables = [
      'agents', 'projects', 'users', 'channels', 'messages', 'tasks', 'notes',
      'conversation_folders', 'channel_participants',
    ];
    for (const table of syncedTables) {
      for (const op of ['insert', 'update', 'delete']) {
        expect(triggers).toContain(`trg_sync_${table}_${op}`);
      }
    }
    expect(triggers.some(t => t.includes('chat'))).toBe(false);
    expect(triggers.some(t => t.includes('milestone') || t.includes('deadline'))).toBe(false);
    db.close();
  });
});

describe('full-text search indexes', () => {
  const build = (): Database.Database => {
    const db = freshDatabase();
    db.prepare(`INSERT INTO channels (id, name, type, created_at) VALUES ('ch-1', 'Room', 'public', 1)`).run();
    return db;
  };

  const addMessage = (db: Database.Database, id: string, content: string): void => {
    db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
      VALUES (?, 'ch-1', 'agent-1', 'agent', ?, 1)
    `).run(id, content);
  };

  const matches = (db: Database.Database, term: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).get(term) as { n: number }).n;

  it('keeps the message index in step with inserts, updates and deletes', () => {
    const db = build();
    addMessage(db, 'm-1', 'the quokka proposal');
    expect(matches(db, 'quokka')).toBe(1);

    db.prepare(`UPDATE messages SET content = 'the wombat proposal' WHERE id = 'm-1'`).run();
    expect(matches(db, 'quokka')).toBe(0);
    expect(matches(db, 'wombat')).toBe(1);

    db.prepare(`DELETE FROM messages WHERE id = 'm-1'`).run();
    expect(matches(db, 'wombat')).toBe(0);
    db.close();
  });

  it('keeps the memory index in step with its base table', () => {
    const db = freshDatabase();
    db.prepare(`
      INSERT INTO memory_entries (key, value, created_at, updated_at) VALUES ('k-1','a note about pangolins',1,1)
    `).run();
    const hits = (term: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?`).get(term) as { n: number }).n;

    expect(hits('pangolins')).toBe(1);
    db.prepare(`DELETE FROM memory_entries WHERE key = 'k-1'`).run();
    expect(hits('pangolins')).toBe(0);
    db.close();
  });

  it('indexes replicated writes, which the sync triggers deliberately skip', () => {
    // sync_meta.applying = 1 silences change capture so a replicated row does
    // not echo back to the peer. The FTS triggers must ignore that flag — a
    // message from another device has to be as searchable as a local one.
    const db = build();
    db.prepare('UPDATE sync_meta SET applying = 1 WHERE id = 1').run();
    const oplogBefore = (db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get() as { n: number }).n;
    addMessage(db, 'm-remote', 'synced from the laptop');
    db.prepare('UPDATE sync_meta SET applying = 0 WHERE id = 1').run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get()).toEqual({ n: oplogBefore });
    expect(matches(db, 'synced')).toBe(1);
    db.close();
  });

  it('is not replicated — each device builds its own index', () => {
    const db = build();
    addMessage(db, 'm-1', 'anything');
    const tables = (db.prepare(
      `SELECT DISTINCT table_name FROM sync_changes`
    ).all() as Array<{ table_name: string }>).map(r => r.table_name);

    expect(tables).not.toContain('messages_fts');
    db.close();
  });
});

/**
 * The bug this suite exists for.
 *
 * The baseline shipped in 0.4.0 refused anything below v74. v0.3.12 — the
 * build most installs actually had — stamps 72, so the check rejected the only
 * databases in the field, and it threw inside whenReady() before createWindow()
 * ran: the app started, spawned its processes, and never showed a window.
 *
 * Every version the chain could have left behind is exercised, not a
 * representative sample, because "which versions are in the wild" is exactly
 * the question that was answered wrongly the first time.
 */
describe('converging a database from any older build', () => {
  const LEGACY_VERSIONS = legacyMigrations.map(m => m.version);

  it('covers every version the pre-squash chain could produce', () => {
    expect(LEGACY_VERSIONS[0]).toBe(52);
    expect(LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1]).toBe(74);
    expect(LEGACY_VERSIONS).toHaveLength(23);
  });

  it.each(LEGACY_VERSIONS)('brings a v%i database to the HEAD schema exactly', (version) => {
    const db = legacyDatabase(version);
    expect(db.pragma('user_version', { simple: true })).toBe(version);

    runMigrations(db, version);

    expect(db.pragma('user_version', { simple: true })).toBe(HEAD);

    const fresh = freshDatabase();
    const converged = schemaOf(db);
    const expected = schemaOf(fresh);

    expect([...converged.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, sql] of expected) {
      expect(`${name}: ${converged.get(name)}`).toBe(`${name}: ${sql}`);
    }
    db.close();
    fresh.close();
  });

  // The failure that started this: v0.3.12's database, on the build that
  // replaced it.
  it('keeps the data in a v72 database — the version 0.3.12 shipped', () => {
    const db = legacyDatabase(72);
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p','P','',1)`).run();
    db.prepare(`INSERT INTO agents (id, name, description, system_prompt, model, provider, color, created_at) VALUES ('a','A','','','m','anthropic','#fff',1)`).run();
    db.prepare(`INSERT INTO channels (id, name, type, project_id, created_at) VALUES ('c','general','public','p',1)`).run();
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp) VALUES (?, 'c', 'u', 'human', ?, ?)`)
        .run(`m-${i}`, `message ${i}`, i);
    }

    runMigrations(db, 72);

    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 5 });
    expect(db.prepare('SELECT COUNT(*) c FROM channels').get()).toEqual({ c: 1 });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // Foreign keys must be back on afterwards — the runner turns them off for
    // the channels rebuild.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  // An FTS5 external-content index over a table that already has rows starts
  // empty, and an empty index fails silently — no error, just no results.
  it('makes transcripts written before the index searchable', () => {
    const db = legacyDatabase(73); // messages_fts arrives at 74
    db.prepare(`INSERT INTO channels (id, name, type, created_at) VALUES ('c','general','public',1)`).run();
    db.prepare(`INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp) VALUES ('m','c','u','human','a decision about pangolins',1)`).run();

    runMigrations(db, 73);

    const hits = db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).get('pangolins') as { n: number };
    expect(hits.n).toBe(1);
    db.close();
  });

  it('preserves a work session on a database that already had one', () => {
    const db = legacyDatabase(74);
    db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p','P','',1)`).run();
    db.prepare(`INSERT INTO agents (id, name, description, system_prompt, model, provider, color, created_at) VALUES ('a','A','','','m','anthropic','#fff',1)`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, content, created_at) VALUES ('t','p','do it',1)`).run();
    db.prepare(`INSERT INTO channels (id, name, type, agent_id, task_id, created_at) VALUES ('ws','session','work','a','t',1)`).run();

    runMigrations(db, 74);

    expect(db.prepare(`SELECT type, task_id FROM channels WHERE id = 'ws'`).get())
      .toEqual({ type: 'work', task_id: 't' });
    db.close();
  });

  it('still refuses a database from before the chats-into-channels fold', () => {
    const db = new Database(':memory:');
    for (const version of [1, 37, 51]) {
      expect(() => runMigrations(db, version)).toThrow(/too old for this build/);
    }
    db.close();
  });
});
