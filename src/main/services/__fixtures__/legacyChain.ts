/**
 * The pre-squash migration chain, v52 through v74 — TEST FIXTURE ONLY.
 *
 * This is `migrations.ts` as it stood immediately before the v75 squash
 * (archive commit de25ecd^). It is not shipped and nothing in `src/main`
 * imports it. It exists so the test suite can build a database at any version
 * a real install could actually be sitting at, and prove the v75 baseline
 * carries it forward.
 *
 * Without this the convergence path is untestable: the migrations that
 * produced v52..v74 no longer exist in the product, so there would be nothing
 * to generate an "old database" from except hand-written guesses.
 *
 * Do not edit to add new behaviour. It is a frozen record of what shipped.
 */
/* eslint-disable */
import Database from 'better-sqlite3';
// Logging is irrelevant to a fixture; keep it silent.
const logger = { info: (..._a: unknown[]) => {}, warn: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };

type MigrationFn = (db: Database.Database) => void;

export interface Migration {
  version: number;
  description: string;
  migrate: MigrationFn;
  /**
   * Set when the migration rebuilds a table other rows point at.
   *
   * SQLite performs an implicit `DELETE FROM` before `DROP TABLE`, so with
   * foreign keys enforced, dropping a parent fires every ON DELETE CASCADE
   * hanging off it — dropping `channels` mid-rebuild would take the entire
   * `messages` table with it. `PRAGMA foreign_keys` is also a no-op inside a
   * transaction, so the runner has to toggle it around the transaction rather
   * than the migration doing it itself.
   */
  requiresForeignKeysOff?: boolean;
}

