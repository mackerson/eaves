import Database from 'better-sqlite3';
import { logger } from './logger';

type MigrationFn = (db: Database.Database) => void;

interface Migration {
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
 * Baseline schema (v75). Third squash: folds the v52 baseline plus incremental
 * migrations v53–v74 into one truth, taken at the point Enclave went public.
 *
 * Unlike the previous two squashes this one lands no structural change — it is
 * purely a flattening. Every table, column, index and trigger here is what the
 * v52..v74 chain already produced; `__fixtures__/schema-v74.sql` freezes that
 * chain's output and migrations.test.ts asserts this baseline reproduces it
 * object for object. If the two ever drift, that test is the thing that fails.
 *
 * What the flattening deliberately drops is the beta archaeology: a data
 * repair for approval-resume rows written by one bad build, a fold of
 * chat_message_attachments left over from the v52 transform, a purge of
 * per-token activity rows, and the migrate-chats-to-channels escape hatch.
 * None of it can apply to a database created by a public build, and carrying
 * it forward would mean shipping repairs for corruption no user can have.
 *
 * Upgrade path. A database at exactly v74 runs this baseline as a no-op
 * (everything is CREATE ... IF NOT EXISTS) and is stamped to 75. Anything
 * below v74 is rejected — see MIN_SUPPORTED_VERSION. The baseline creates
 * missing *tables*, so it cannot repair a database missing a *column* added
 * between v53 and v74, and quietly running on one would produce exactly the
 * kind of half-migrated state a squash is supposed to prevent.
 *
 * Future schema changes go in as new migrations at version 76+.
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
      updated_at INTEGER NOT NULL,
      -- When on, a conversation prefers the OpenRouter backend that served its
      -- previous turn, so the prompt cache stays warm.
      openrouter_sticky_provider INTEGER NOT NULL DEFAULT 1,
      -- Reading/accessibility preferences. NULL means the default ('default'
      -- family, 1.0 scale and spacing). font_family is 'default' |
      -- 'open-dyslexic' | 'custom'; custom_font_family holds the locally
      -- installed family used when font_family = 'custom'.
      font_family TEXT,
      custom_font_family TEXT,
      font_scale REAL,
      line_spacing REAL,
      -- Bare filename resolved against userData/avatars by the avatar://
      -- protocol, same convention as agents.avatar. NULL renders the
      -- initial-letter fallback.
      user_avatar TEXT,
      -- Semantic memory search config (embedder + dimensions), JSON.
      memory_embedding TEXT
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
      prompt_template TEXT,
      -- 'auto' (NULL is also auto) compacts once history crosses budget, 'off'
      -- falls back to plain windowing, 'manual' compacts only when asked.
      compaction_mode TEXT
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

