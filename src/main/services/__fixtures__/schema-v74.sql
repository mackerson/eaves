CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'core',
      data TEXT,
      project_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL, audience TEXT NOT NULL DEFAULT 'system', agent_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

CREATE TABLE agent_memories (
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

CREATE TABLE agents (
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
    , compaction_mode TEXT);

CREATE TABLE bridge_configs (
      platform TEXT PRIMARY KEY,
      config_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      auto_start INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE bridge_sessions (
      platform TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      current_chat_id TEXT,
      current_agent_id TEXT,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (platform, external_user_id)
    );

CREATE TABLE channel_participants (
      channel_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      participant_type TEXT NOT NULL,
      display_name TEXT,
      color TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, participant_id),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

CREATE TABLE "channels" (
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

CREATE TABLE conversation_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

CREATE TABLE events (
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

CREATE TABLE files (
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

CREATE TABLE mcp_servers (
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

CREATE TABLE memory_blocks (
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

CREATE TABLE memory_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      metadata TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE VIRTUAL TABLE memory_fts USING fts5(
      value, key, content='memory_entries', content_rowid='rowid'
    );

CREATE TABLE memory_vec_meta (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT, dims INTEGER);

CREATE TABLE message_attachments (
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

CREATE TABLE messages (
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

CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, content='messages', content_rowid='rowid'
    );

CREATE TABLE note_labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT 'default',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, name)
    );

CREATE TABLE notes (
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

CREATE TABLE plugin_grants (
      plugin_id TEXT PRIMARY KEY,
      permissions TEXT NOT NULL,
      version TEXT,
      consented_at INTEGER NOT NULL
    );

CREATE TABLE plugin_state (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );

CREATE TABLE plugin_storage (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );

CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      files TEXT,
      directory TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE routines (
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

CREATE TABLE settings (
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
    , openrouter_sticky_provider INTEGER NOT NULL DEFAULT 1, font_family TEXT, custom_font_family TEXT, font_scale REAL, line_spacing REAL, user_avatar TEXT, memory_embedding TEXT);

CREATE TABLE shadow_nudges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

CREATE TABLE sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
      changed_at INTEGER NOT NULL
    );

CREATE TABLE sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      cert_pem TEXT,
      key_pem TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      applying INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE sync_peers (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      cert_fingerprint TEXT NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_applied_seq INTEGER NOT NULL DEFAULT 0,
      last_acked_seq INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE sync_row_state (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id)
    );

CREATE TABLE tasks (
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

CREATE TABLE tool_approval_grants (
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

CREATE TABLE tool_session_states (
      context_id TEXT PRIMARY KEY,
      enabled_tools TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

CREATE TABLE workflows (
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

CREATE INDEX idx_activities_agent ON activities(agent_id, timestamp DESC) WHERE agent_id IS NOT NULL;

CREATE INDEX idx_activities_audience ON activities(audience);

CREATE INDEX idx_activities_category ON activities(category);

CREATE INDEX idx_activities_project_id ON activities(project_id);

CREATE INDEX idx_activities_source ON activities(source);

CREATE INDEX idx_activities_timestamp ON activities(timestamp DESC);

CREATE INDEX idx_activities_type ON activities(type);

CREATE INDEX idx_agent_memories_agent_status ON agent_memories(agent_id, status);

CREATE INDEX idx_channel_participants_channel_id ON channel_participants(channel_id);

CREATE INDEX idx_channels_agent_id ON channels(agent_id);

CREATE INDEX idx_channels_archived_at ON channels(archived_at);

CREATE INDEX idx_channels_last_message_at ON channels(last_message_at);

CREATE INDEX idx_channels_parent ON channels(parent_channel_id);

CREATE INDEX idx_channels_project_id ON channels(project_id);

CREATE INDEX idx_channels_task_id ON channels(task_id);

CREATE INDEX idx_channels_type ON channels(type);

CREATE INDEX idx_events_project_id ON events(project_id);

CREATE INDEX idx_events_start_time ON events(start_time);

CREATE INDEX idx_events_type ON events(type);

CREATE INDEX idx_files_path ON files(path);

CREATE INDEX idx_files_project_id ON files(project_id);

CREATE INDEX idx_mcp_servers_agent_id ON mcp_servers(agent_id);

CREATE INDEX idx_memory_blocks_agent ON memory_blocks(agent_id, position);

CREATE INDEX idx_memory_entries_agent ON memory_entries(agent_id);

CREATE INDEX idx_message_attachments_message_id ON message_attachments(message_id);

CREATE INDEX idx_message_attachments_type ON message_attachments(attachment_type);

CREATE INDEX idx_messages_channel_id ON messages(channel_id);

CREATE INDEX idx_messages_parent_message_id ON messages(parent_message_id);

CREATE INDEX idx_messages_status ON messages(status);

CREATE INDEX idx_messages_timestamp ON messages(timestamp);

CREATE INDEX idx_note_labels_project_id ON note_labels(project_id);

CREATE INDEX idx_notes_color ON notes(color);

CREATE INDEX idx_notes_event_id ON notes(event_id);

CREATE INDEX idx_notes_pinned ON notes(pinned);

CREATE INDEX idx_notes_project_id ON notes(project_id);

CREATE INDEX idx_notes_sort_order ON notes(sort_order);

CREATE INDEX idx_notes_updated_at ON notes(updated_at);

CREATE INDEX idx_plugin_storage_plugin_id ON plugin_storage(plugin_id);

CREATE INDEX idx_routines_next_run ON routines(next_run);

CREATE INDEX idx_routines_project_id ON routines(project_id);

CREATE INDEX idx_routines_workflow_id ON routines(workflow_id);

CREATE INDEX idx_shadow_nudges_agent ON shadow_nudges(agent_id, consumed);

CREATE INDEX idx_sync_changes_row ON sync_changes(table_name, row_id);

CREATE INDEX idx_tasks_color ON tasks(color);

CREATE INDEX idx_tasks_completed ON tasks(completed);

CREATE INDEX idx_tasks_due_date ON tasks(due_date);

CREATE INDEX idx_tasks_event_id ON tasks(event_id);

CREATE INDEX idx_tasks_priority ON tasks(priority);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);

CREATE INDEX idx_tasks_sort_order ON tasks(sort_order);

CREATE INDEX idx_tasks_status ON tasks(completed);

CREATE INDEX idx_tool_grants_lookup
          ON tool_approval_grants(container_id, agent_id);

CREATE INDEX idx_users_is_current ON users(is_current);

CREATE INDEX idx_workflows_project_id ON workflows(project_id);

CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key);
    END;

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, value, key) VALUES (new.rowid, new.value, new.key);
    END;

CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, value, key) VALUES ('delete', old.rowid, old.value, old.key);
      INSERT INTO memory_fts(rowid, value, key) VALUES (new.rowid, new.value, new.key);
    END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

CREATE TRIGGER trg_sync_agents_delete
        AFTER DELETE ON agents
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('agents', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_agents_insert
        AFTER INSERT ON agents
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('agents', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_agents_update
        AFTER UPDATE ON agents
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('agents', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channel_participants_delete
        AFTER DELETE ON channel_participants
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channel_participants', OLD.channel_id || '|' || OLD.participant_id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channel_participants_insert
        AFTER INSERT ON channel_participants
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channel_participants', NEW.channel_id || '|' || NEW.participant_id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channel_participants_update
        AFTER UPDATE ON channel_participants
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channel_participants', NEW.channel_id || '|' || NEW.participant_id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channels_delete
        AFTER DELETE ON channels
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channels', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channels_insert
        AFTER INSERT ON channels
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channels', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_channels_update
        AFTER UPDATE ON channels
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('channels', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_conversation_folders_delete
      AFTER DELETE ON conversation_folders
      WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
      BEGIN
        INSERT INTO sync_changes (table_name, row_id, op, changed_at)
        VALUES ('conversation_folders', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
      END;

CREATE TRIGGER trg_sync_conversation_folders_insert
      AFTER INSERT ON conversation_folders
      WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
      BEGIN
        INSERT INTO sync_changes (table_name, row_id, op, changed_at)
        VALUES ('conversation_folders', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
      END;

CREATE TRIGGER trg_sync_conversation_folders_update
      AFTER UPDATE ON conversation_folders
      WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
      BEGIN
        INSERT INTO sync_changes (table_name, row_id, op, changed_at)
        VALUES ('conversation_folders', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
      END;

CREATE TRIGGER trg_sync_messages_delete
        AFTER DELETE ON messages
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('messages', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_messages_insert
        AFTER INSERT ON messages
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('messages', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_messages_update
        AFTER UPDATE ON messages
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('messages', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_notes_delete
        AFTER DELETE ON notes
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('notes', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_notes_insert
        AFTER INSERT ON notes
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('notes', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_notes_update
        AFTER UPDATE ON notes
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('notes', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_projects_delete
        AFTER DELETE ON projects
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('projects', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_projects_insert
        AFTER INSERT ON projects
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('projects', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_projects_update
        AFTER UPDATE ON projects
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('projects', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_tasks_delete
        AFTER DELETE ON tasks
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('tasks', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_tasks_insert
        AFTER INSERT ON tasks
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('tasks', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_tasks_update
        AFTER UPDATE ON tasks
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('tasks', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_users_delete
        AFTER DELETE ON users
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('users', OLD.id, 'delete', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_users_insert
        AFTER INSERT ON users
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('users', NEW.id, 'insert', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;

CREATE TRIGGER trg_sync_users_update
        AFTER UPDATE ON users
        WHEN (SELECT applying FROM sync_meta WHERE id = 1) = 0
        BEGIN
          INSERT INTO sync_changes (table_name, row_id, op, changed_at)
          VALUES ('users', NEW.id, 'update', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END;