function withTransaction(db: Database.Database, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Baseline schema (v52). Second squash: folds the previous v37 baseline plus
 * incremental migrations v38–v51 into one truth, and lands two structural
 * changes that retire long-standing parallel data models:
 *
 *   1. chats folded into channels. The four chat_* tables are gone — a 1:1
 *      chat is now a `channels` row with type='direct'. The app keeps a
 *      "Chats" experience as a projection over direct channels, so the merge
 *      is storage-only. channels gains the columns chats carried
 *      (agent_id, archived_at, last_message_at, tags, user_persona), all
 *      nullable so group/project channels are unaffected. `messages` already
 *      carries is_draft, so drafts now work in 1:1s for free.
 *
 *   2. calendar triple collapsed. The standalone `milestones` and `deadlines`
 *      tables are gone; milestone/deadline are event subtypes selected by the
 *      existing `events.type` enum, with their unique fields folded onto events
 *      as nullable columns (status for milestones; priority + is_hard for
 *      deadlines). The polymorphic related_type/related_id back references on
 *      events and deadlines are dropped in favor of the child-side FKs already
 *      present on tasks.event_id and notes.event_id.
 *
 * Pointers into the old tables (settings.current_chat_id,
 * bridge_sessions.current_chat_id, tool_session_states.context_id) are kept
 * verbatim — the one-off transform preserves ids, so a former chat id is now a
 * valid channel id and every soft pointer resolves without rewriting.
 *
 * Any DB below v52 is pre-squash. Dev DBs should be deleted and recreated;
 * real DBs run through scripts/migrate-chats-to-channels.ts, which reshapes the
 * data and stamps user_version to 52. runMigrations rejects anything in
 * [1, 52) rather than silently drifting into a half-migrated state.
 *
 * Future schema changes go in as new migrations at version 53+.
 */
function createBaselineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_name TEXT NOT NULL DEFAULT 'User',
      api_keys_json TEXT NOT NULL DEFAULT '{}',
      current_project_id TEXT,
      current_agent_id TEXT,
      -- current_channel_id and current_chat_id track the last-open conversation
      -- in the two panes independently (group/project Channels view vs 1:1 Chats
      -- view). Post-v52 both hold a channels.id — a "chat" is a channels row with
      -- type='direct'. The name reflects the live UI concept, not the retired
      -- chats table.
      current_channel_id TEXT,
      current_user_id TEXT,
      current_chat_id TEXT,
      default_agent_id TEXT,
      system_agent_id TEXT,
      theme TEXT DEFAULT 'dark',
      light_theme TEXT DEFAULT 'light',
      dark_theme TEXT DEFAULT 'dark',
      background_type TEXT DEFAULT 'none',
      background_value TEXT,
      background_opacity REAL DEFAULT 0.3,
      background_blur INTEGER DEFAULT 0,
      oobe_completed INTEGER DEFAULT 0,
      workflow_review_required INTEGER NOT NULL DEFAULT 1,
      routines_paused INTEGER NOT NULL DEFAULT 0,
      update_mode TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio')),
      model TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.7,
      top_p REAL,
      greeting TEXT,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      system_prompt TEXT,
      avatar TEXT,
      max_tokens INTEGER,
      max_steps INTEGER,
      instruct_template TEXT,
      stopping_strings TEXT,
      context_variables TEXT,
      context_formatting TEXT,
      default_tools TEXT,
      prompt_cost_per_1m REAL,
      completion_cost_per_1m REAL,
      channel_behavior TEXT,
      archetype TEXT,
      context_window INTEGER,
      debug_logging INTEGER DEFAULT 0,
      tool_send_mode TEXT,
      prompt_template TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
      enabled INTEGER NOT NULL DEFAULT 1,
      config_command TEXT,
      config_args TEXT,
      config_env TEXT,
      config_url TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      files TEXT,
      directory TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      due_date INTEGER,
      start_date INTEGER,
      estimated_duration INTEGER,
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      color TEXT DEFAULT 'default',
      priority TEXT DEFAULT 'medium',
      labels TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT,
      color TEXT DEFAULT 'default',
      pinned INTEGER DEFAULT 0,
      labels TEXT,
      ai_metadata TEXT,
      sort_order INTEGER DEFAULT 0,
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS note_labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT 'default',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('public', 'project', 'direct')),
      project_id TEXT,
      pinned INTEGER DEFAULT 0,
      agent_id TEXT,
      archived_at INTEGER,
      last_message_at INTEGER,
      tags TEXT,
      user_persona TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS channel_participants (
      channel_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      participant_type TEXT NOT NULL,
      display_name TEXT,
      color TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, participant_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_type TEXT NOT NULL CHECK (sender_type IN ('human', 'agent')),
      sender_display_name TEXT,
      sender_color TEXT,
      metadata TEXT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      content_blocks TEXT,
      metrics TEXT,
      response_messages_json TEXT,
      parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      branch_index INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'regenerated')),
      is_draft INTEGER DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_path TEXT,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      attachment_type TEXT NOT NULL CHECK (attachment_type IN ('file', 'image', 'audio', 'video')),
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      location TEXT,
      is_all_day INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'event' CHECK (type IN ('event', 'milestone', 'deadline')),
      status TEXT CHECK (status IS NULL OR status IN ('upcoming', 'achieved', 'missed')),
      priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'critical')),
      is_hard INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- Subtype invariants: the sparse subtype columns are only meaningful for
      -- their own type. Enforce that a non-milestone can't carry a status and a
      -- non-deadline can't carry priority/is_hard, so an app-layer bug writing
      -- into the wrong subtype's columns fails loudly instead of persisting
      -- garbage. (Migrated DBs can't gain this CHECK via ALTER — the transform
      -- script leaves it to app-layer enforcement there; fresh DBs get it here.)
      CHECK (type = 'milestone' OR status IS NULL),
      CHECK (type = 'deadline' OR (priority IS NULL AND is_hard IS NULL)),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      dag_definition TEXT NOT NULL,
      safety_config TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('pending', 'approved')),
      created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      workflow_id TEXT,
      cron_schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run INTEGER,
      next_run INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_status TEXT CHECK(last_status IN ('success','failure')),
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER,
      mime_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'core',
      data TEXT,
      project_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_sessions (
      platform TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      current_chat_id TEXT,
      current_agent_id TEXT,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (platform, external_user_id)
    );

    CREATE TABLE IF NOT EXISTS bridge_configs (
      platform TEXT PRIMARY KEY,
      config_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      auto_start INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );

    CREATE TABLE IF NOT EXISTS plugin_state (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    -- Marketplace: records the user's pre-install permission consent for an
    -- installed plugin (the grants shown + approved at install time).
    CREATE TABLE IF NOT EXISTS plugin_grants (
      plugin_id TEXT PRIMARY KEY,
      permissions TEXT NOT NULL,
      version TEXT,
      consented_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'conversation',
      status TEXT NOT NULL DEFAULT 'candidate',
      source_context TEXT,
      confidence REAL,
      reviewed_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shadow_nudges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_session_states (
      context_id TEXT PRIMARY KEY,
      enabled_tools TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      cert_pem TEXT,
      key_pem TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      applying INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_peers (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      cert_fingerprint TEXT NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_applied_seq INTEGER NOT NULL DEFAULT 0,
      last_acked_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
      changed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_row_state (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_agent_id ON mcp_servers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(completed);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_event_id ON tasks(event_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_color ON tasks(color);
    CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order);
    CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
    CREATE INDEX IF NOT EXISTS idx_notes_project_id ON notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);
    CREATE INDEX IF NOT EXISTS idx_notes_color ON notes(color);
    CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
    CREATE INDEX IF NOT EXISTS idx_notes_sort_order ON notes(sort_order);
    CREATE INDEX IF NOT EXISTS idx_notes_event_id ON notes(event_id);
    CREATE INDEX IF NOT EXISTS idx_note_labels_project_id ON note_labels(project_id);
    CREATE INDEX IF NOT EXISTS idx_channels_project_id ON channels(project_id);
    CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
    CREATE INDEX IF NOT EXISTS idx_channels_agent_id ON channels(agent_id);
    CREATE INDEX IF NOT EXISTS idx_channels_archived_at ON channels(archived_at);
    CREATE INDEX IF NOT EXISTS idx_channels_last_message_at ON channels(last_message_at);
    CREATE INDEX IF NOT EXISTS idx_channel_participants_channel_id ON channel_participants(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_parent_message_id ON messages(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_type ON message_attachments(attachment_type);
    CREATE INDEX IF NOT EXISTS idx_users_is_current ON users(is_current);
    CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);
    CREATE INDEX IF NOT EXISTS idx_routines_project_id ON routines(project_id);
    CREATE INDEX IF NOT EXISTS idx_routines_workflow_id ON routines(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_routines_next_run ON routines(next_run);
    CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
    CREATE INDEX IF NOT EXISTS idx_activities_category ON activities(category);
    CREATE INDEX IF NOT EXISTS idx_activities_project_id ON activities(project_id);
    CREATE INDEX IF NOT EXISTS idx_activities_source ON activities(source);
    CREATE INDEX IF NOT EXISTS idx_plugin_storage_plugin_id ON plugin_storage(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_shadow_nudges_agent ON shadow_nudges(agent_id, consumed);
    CREATE INDEX IF NOT EXISTS idx_sync_changes_row ON sync_changes(table_name, row_id);
  `);

  seedSyncIdentityAndTriggers(db);
}

/**
 * LAN P2P sync identity row + change-capture triggers. Runtime side lives in
 * src/main/services/sync/.
 *
 * The synced-table list is FROZEN at baseline on purpose — future additions get
 * their own migration installing the extra triggers. The runtime copy lives in
 * src/main/services/sync/syncTables.ts and must stay a superset of what this
 * installs. Direct (1:1) channels need no entry of their own: they replicate
 * through the `channels`/`messages`/`channel_participants` triggers like every
 * other channel.
 */
function seedSyncIdentityAndTriggers(db: Database.Database): void {
  // Seed the identity row. Device id is generated here (stable from baseline
  // onward); cert/key are created lazily when sync is first enabled.
  db.prepare(`
    INSERT OR IGNORE INTO sync_meta (id, device_id, device_name)
    VALUES (1, lower(hex(randomblob(16))), 'This device')
  `).run();

  // Frozen synced-table list: table → PK expression for NEW/OLD rows.
  // Composite keys are joined with '|' (UUID components, '|' cannot collide).
  const synced: Array<{ table: string; newKey: string; oldKey: string }> = [
    { table: 'agents', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'projects', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'users', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'channels', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'messages', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'tasks', newKey: 'NEW.id', oldKey: 'OLD.id' },
    { table: 'notes', newKey: 'NEW.id', oldKey: 'OLD.id' },
    {
      table: 'channel_participants',
      newKey: "NEW.channel_id || '|' || NEW.participant_id",
      oldKey: "OLD.channel_id || '|' || OLD.participant_id",
    },
  ];

  // Millisecond wall clock from inside SQLite (strftime('%s') is seconds-only).
  const nowMs = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  // Echo guard: applyRemoteChanges() flips sync_meta.applying inside its
  // transaction so replicated writes don't re-enter the oplog.
  const guard = 'WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0';

  for (const { table, newKey, oldKey } of synced) {
    for (const [op, event, key] of [
      ['insert', 'INSERT', newKey],
      ['update', 'UPDATE', newKey],
      ['delete', 'DELETE', oldKey],
    ] as const) {
      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_${op}
        AFTER ${event} ON ${table}
        ${guard}
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('${table}', ${key}, '${op}', ${nowMs});
        END
      `).run();
    }
  }
}

function addOpenRouterStickyProviderColumn(db: Database.Database): void {
  // Global toggle for OpenRouter sticky-provider pinning (default ON). When on,
  // a conversation prefers the upstream backend that served its previous turn
  // so the prompt cache stays warm. Idempotent so a re-run on an already-migrated
  // DB is a no-op.
  const cols = db.pragma('table_info(settings)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'openrouter_sticky_provider')) {
    db.prepare(`ALTER TABLE settings ADD COLUMN openrouter_sticky_provider INTEGER NOT NULL DEFAULT 1`).run();
  }
}

function addChannelContextSummaryColumns(db: Database.Database): void {
  // Running conversation summary for compaction: once history crosses budget we
  // summarize the oldest turns into context_summary (folding prior summaries)
  // and keep only recent turns verbatim. summary_through_message_id marks the
  // newest message already folded in, so we only re-summarize freshly-aged
  // turns. Idempotent.
  const cols = db.pragma('table_info(channels)') as Array<{ name: string }>;
  const additions: Array<[string, string]> = [
    ['context_summary', 'context_summary TEXT'],
    ['summary_through_message_id', 'summary_through_message_id TEXT'],
    ['summary_updated_at', 'summary_updated_at INTEGER'],
  ];
  for (const [name, ddl] of additions) {
    if (!cols.some(c => c.name === name)) {
      db.prepare(`ALTER TABLE channels ADD COLUMN ${ddl}`).run();
    }
  }
}

function addAgentCompactionModeColumn(db: Database.Database): void {
  // Per-agent compaction control: 'auto' (default) auto-compacts over budget,
  // 'off' disables it (falls back to plain windowing), 'manual' only compacts
  // on an explicit trigger. NULL = auto. Idempotent.
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'compaction_mode')) {
    db.prepare(`ALTER TABLE agents ADD COLUMN compaction_mode TEXT`).run();
  }
}

function addFontPreferenceColumns(db: Database.Database): void {
  // Reading/accessibility font preferences. NULL = defaults ('default' family,
  // 1.0 scale/spacing) so existing rows need no backfill. font_family is one of
  // 'default' | 'open-dyslexic' | 'custom'; custom_font_family holds the
  // locally-installed family name used when font_family = 'custom'. Idempotent.
  const cols = db.pragma('table_info(settings)') as Array<{ name: string }>;
  const additions: Array<[string, string]> = [
    ['font_family', 'font_family TEXT'],
    ['custom_font_family', 'custom_font_family TEXT'],
    ['font_scale', 'font_scale REAL'],
    ['line_spacing', 'line_spacing REAL'],
  ];
  for (const [name, ddl] of additions) {
    if (!cols.some(c => c.name === name)) {
      db.prepare(`ALTER TABLE settings ADD COLUMN ${ddl}`).run();
    }
  }
}

function repairUnparentedResumeMessages(db: Database.Database): void {
  // Approval-resume continuations used to be persisted with a NULL
  // parent_message_id. The branch tree treats NULL-parent rows as root-level
  // siblings (legitimate for regenerations of a chat's first message), so a
  // branch swipe in an affected chat archived the "losing roots" — i.e. the
  // entire early conversation. Two-step repair:
  //   1. Chain each marked resume row onto the message immediately before it
  //      (by timestamp) in its channel — that is the turn it continued.
  //   2. Re-activate every ancestor of an active row, restoring history that
  //      the root-group archive cut. Legitimately-abandoned variant branches
  //      are not ancestors of active rows and stay archived.
  const orphans = db.prepare(`
    SELECT id, channel_id, timestamp FROM messages
    WHERE parent_message_id IS NULL
      AND json_extract(metadata, '$.resumedFromApproval') IS NOT NULL
  `).all() as Array<{ id: string; channel_id: string; timestamp: number }>;

  const findPrev = db.prepare(`
    SELECT id FROM messages
    WHERE channel_id = ? AND timestamp < ? AND id != ?
    ORDER BY timestamp DESC LIMIT 1
  `);
  const setParent = db.prepare(
    `UPDATE messages SET parent_message_id = ?, branch_index = 0 WHERE id = ?`
  );

  const touchedChannels = new Set<string>();
  for (const orphan of orphans) {
    const prev = findPrev.get(orphan.channel_id, orphan.timestamp, orphan.id) as { id: string } | undefined;
    if (!prev) continue; // first message in its channel — a real root, leave it
    setParent.run(prev.id, orphan.id);
    touchedChannels.add(orphan.channel_id);
  }

  const reactivate = db.prepare(`
    WITH RECURSIVE anc(id) AS (
      SELECT parent_message_id FROM messages
      WHERE channel_id = ? AND status = 'active' AND parent_message_id IS NOT NULL
      UNION
      SELECT m.parent_message_id FROM messages m
      JOIN anc ON m.id = anc.id
      WHERE m.parent_message_id IS NOT NULL
    )
    UPDATE messages SET status = 'active'
    WHERE channel_id = ? AND status != 'active' AND id IN (SELECT id FROM anc)
  `);
  for (const channelId of touchedChannels) {
    reactivate.run(channelId, channelId);
  }
}

function addConversationPinsAndFolders(db: Database.Database): void {
  // Pinning reuses the existing channels.pinned boolean (v52 baseline), which
  // covers direct chats too since a chat is a `channels` row. Folders:
  // flat, conversation-only grouping; folder_id is cleared (not cascaded)
  // when a folder is deleted so the conversations survive. The new column
  // replicates through the existing channels sync triggers. Idempotent.
  const cols = db.pragma('table_info(channels)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'folder_id')) {
    db.prepare('ALTER TABLE channels ADD COLUMN folder_id TEXT').run();
  }

  db.prepare(`
    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `).run();

  // Sync triggers — same shape seedSyncIdentityAndTriggers installs for the
  // baseline set. conversation_folders must also be added to SYNCED_TABLES
  // (sync/syncTables.ts); the registry is the superset check.
  const nowMs = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const guard = 'WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0';
  for (const [op, event, key] of [
    ['insert', 'INSERT', 'NEW.id'],
    ['update', 'UPDATE', 'NEW.id'],
    ['delete', 'DELETE', 'OLD.id'],
  ] as const) {
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_sync_conversation_folders_${op}
      AFTER ${event} ON conversation_folders
      ${guard}
      BEGIN
        INSERT INTO sync_changes (table_name, row_id, op, changed_at)
        VALUES ('conversation_folders', ${key}, '${op}', ${nowMs});
      END
    `).run();
  }
}

function addUserAvatarColumn(db: Database.Database): void {
  // Bare filename resolved against userData/avatars by the avatar:// protocol
  // (same convention as agents.avatar). NULL = no avatar, initial-letter
  // fallback renders instead. Idempotent.
  const cols = db.pragma('table_info(settings)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'user_avatar')) {
    db.prepare('ALTER TABLE settings ADD COLUMN user_avatar TEXT').run();
  }
}

function addActivityAudienceColumn(db: Database.Database): void {
  // Curation tier for the activity feed: 'user' = workspace activity worth
  // surfacing (feed + sidebar badge), 'system' = app-lifecycle telemetry
  // (loads, registrations) hidden behind a toggle. Default is 'system' so
  // event types unknown to the audience map fail closed and never leak into
  // the default feed. Backfill mirrors deriveAudience() in
  // ActivityPersistenceService. Idempotent.
  const cols = db.pragma('table_info(activities)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'audience')) {
    db.prepare(`ALTER TABLE activities ADD COLUMN audience TEXT NOT NULL DEFAULT 'system'`).run();
    db.prepare(`
      UPDATE activities SET audience = 'user'
      WHERE (
        type LIKE 'agent:%' OR type LIKE 'project:%' OR type LIKE 'channel:%'
        OR type LIKE 'message:%' OR type LIKE 'task:%' OR type LIKE 'note:%'
        OR type LIKE 'workflow:%' OR type LIKE 'routine:%' OR type LIKE 'approval:%'
        OR type IN ('chat:error', 'plugin:crash', 'plugin:error', 'plugin:resource-violation')
      )
      AND type NOT IN ('project:switched', 'channel:switched')
      AND type NOT LIKE 'workflow:node:%'
      AND type NOT LIKE 'routine:scheduler:%'
    `).run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_activities_audience ON activities(audience)').run();
}

function foldResidualChatMessageAttachments(db: Database.Database): void {
  // chat_message_attachments was retired at the v52 squash: the baseline never
  // creates it, and scripts/migrate-chats-to-channels.ts folds its rows into
  // message_attachments (ids preserved) and drops it. No supported DB should
  // still carry the table — this migration turns that assumption into a
  // schema guarantee for any stray leftover (e.g. a partially transformed
  // beta DB). No-op when the table is absent, which is every healthy DB.
  const stray = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_message_attachments'"
  ).get();
  if (!stray) return;

  logger.warn('[Database] Residual chat_message_attachments table found — folding into message_attachments');

  // Id-space discipline (mirrors the v52 transform's precheck): ids are
  // copied verbatim, so a collision means two different rows claim the same
  // id. Abort loudly — the surrounding transaction rolls back — rather than
  // remap silently.
  const collisions = (db.prepare(`
    SELECT COUNT(*) AS n FROM chat_message_attachments
    WHERE id IN (SELECT id FROM message_attachments)
  `).get() as { n: number }).n;
  if (collisions > 0) {
    throw new Error(
      `Migration v61 aborted: ${collisions} chat_message_attachments row id(s) ` +
      `collide with existing message_attachments ids. Ids are never remapped — ` +
      `resolve the collision manually before restarting.`
    );
  }

  // message_attachments.message_id carries an FK to messages(id). A stray row
  // whose parent message is gone would either fail the copy (FKs on) or land
  // as garbage (FKs off) — fail closed with a clear message instead.
  const orphans = (db.prepare(`
    SELECT COUNT(*) AS n FROM chat_message_attachments
    WHERE message_id NOT IN (SELECT id FROM messages)
  `).get() as { n: number }).n;
  if (orphans > 0) {
    throw new Error(
      `Migration v61 aborted: ${orphans} chat_message_attachments row(s) reference ` +
      `messages that no longer exist. Remove the orphaned rows manually before restarting.`
    );
  }

  // Column-for-column copy — both tables share the attachmentCRUD shape
  // (same 10 columns; verified against the pre-squash schema and the v52
  // transform's identical column list).
  db.prepare(`
    INSERT INTO message_attachments
      (id, message_id, filename, original_path, stored_path,
       mime_type, size, attachment_type, metadata, created_at)
    SELECT id, message_id, filename, original_path, stored_path,
           mime_type, size, attachment_type, metadata, created_at
    FROM chat_message_attachments
  `).run();

  db.prepare('DROP TABLE chat_message_attachments').run();
}

export const legacyMigrations: Migration[] = [
  {
    version: 52,
    description: 'Baseline schema v52 (chats folded into channels; calendar unified; squashed from v37–v51)',
    migrate: createBaselineSchema,
  },
  {
    version: 53,
    description: 'Add openrouter_sticky_provider to settings (sticky-provider pinning toggle)',
    migrate: addOpenRouterStickyProviderColumn,
  },
  {
    version: 54,
    description: 'Add context_summary/summary_through_message_id/summary_updated_at to channels (compaction)',
    migrate: addChannelContextSummaryColumns,
  },
  {
    version: 55,
    description: 'Add compaction_mode to agents (auto | manual | off)',
    migrate: addAgentCompactionModeColumn,
  },
  {
    version: 56,
    description: 'Add font preference columns to settings (font_family, custom_font_family, font_scale, line_spacing)',
    migrate: addFontPreferenceColumns,
  },
  {
    version: 57,
    description: 'Repair unparented approval-resume messages (chain onto prior turn, restore archived ancestors)',
    migrate: repairUnparentedResumeMessages,
  },
  {
    version: 58,
    description: 'Conversation folders (channels.folder_id, conversation_folders table + sync triggers)',
    migrate: addConversationPinsAndFolders,
  },
  {
    version: 59,
    description: 'Add user_avatar to settings (user profile image filename)',
    migrate: addUserAvatarColumn,
  },
  {
    version: 60,
    description: 'Add audience to activities (user-facing vs system telemetry) + backfill',
    migrate: addActivityAudienceColumn,
  },
  {
    version: 61,
    description: 'Fold any residual chat_message_attachments into message_attachments (defense-in-depth; table retired at v52)',
    migrate: foldResidualChatMessageAttachments,
  },
  {
    version: 62,
    description: 'Add plugin_grants (marketplace pre-install permission consent)',
    migrate: addPluginGrantsTable,
  },
  {
    version: 63,
    description: 'Purge accumulated per-token chat:stream activity rows (no longer persisted)',
    migrate: pruneStreamActivityRows,
  },
  {
    version: 64,
    description: 'Add memory_entries (core default memory-backend store) + FTS5 index',
    migrate: addMemoryEntriesTable,
  },
  {
    version: 65,
    description: 'Add memory_blocks (agent core-memory blocks)',
    migrate: addMemoryBlocksTable,
  },
  {
    version: 66,
    description: 'Add settings.memory_embedding (semantic search config)',
    migrate: (db) => {
      const cols = db.pragma('table_info(settings)') as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'memory_embedding')) {
        db.exec(`ALTER TABLE settings ADD COLUMN memory_embedding TEXT`);
      }
    },
  },
  {
    version: 67,
    description: 'Add memory_vec_meta (tracks the embedder bound to the vector index)',
    // The vec0 table itself is created at runtime (its dimensions depend on the
    // active embedder); this just records which embedder + dims it was built for
    // so a config change triggers a rebuild.
    migrate: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_vec_meta (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT, dims INTEGER)`);
    },
  },
  {
    version: 68,
    description: 'Add routines.last_status/last_error/consecutive_failures (run outcome)',
    // Outcome was only ever an event: the scheduler emitted
    // routine:execution:completed even when the workflow inside it failed, so
    // nothing durable recorded that a routine had been failing for weeks.
    // Backfilled as NULL — unknown until each routine next runs.
    migrate: (db) => {
      const cols = db.pragma('table_info(routines)') as Array<{ name: string }>;
      const has = (name: string) => cols.some(c => c.name === name);
      if (!has('last_status')) {
        db.exec(`ALTER TABLE routines ADD COLUMN last_status TEXT CHECK(last_status IN ('success','failure'))`);
      }
      if (!has('last_error')) {
        db.exec(`ALTER TABLE routines ADD COLUMN last_error TEXT`);
      }
      if (!has('consecutive_failures')) {
        db.exec(`ALTER TABLE routines ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 69,
    description: 'Add settings.routines_paused (global scheduler pause)',
    // Persisted rather than in-memory so a restart cannot silently resume every
    // routine while the user still believes the scheduler is paused.
    migrate: (db) => {
      const cols = db.pragma('table_info(settings)') as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'routines_paused')) {
        db.exec(`ALTER TABLE settings ADD COLUMN routines_paused INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 70,
    description: 'Add workflows.pinned and routines.pinned (sidebar pinning)',
    migrate: (db) => {
      for (const table of ['workflows', 'routines']) {
        const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        if (!cols.some(c => c.name === 'pinned')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
        }
      }
    },
  },
  {
    version: 71,
    description: "Add channels type 'work' + task_id/parent_channel_id (work sessions)",
    requiresForeignKeysOff: true,
    migrate: addWorkSessionColumns,
  },
  {
    version: 72,
    description: 'Add tool_approval_grants (per-conversation approval waivers)',
    migrate: (db) => {
      // A grant suppresses the approval PROMPT for one tool, in one
      // conversation, for one agent. Deliberately not a global setting: an
      // approval is valuable because it is attached to a situation, and a
      // standing permission that outlives its context is how an agent ends up
      // editing files nobody asked about.
      //
      // Bounded by the conversation through ON DELETE CASCADE — delete the
      // conversation and its waivers go with it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_approval_grants (
          id TEXT PRIMARY KEY,
          container_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          granted_at INTEGER NOT NULL,
          granted_by TEXT,
          UNIQUE(container_id, agent_id, tool_name),
          FOREIGN KEY (container_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tool_grants_lookup
          ON tool_approval_grants(container_id, agent_id);
      `);
    },
  },
  {
    version: 73,
    description: 'Add activities.agent_id (attribute activity to the agent that caused it)',
    migrate: addActivityAgentColumn,
  },
  {
    version: 74,
    description: 'Add messages_fts (transcript search for agents)',
    migrate: addMessageSearchIndex,
  },
];

/**
 * FTS5 index over message text, so an agent can search the conversations it
 * took part in. Mirrors memory_fts: external-content (content='messages',
 * content_rowid='rowid') so the index is a pure shadow of the base table
 * rather than a second copy of every transcript.
 *
 * Only `content` is indexed. tool_calls / content_blocks / metrics are JSON
 * envelopes — indexing them would make every search match on schema keys.
 *
 * Note what these triggers deliberately do NOT carry: the
 * `WHEN (SELECT applying FROM sync_meta ...) = 0` guard that the sync
 * change-capture triggers use. That guard exists to stop replicated writes
 * re-entering the oplog and echoing back to the peer. This index is the
 * opposite case — it is local, derived, and never synced (`messages_fts` is
 * absent from SYNCED_TABLES on purpose, since each device builds its own).
 * A message that arrived by replication must be as searchable as one typed
 * here, so these fire on every write.
 */
function addMessageSearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content='messages', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  // Backfill transcripts that predate the index. 'rebuild' reads straight from
  // the content table, so it is correct whether this runs on a fresh DB or one
  // with years of history.
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
}

/**
 * Which agent caused this activity, where one genuinely did.
 *
 * Deliberately nullable, and left null far more often than you might expect.
 * An agent is the actor for chat turns, tool calls and agent-authored
 * messages, but plenty of real activity has no single agent behind it:
 * routines own a schedule rather than an agent, a workflow run spans however
 * many agent nodes it contains (zero included), and a workflow code node is
 * nobody's turn. Writing a "primary" agent onto those rows would be inventing
 * an attribution the system does not have.
 *
 * No backfill. The agent identity for historical rows is inside the `data`
 * JSON under a key that varies by event type, and a LIKE-based sweep over a
 * table that reached 49k rows in one beta DB would be guessing at scale. New
 * rows are attributed on write (see deriveAgentId in
 * ActivityPersistenceService); old rows stay null and simply don't appear in
 * agent-filtered views. Idempotent.
 */
function addActivityAgentColumn(db: Database.Database): void {
  const cols = db.pragma('table_info(activities)') as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'agent_id')) {
    db.prepare('ALTER TABLE activities ADD COLUMN agent_id TEXT').run();
  }
  // Partial index: the column is null for most rows, and every query that
  // uses it is asking for a specific agent.
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id, timestamp DESC) WHERE agent_id IS NOT NULL'
  ).run();
}

/**
 * Widen the channels type CHECK to admit 'work' and add the two columns a work
 * session needs (see docs/architecture/work-sessions.md).
 *
 * A CHECK constraint cannot be altered in place, so this is SQLite's table
 * rebuild: create the new shape, copy every row, drop the old, rename. The
 * runner has foreign keys disabled around it — without that, the DROP would
 * cascade through `messages` and `channel_participants` and empty them.
 *
 * The row copy is column-explicit rather than `SELECT *`: a positional copy
 * silently shifts every value one column left the day someone adds a column
 * above the list, and the failure would look like corrupted conversations
 * rather than a bad migration.
 */
function addWorkSessionColumns(db: Database.Database): void {
  const existing = (db.pragma('table_info(channels)') as Array<{ name: string }>).map(c => c.name);
  if (existing.includes('task_id')) return; // already rebuilt

  // Every column carried across, named explicitly. A positional `SELECT *`
  // copy would shift values one column left the day a column is added above
  // the list, and that reads as corrupted conversations rather than a bad
  // migration.
  const carried = [
    'id', 'name', 'type', 'project_id', 'pinned', 'agent_id', 'archived_at',
    'last_message_at', 'tags', 'user_persona', 'context_summary',
    'summary_through_message_id', 'summary_updated_at', 'folder_id', 'created_at',
  ];

  // Refuse to run rather than drop a column this list has not been taught
  // about — silent column loss is the failure mode worth being paranoid about,
  // and `context_summary` and friends were nearly lost exactly this way.
  const unknown = existing.filter(c => !carried.includes(c));
  if (unknown.length > 0) {
    throw new Error(
      `channels rebuild would drop unmigrated column(s): ${unknown.join(', ')}. ` +
      `Add them to the carried list and to channels_new before rebuilding.`,
    );
  }
  const copied = carried.filter(c => existing.includes(c)).join(', ');

  const before = (db.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;

  // DROP TABLE takes every trigger on the table with it, permanently. The sync
  // oplog rides on these, so losing them would stop channel changes
  // propagating to paired devices — with nothing failing loudly. Capture the
  // definitions as they actually exist and replay them after the rename,
  // rather than re-deriving them here and drifting from the originals.
  const triggers = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'channels' AND sql IS NOT NULL`,
  ).all() as Array<{ sql: string }>).map(r => r.sql);

  db.exec(`
    CREATE TABLE channels_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('public', 'project', 'direct', 'work')),
      project_id TEXT,
      pinned INTEGER DEFAULT 0,
      agent_id TEXT,
      archived_at INTEGER,
      last_message_at INTEGER,
      tags TEXT,
      user_persona TEXT,
      context_summary TEXT,
      summary_through_message_id TEXT,
      summary_updated_at INTEGER,
      folder_id TEXT,
      task_id TEXT,
      parent_channel_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    INSERT INTO channels_new (${copied}) SELECT ${copied} FROM channels;

    DROP TABLE channels;
    ALTER TABLE channels_new RENAME TO channels;

    CREATE INDEX IF NOT EXISTS idx_channels_project_id ON channels(project_id);
    CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
    CREATE INDEX IF NOT EXISTS idx_channels_agent_id ON channels(agent_id);
    CREATE INDEX IF NOT EXISTS idx_channels_archived_at ON channels(archived_at);
    CREATE INDEX IF NOT EXISTS idx_channels_last_message_at ON channels(last_message_at);
    CREATE INDEX IF NOT EXISTS idx_channels_task_id ON channels(task_id);
    CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id);
  `);

  for (const sql of triggers) db.exec(sql);

  const after = (db.prepare('SELECT COUNT(*) AS c FROM channels').get() as { c: number }).c;
  if (after !== before) {
    throw new Error(`channels rebuild lost rows: ${before} before, ${after} after`);
  }
  const restored = (db.prepare(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'channels'`,
  ).get() as { c: number }).c;
  if (restored !== triggers.length) {
    throw new Error(`channels rebuild lost triggers: ${triggers.length} before, ${restored} after`);
  }
  logger.info(
    `[Database] Rebuilt channels table for work sessions (${after} rows, ${restored} triggers restored)`,
  );
}

function addPluginGrantsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_grants (
      plugin_id TEXT PRIMARY KEY,
      permissions TEXT NOT NULL,
      version TEXT,
      consented_at INTEGER NOT NULL
    );
  `);
}

function addMemoryEntriesTable(db: Database.Database): void {
  // The core default `memory-backend` store. Key/value with free-form JSON
  // metadata, matching the MemoryBackendAPI contract; `agent_id` is
  // denormalized from metadata.agentId for indexed per-agent scoping. Distinct
  // from `agent_memories`, which is the shadow proposal/review queue.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      metadata TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entries_agent ON memory_entries(agent_id);

    -- FTS5 external-content index over value+key for ranked search (bm25).
    -- content=memory_entries + content_rowid=rowid keeps the index a pure
    -- shadow of the base table, synced by the triggers below.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      value, key, content='memory_entries', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, value, key) VALUES (new.rowid, new.value, new.key);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_entries_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key);
      INSERT INTO memory_fts(rowid, value, key) VALUES (new.rowid, new.value, new.key);
    END;
  `);
}

function addMemoryBlocksTable(db: Database.Database): void {
  // Agent core-memory blocks — small, always-in-context, agent-editable
  // summaries. Per-agent + labeled,
  // distinct from the agent-agnostic memory_entries archival store.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_blocks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      description TEXT,
      char_limit INTEGER NOT NULL DEFAULT 2000,
      read_only INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, label),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_blocks_agent ON memory_blocks(agent_id, position);
  `);
}

function pruneStreamActivityRows(db: Database.Database): void {
  // chat:stream was persisted once per streamed token (tens of thousands of
  // rows per install, ~91% of the activities table in the field) with no read
  // path. It's now denylisted in ActivityPersistenceService; drop the backlog.
  // VACUUM is intentionally omitted — it can't run inside a migration
  // transaction; the freed pages are reused as the table churns.
  const res = db.prepare(`DELETE FROM activities WHERE type = 'chat:stream'`).run();
  if (res.changes > 0) {
    logger.info(`[Database] Removed ${res.changes} legacy chat:stream activity rows`);
  }
}