    -- One table behind two UI surfaces: type='direct' is a 1:1 "chat",
    -- 'public'/'project' are rooms, and 'work' is an agent's own work session
    -- excluded from both lists.
    CREATE TABLE IF NOT EXISTS channels (
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
      -- Compaction: the running summary of turns already folded away.
      -- summary_through_message_id marks the newest message inside it, so
      -- only freshly-aged turns get re-summarized.
      context_summary TEXT,
      summary_through_message_id TEXT,
      summary_updated_at INTEGER,
      -- Cleared rather than cascaded when a folder is deleted, so the
      -- conversations survive losing their folder.
      folder_id TEXT,
      task_id TEXT,
      parent_channel_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
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
      -- Curation tier: 'user' is workspace activity worth surfacing in the feed
      -- and the sidebar badge, 'system' is app-lifecycle telemetry hidden behind
      -- a toggle. Defaults to 'system' so an event type the audience map has
      -- never heard of fails closed instead of leaking into the default feed.
      audience TEXT NOT NULL DEFAULT 'system',
      -- The agent that caused this, where one genuinely did. Null far more
      -- often than you would expect: a routine owns a schedule rather than an
      -- agent, a workflow run spans however many agent nodes it contains, and
      -- a code node is nobody's turn.
      agent_id TEXT,
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

    -- The core default memory-backend store: key/value with free-form JSON
    -- metadata, matching the MemoryBackendAPI contract. agent_id is
    -- denormalized out of metadata.agentId for indexed per-agent scoping.
    -- Distinct from agent_memories, which is the proposal/review queue.
    CREATE TABLE IF NOT EXISTS memory_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      metadata TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Agent core-memory blocks: small, always-in-context, agent-editable
    -- summaries. Per-agent and labeled, unlike the agent-agnostic archival
    -- store above.
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

    -- Records which embedder the vector index was built for. The vec0 table
    -- itself is created at runtime, since its dimensions depend on the active
    -- embedder; a change of signature is what triggers a rebuild.
    CREATE TABLE IF NOT EXISTS memory_vec_meta (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT, dims INTEGER);

    -- A grant suppresses the approval PROMPT for one tool, in one conversation,
    -- for one agent. Deliberately not a global setting: an approval is valuable
    -- because it is attached to a situation, and a standing permission that
    -- outlives its context is how an agent ends up editing files nobody asked
    -- about. Bounded by the conversation through ON DELETE CASCADE.
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
    CREATE INDEX IF NOT EXISTS idx_channels_task_id ON channels(task_id);
    CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id);
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
    CREATE INDEX IF NOT EXISTS idx_activities_audience ON activities(audience);
    -- Partial: agent_id is null for most rows, and every query using it is
    -- asking for one specific agent.
    CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id, timestamp DESC) WHERE agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_plugin_storage_plugin_id ON plugin_storage(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_status ON agent_memories(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_agent ON memory_entries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_blocks_agent ON memory_blocks(agent_id, position);
    CREATE INDEX IF NOT EXISTS idx_tool_grants_lookup ON tool_approval_grants(container_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_nudges_agent ON shadow_nudges(agent_id, consumed);
    CREATE INDEX IF NOT EXISTS idx_sync_changes_row ON sync_changes(table_name, row_id);
  `);

  createSearchIndexes(db);
  seedSyncIdentityAndTriggers(db);
}

/**
 * FTS5 external-content indexes over the two things worth searching: memory
 * entries and message transcripts. `content=`/`content_rowid=` keeps each index
 * a pure shadow of its base table rather than a second copy of the data, kept
 * in step by the triggers below.
 *
 * Only message `content` is indexed — tool_calls, content_blocks and metrics
 * are JSON envelopes, and indexing them would make every search match on
 * schema keys.
 *
 * Note what these triggers deliberately do NOT carry: the `applying` guard the
 * sync change-capture triggers use. That guard stops replicated writes
 * re-entering the oplog and echoing back to the peer. These indexes are the
 * opposite case — local, derived, and absent from SYNCED_TABLES on purpose,
 * because each device builds its own. A message that arrived by replication
 * must be as searchable as one typed here, so they fire on every write.
 */
function createSearchIndexes(db: Database.Database): void {
  db.exec(`
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
    { table: 'conversation_folders', newKey: 'NEW.id', oldKey: 'OLD.id' },
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

export const migrations: Migration[] = [
  {
    version: 75,
    description: 'Baseline schema v75 (squashed from v52-v74 at the public release)',
    migrate: createBaselineSchema,
  },
];

/**
 * The oldest schema the v75 baseline can take over from.
 *
 * 74 is the last version the pre-squash incremental chain produced, and the
 * baseline is `CREATE ... IF NOT EXISTS` throughout: it fills in missing
 * tables, never missing columns. Run it on a v72 database and the tables all
 * exist, nothing is created, the version is stamped to 75 — and the columns
 * v73 and v74 added are still absent, which surfaces much later as a query
 * failing against a schema that claims to be current.
 *
 * So anything below 74 is refused at startup instead. The upgrade path for a
 * pre-squash database is the 0.3.13 build, which still carries the incremental
 * chain: run it once to reach 74, then this build takes over.
 */
const MIN_SUPPORTED_VERSION = 74;

export function runMigrations(db: Database.Database, currentVersion: number): void {
  if (currentVersion > 0 && currentVersion < MIN_SUPPORTED_VERSION) {
    throw new Error(
      `Database schema is too old for this build (user_version=${currentVersion}, ` +
      `minimum ${MIN_SUPPORTED_VERSION}). The incremental migrations that reach ` +
      `v${MIN_SUPPORTED_VERSION} were squashed into the v75 baseline. Install Enclave 0.3.13 ` +
      `and open it once to bring the database up to v${MIN_SUPPORTED_VERSION}, then return to ` +
      `this version. A development database can just be deleted and recreated.`
    );
  }

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      logger.info(`[Database] Running migration to version ${migration.version}: ${migration.description}`);
      if (migration.requiresForeignKeysOff) {
        runTableRebuild(db, migration);
      } else {
        withTransaction(db, () => migration.migrate(db));
      }
      db.pragma(`user_version = ${migration.version}`);
      logger.info(`[Database] Migration to version ${migration.version} complete`);
    }
  }
}

/**
 * Run a migration that rebuilds a parent table, following SQLite's documented
 * procedure: disable foreign keys OUTSIDE the transaction (the pragma is
 * ignored inside one), do the work inside it, then verify before re-enabling.
 *
 * The `foreign_key_check` is the part that matters. Enforcement was off while
 * the table was swapped, so a mistake in the copy step — a dropped row, an id
 * that changed — would otherwise surface much later as messages pointing at a
 * conversation that no longer exists. Failing here leaves the rolled-back
 * database intact.
 */
function runTableRebuild(db: Database.Database, migration: Migration): void {
  db.pragma('foreign_keys = OFF');
  try {
    // Measured before and after, because the question is whether the REBUILD
    // broke anything — not whether the database was already imperfect. Orphans
    // predating this migration (rows written before enforcement, or by a path
    // that bypassed it) must not block startup for a problem they did not
    // cause.
    const before = (db.pragma('foreign_key_check') as unknown[]).length;

    withTransaction(db, () => migration.migrate(db));

    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > before) {
      throw new Error(
        `Migration ${migration.version} introduced ${violations.length - before} foreign-key ` +
        `violation(s) (${before} pre-existing): ${JSON.stringify(violations.slice(0, 5))}`,
      );
    }
    if (before > 0) {
      logger.warn(
        `[Database] ${before} pre-existing foreign-key violation(s) around migration ${migration.version} — ` +
        `not caused by it, but worth investigating`,
      );
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
