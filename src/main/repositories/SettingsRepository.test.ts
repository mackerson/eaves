import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/migrations';

// Create test database first
let testDb: Database.Database;

// Mock the encryption module
vi.mock('../services/encryption', () => ({
  encryptAPIKey: vi.fn((key) => key ? `encrypted_${key}` : null),
  decryptAPIKey: vi.fn((key) => {
    if (!key) return null;
    if (key.startsWith('encrypted_')) return key.replace('encrypted_', '');
    return key; // Plaintext fallback
  }),
}));

// Logger constructs eagerly via Electron's app API, which isn't available in
// the test environment. Stub it with no-op functions.
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the database service
vi.mock('../services/database', () => ({
  getDatabase: vi.fn(() => testDb),
}));

// SettingsRepository imports `app` (for the dev env-override packaged check).
// Default to dev (isPackaged: false) so the override path is exercisable.
vi.mock('electron', () => ({ app: { isPackaged: false } }));

// Import after mocking
import { SettingsRepository } from './SettingsRepository';
import * as encryption from '../services/encryption';

// channel_participants/messages carry a real FK to channels(id) (better-sqlite3
// enforces foreign_keys by default), so tests referencing a channel id must
// first seed a parent row.
function insertChannel(db: Database.Database, id: string, type: 'public' | 'direct' = 'public'): void {
  db.prepare(`
    INSERT INTO channels (id, name, type, created_at) VALUES (?, ?, ?, ?)
  `).run(id, id, type, Date.now());
}

describe('SettingsRepository', () => {
  let repository: SettingsRepository;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');

    // Run the production migrations rather than hand-rolled DDL so this fixture
    // can't drift from migrations.ts, then seed exactly what production's
    // initializeSchema() seeds (settings row + current user row).
    runMigrations(testDb, 0);

    const now = Date.now();

    testDb.prepare(`
      INSERT INTO settings (id, user_name, created_at, updated_at)
      VALUES (1, 'Test User', ?, ?)
    `).run(now, now);

    // Current user's id is a generated 'user-<ts>', NOT the literal 'user'.
    testDb.prepare(`
      INSERT INTO users (id, name, color, is_current, created_at)
      VALUES ('user-123', 'Test User', '#fff', 1, ?)
    `).run(now);

    repository = new SettingsRepository();
  });

  afterEach(() => {
    testDb.close();
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should return current settings', () => {
      const settings = repository.get();

      expect(settings).toEqual({
        userName: 'Test User',
        apiKeys: {
          anthropic: undefined,
          openai: undefined,
          ollama: undefined,
          lmstudio: undefined,
        },
        theme: 'dark',
        lightTheme: 'light',
        darkTheme: 'dark',
        currentChatId: undefined,
        defaultAgentId: undefined,
        systemAgentId: undefined,
        background: undefined,
        oobeCompleted: false,
        workflowReviewRequired: true,
        routinesPaused: false,
        updateMode: 'auto',
        openrouterStickyProvider: true,
        fontFamily: 'default',
        customFontFamily: undefined,
        fontScale: 1,
        lineSpacing: 1,
      });
    });

    it('should decrypt API keys', () => {
      // Seed the encrypted value into the JSON blob.
      testDb.prepare('UPDATE settings SET api_keys_json = ? WHERE id = 1')
        .run(JSON.stringify({ anthropic: 'encrypted_test_key' }));

      const settings = repository.get();

      expect(encryption.decryptAPIKey).toHaveBeenCalledWith('encrypted_test_key');
      expect(settings.apiKeys.anthropic).toBe('test_key');
    });
  });

  describe('dev env key override', () => {
    const ENV_KEYS = ['ENCLAVE_OPENROUTER_API_KEY', 'ENCLAVE_QA_OPENROUTER_KEY'];
    afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

    it('lets ENCLAVE_<PROVIDER>_API_KEY win over the stored value', () => {
      testDb.prepare('UPDATE settings SET api_keys_json = ? WHERE id = 1')
        .run(JSON.stringify({ openrouter: 'encrypted_stored_key' }));
      process.env.ENCLAVE_OPENROUTER_API_KEY = 'env-key';

      expect(repository.get().apiKeys.openrouter).toBe('env-key');
    });

    it('honors the QA fallback var ENCLAVE_QA_<PROVIDER>_KEY', () => {
      process.env.ENCLAVE_QA_OPENROUTER_KEY = 'qa-key';
      expect(repository.get().apiKeys.openrouter).toBe('qa-key');
    });

    it('falls back to the stored value when no env override is set', () => {
      testDb.prepare('UPDATE settings SET api_keys_json = ? WHERE id = 1')
        .run(JSON.stringify({ openrouter: 'encrypted_stored_key' }));
      expect(repository.get().apiKeys.openrouter).toBe('stored_key');
    });
  });

  describe('update', () => {
    it('should update user name', () => {
      repository.update({ userName: 'New User' });

      const settings = repository.get();
      expect(settings.userName).toBe('New User');
    });

    it('should update the current user record', () => {
      repository.update({ userName: 'Renamed' });

      const user = testDb.prepare(
        "SELECT name FROM users WHERE id = 'user-123'",
      ).get() as { name: string };
      expect(user.name).toBe('Renamed');
    });

    it('should update user name across channel_participants incl. direct/1:1 (keyed by real user id)', () => {
      insertChannel(testDb, 'channel1');
      insertChannel(testDb, 'direct1', 'direct');
      testDb.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, joined_at)
        VALUES ('channel1', 'user-123', 'human', 'Test User', ${Date.now()})
      `).run();
      // A 1:1 chat IS a type='direct' channel — same participant table, so the
      // rename has to reach it too.
      testDb.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, joined_at)
        VALUES ('direct1', 'user-123', 'human', 'Test User', ${Date.now()})
      `).run();

      repository.update({ userName: 'Updated User' });

      const rows = testDb.prepare(
        "SELECT display_name FROM channel_participants WHERE participant_id = 'user-123'",
      ).all() as Array<{ display_name: string }>;

      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.display_name === 'Updated User')).toBe(true);
    });

    it('should update user name across messages incl. direct/1:1 channel messages', () => {
      insertChannel(testDb, 'channel1');
      insertChannel(testDb, 'direct1', 'direct');
      testDb.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, content, timestamp)
        VALUES ('msg1', 'channel1', 'user-123', 'human', 'Test User', 'Hello', ${Date.now()})
      `).run();
      // Chat messages live in the same `messages` table, on a type='direct'
      // channel — one rename query has to cover both surfaces.
      testDb.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, content, timestamp)
        VALUES ('msg2', 'direct1', 'user-123', 'human', 'Test User', 'Hi', ${Date.now()})
      `).run();

      repository.update({ userName: 'Updated User' });

      const rows = testDb.prepare(
        "SELECT sender_display_name FROM messages WHERE sender_id = 'user-123'",
      ).all() as Array<{ sender_display_name: string }>;

      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.sender_display_name === 'Updated User')).toBe(true);
    });

    it('reconcileCurrentUserName syncs a drifted single user to settings.userName', () => {
      // Simulate pre-fix drift: settings say "Robin", the user row still "User".
      testDb.prepare("UPDATE settings SET user_name = 'Robin' WHERE id = 1").run();
      testDb.prepare("UPDATE users SET name = 'User' WHERE id = 'user-123'").run();
      insertChannel(testDb, 'direct1', 'direct');
      testDb.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, content, timestamp)
        VALUES ('msg2', 'direct1', 'user-123', 'human', 'User', 'hey', ${Date.now()})
      `).run();

      repository.reconcileCurrentUserName();

      const user = testDb.prepare("SELECT name FROM users WHERE id = 'user-123'").get() as { name: string };
      const cmsg = testDb.prepare("SELECT sender_display_name FROM messages WHERE id = 'msg2'").get() as { sender_display_name: string };
      expect(user.name).toBe('Robin');
      expect(cmsg.sender_display_name).toBe('Robin');
    });

    it('should encrypt and update API keys', () => {
      repository.update({
        apiKeys: {
          anthropic: 'sk-ant-test123',
          openai: 'sk-openai-test456',
        },
      });

      expect(encryption.encryptAPIKey).toHaveBeenCalledWith('sk-ant-test123');
      expect(encryption.encryptAPIKey).toHaveBeenCalledWith('sk-openai-test456');

      const row = testDb.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
        .get() as { api_keys_json: string };
      const stored = JSON.parse(row.api_keys_json) as Record<string, string>;

      expect(stored.anthropic).toBe('encrypted_sk-ant-test123');
      expect(stored.openai).toBe('encrypted_sk-openai-test456');
    });

    it('should update multiple API keys at once', () => {
      repository.update({
        apiKeys: {
          anthropic: 'key1',
          openai: 'key2',
          ollama: 'http://localhost:11434',
          lmstudio: 'http://localhost:1234/v1',
        },
      });

      const settings = repository.get();
      expect(settings.apiKeys.anthropic).toBe('key1');
      expect(settings.apiKeys.openai).toBe('key2');
      expect(settings.apiKeys.ollama).toBe('http://localhost:11434');
      expect(settings.apiKeys.lmstudio).toBe('http://localhost:1234/v1');
    });

    it('should return updated settings', () => {
      const result = repository.update({ userName: 'Final User' });

      expect(result.userName).toBe('Final User');
    });

    it('round-trips font preferences', () => {
      const result = repository.update({
        fontFamily: 'custom',
        customFontFamily: 'Dyslexie',
        fontScale: 1.2,
        lineSpacing: 1.15,
      });

      expect(result.fontFamily).toBe('custom');
      expect(result.customFontFamily).toBe('Dyslexie');
      expect(result.fontScale).toBe(1.2);
      expect(result.lineSpacing).toBe(1.15);
    });

    it('normalizes default font preferences back to NULL columns', () => {
      repository.update({
        fontFamily: 'open-dyslexic',
        fontScale: 1.3,
        lineSpacing: 1.3,
      });
      const result = repository.update({
        fontFamily: 'default',
        customFontFamily: '',
        fontScale: 1,
        lineSpacing: 1,
      });

      expect(result.fontFamily).toBe('default');
      expect(result.customFontFamily).toBeUndefined();
      expect(result.fontScale).toBe(1);
      expect(result.lineSpacing).toBe(1);

      const row = testDb.prepare(
        'SELECT font_family, custom_font_family, font_scale, line_spacing FROM settings WHERE id = 1'
      ).get() as { font_family: string | null; custom_font_family: string | null; font_scale: number | null; line_spacing: number | null };
      expect(row.font_family).toBeNull();
      expect(row.custom_font_family).toBeNull();
      expect(row.font_scale).toBeNull();
      expect(row.line_spacing).toBeNull();
    });

    it('round-trips the user avatar filename', () => {
      const result = repository.update({ userAvatar: 'abc123.png' });

      expect(result.userAvatar).toBe('abc123.png');
      expect(repository.get().userAvatar).toBe('abc123.png');
    });

    it('clears the user avatar when passed an empty string', () => {
      repository.update({ userAvatar: 'abc123.png' });
      const result = repository.update({ userAvatar: '' });

      expect(result.userAvatar).toBeUndefined();
      const row = testDb.prepare('SELECT user_avatar FROM settings WHERE id = 1')
        .get() as { user_avatar: string | null };
      expect(row.user_avatar).toBeNull();
    });
  });

  describe('getCurrentState', () => {
    it('should return current state', () => {
      const state = repository.getCurrentState();

      expect(state).toEqual({
        projectId: null,
        agentId: null,
        channelId: null,
        chatId: null,
      });
    });

    it('should return populated state', () => {
      testDb.prepare(`
        UPDATE settings
        SET current_project_id = ?, current_agent_id = ?, current_channel_id = ?, current_chat_id = ?
        WHERE id = 1
      `).run('proj1', 'agent1', 'channel1', 'chat1');

      const state = repository.getCurrentState();

      expect(state).toEqual({
        projectId: 'proj1',
        agentId: 'agent1',
        channelId: 'channel1',
        chatId: 'chat1',
      });
    });
  });

  describe('setCurrentProject', () => {
    it('should set current project ID', () => {
      repository.setCurrentProject('project123');

      const state = repository.getCurrentState();
      expect(state.projectId).toBe('project123');
    });

    it('should allow setting to null', () => {
      repository.setCurrentProject('project123');
      repository.setCurrentProject(null);

      const state = repository.getCurrentState();
      expect(state.projectId).toBeNull();
    });
  });

  describe('setCurrentAgent', () => {
    it('should set current agent ID', () => {
      repository.setCurrentAgent('agent456');

      const state = repository.getCurrentState();
      expect(state.agentId).toBe('agent456');
    });

    it('should allow setting to null', () => {
      repository.setCurrentAgent('agent456');
      repository.setCurrentAgent(null);

      const state = repository.getCurrentState();
      expect(state.agentId).toBeNull();
    });
  });

  describe('setCurrentChannel', () => {
    it('should set current channel ID', () => {
      repository.setCurrentChannel('channel789');

      const state = repository.getCurrentState();
      expect(state.channelId).toBe('channel789');
    });

    it('should allow setting to null', () => {
      repository.setCurrentChannel('channel789');
      repository.setCurrentChannel(null);

      const state = repository.getCurrentState();
      expect(state.channelId).toBeNull();
    });
  });

  describe('API key encryption/decryption edge cases', () => {
    it('should handle null API keys gracefully', () => {
      const settings = repository.get();

      expect(settings.apiKeys.anthropic).toBeUndefined();
      expect(settings.apiKeys.openai).toBeUndefined();
      expect(settings.apiKeys.ollama).toBeUndefined();
      expect(settings.apiKeys.lmstudio).toBeUndefined();
    });

    it('clears the stored key when passed an empty string', () => {
      repository.update({ apiKeys: { anthropic: 'test' } });
      repository.update({ apiKeys: { anthropic: '' } });

      const row = testDb.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
        .get() as { api_keys_json: string };
      const stored = JSON.parse(row.api_keys_json) as Record<string, string>;

      expect(stored.anthropic).toBeUndefined();
    });

    it('should decrypt partially encrypted keys', () => {
      testDb.prepare('UPDATE settings SET api_keys_json = ? WHERE id = 1')
        .run(JSON.stringify({ openai: 'sk-proj-abc123' }));

      const settings = repository.get();

      expect(encryption.decryptAPIKey).toHaveBeenCalledWith('sk-proj-abc123');
      expect(settings.apiKeys.openai).toBe('sk-proj-abc123');
    });

    it('should update only specified API keys without affecting others', () => {
      // First, set all API keys
      repository.update({
        apiKeys: {
          anthropic: 'ant-key',
          openai: 'openai-key',
          ollama: 'ollama-key',
          lmstudio: 'lmstudio-key',
        },
      });

      // Now update only one
      repository.update({
        apiKeys: { anthropic: 'new-ant-key' },
      });

      const row = testDb.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
        .get() as { api_keys_json: string };
      const stored = JSON.parse(row.api_keys_json) as Record<string, string>;

      // Anthropic updated; others untouched from the first write.
      expect(stored.anthropic).toBe('encrypted_new-ant-key');
      expect(stored.openai).toBe('encrypted_openai-key');
      expect(stored.ollama).toBe('encrypted_ollama-key');
      expect(stored.lmstudio).toBe('encrypted_lmstudio-key');
    });

    it('clears the stored key when passed null', () => {
      repository.update({ apiKeys: { anthropic: 'test-key' } });

      // Null is a documented clear-sentinel.
      repository.update({ apiKeys: { anthropic: null as unknown as string } });

      const row = testDb.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
        .get() as { api_keys_json: string };
      const stored = JSON.parse(row.api_keys_json) as Record<string, string>;

      expect(stored.anthropic).toBeUndefined();
    });
  });

  describe('user name update edge cases', () => {
    it('should update empty user name', () => {
      repository.update({ userName: '' });

      const settings = repository.get();
      expect(settings.userName).toBe('');
    });

    it('should handle special characters in user name', () => {
      const specialName = "Test User's \"Name\" (123)";
      repository.update({ userName: specialName });

      const settings = repository.get();
      expect(settings.userName).toBe(specialName);
    });

    it('should update user name without affecting other settings', () => {
      // Set API key first
      repository.update({
        apiKeys: {
          anthropic: 'test-key',
        },
      });

      // Update only user name
      repository.update({ userName: 'New Name' });

      const settings = repository.get();
      expect(settings.userName).toBe('New Name');
      expect(settings.apiKeys.anthropic).toBe('test-key');
    });

    it('should handle very long user names', () => {
      const longName = 'A'.repeat(500);
      repository.update({ userName: longName });

      const settings = repository.get();
      expect(settings.userName).toBe(longName);
    });

    it('should update channel participants with multiple matching rows', () => {
      // Multiple participant rows for the same (real) user id across channels.
      insertChannel(testDb, 'channel1');
      insertChannel(testDb, 'channel2');
      testDb.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, joined_at)
        VALUES ('channel1', 'user-123', 'human', 'Old Name', ${Date.now()})
      `).run();
      testDb.prepare(`
        INSERT INTO channel_participants (channel_id, participant_id, participant_type, display_name, joined_at)
        VALUES ('channel2', 'user-123', 'human', 'Old Name', ${Date.now()})
      `).run();

      repository.update({ userName: 'New Name' });

      const participants = testDb.prepare(`
        SELECT display_name FROM channel_participants WHERE participant_id = 'user-123'
      `).all() as { display_name: string }[];

      expect(participants).toHaveLength(2);
      expect(participants.every(p => p.display_name === 'New Name')).toBe(true);
    });

    it('should update multiple messages from same user', () => {
      insertChannel(testDb, 'channel1');
      testDb.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, content, timestamp)
        VALUES ('msg1', 'channel1', 'user-123', 'human', 'Old Name', 'Hello', ${Date.now()})
      `).run();
      testDb.prepare(`
        INSERT INTO messages (id, channel_id, sender_id, sender_type, sender_display_name, content, timestamp)
        VALUES ('msg2', 'channel1', 'user-123', 'human', 'Old Name', 'World', ${Date.now()})
      `).run();

      repository.update({ userName: 'New Name' });

      const messages = testDb.prepare(`
        SELECT sender_display_name FROM messages WHERE sender_id = 'user-123' AND sender_type = 'human'
      `).all() as { sender_display_name: string }[];

      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.sender_display_name === 'New Name')).toBe(
        true
      );
    });
  });

  describe('state management', () => {
    it('should not affect state when updating settings', () => {
      // Set initial state
      repository.setCurrentProject('proj1');
      repository.setCurrentAgent('agent1');
      repository.setCurrentChannel('channel1');

      // Update settings
      repository.update({ userName: 'New User' });

      // State should remain unchanged
      const state = repository.getCurrentState();
      expect(state.projectId).toBe('proj1');
      expect(state.agentId).toBe('agent1');
      expect(state.channelId).toBe('channel1');
    });

    it('should allow independently setting state fields', () => {
      repository.setCurrentProject('proj1');
      const state1 = repository.getCurrentState();
      expect(state1.projectId).toBe('proj1');
      expect(state1.agentId).toBeNull();

      repository.setCurrentAgent('agent1');
      const state2 = repository.getCurrentState();
      expect(state2.projectId).toBe('proj1');
      expect(state2.agentId).toBe('agent1');

      repository.setCurrentChannel('channel1');
      const state3 = repository.getCurrentState();
      expect(state3).toEqual({
        projectId: 'proj1',
        agentId: 'agent1',
        channelId: 'channel1',
        chatId: null,
      });
    });

    it('should handle rapid state changes', () => {
      repository.setCurrentProject('proj1');
      repository.setCurrentProject('proj2');
      repository.setCurrentProject('proj3');

      const state = repository.getCurrentState();
      expect(state.projectId).toBe('proj3');
    });

    it('should clear all state fields independently', () => {
      repository.setCurrentProject('proj1');
      repository.setCurrentAgent('agent1');
      repository.setCurrentChannel('channel1');

      repository.setCurrentProject(null);
      let state = repository.getCurrentState();
      expect(state.projectId).toBeNull();
      expect(state.agentId).toBe('agent1');
      expect(state.channelId).toBe('channel1');

      repository.setCurrentAgent(null);
      state = repository.getCurrentState();
      expect(state.projectId).toBeNull();
      expect(state.agentId).toBeNull();
      expect(state.channelId).toBe('channel1');

      repository.setCurrentChannel(null);
      state = repository.getCurrentState();
      expect(state.projectId).toBeNull();
      expect(state.agentId).toBeNull();
      expect(state.channelId).toBeNull();
    });
  });

  describe('settings retrieval and updates', () => {
    it('should return complete settings object', () => {
      const settings = repository.get();

      expect(settings).toHaveProperty('userName');
      expect(settings).toHaveProperty('apiKeys');
      // apiKeys is a dict keyed by provider id; only populated ids appear.
      expect(typeof settings.apiKeys).toBe('object');
    });

    it('should persist API keys across multiple retrievals', () => {
      repository.update({
        apiKeys: {
          anthropic: 'persistent-key',
        },
      });

      const settings1 = repository.get();
      const settings2 = repository.get();

      expect(settings1.apiKeys.anthropic).toBe('persistent-key');
      expect(settings2.apiKeys.anthropic).toBe('persistent-key');
      expect(settings1.apiKeys.anthropic).toBe(settings2.apiKeys.anthropic);
    });

    it('should allow partial settings updates', () => {
      repository.update({
        apiKeys: {
          anthropic: 'key1',
          openai: 'key2',
        },
      });

      // Partial update
      repository.update({
        userName: 'New User',
      });

      const settings = repository.get();
      expect(settings.userName).toBe('New User');
      expect(settings.apiKeys.anthropic).toBe('key1');
      expect(settings.apiKeys.openai).toBe('key2');
    });

    it('should track updated_at timestamp on changes', () => {
      const beforeUpdate = Date.now();
      repository.update({ userName: 'New User' });
      const afterUpdate = Date.now();

      const row = testDb.prepare(
        'SELECT updated_at FROM settings WHERE id = 1'
      ).get() as { updated_at: number };

      expect(row.updated_at).toBeGreaterThanOrEqual(beforeUpdate);
      expect(row.updated_at).toBeLessThanOrEqual(afterUpdate);
    });

    it('should update timestamp when only API keys are modified', () => {
      const beforeUpdate = Date.now();
      repository.update({
        apiKeys: {
          anthropic: 'new-key',
        },
      });
      const afterUpdate = Date.now();

      const row = testDb.prepare(
        'SELECT updated_at FROM settings WHERE id = 1'
      ).get() as { updated_at: number };

      expect(row.updated_at).toBeGreaterThanOrEqual(beforeUpdate);
      expect(row.updated_at).toBeLessThanOrEqual(afterUpdate);
    });
  });

  describe('encryption integration', () => {
    it('should call encryptAPIKey for each API key being set', () => {
      repository.update({
        apiKeys: {
          anthropic: 'key1',
          openai: 'key2',
          ollama: 'key3',
        },
      });

      expect(encryption.encryptAPIKey).toHaveBeenCalledTimes(3);
      expect(encryption.encryptAPIKey).toHaveBeenCalledWith('key1');
      expect(encryption.encryptAPIKey).toHaveBeenCalledWith('key2');
      expect(encryption.encryptAPIKey).toHaveBeenCalledWith('key3');
    });

    it('should call decryptAPIKey when retrieving settings', () => {
      testDb.prepare('UPDATE settings SET api_keys_json = ? WHERE id = 1')
        .run(JSON.stringify({ anthropic: 'encrypted_key' }));

      repository.get();

      expect(encryption.decryptAPIKey).toHaveBeenCalledWith('encrypted_key');
    });

    it('should handle decryption errors gracefully by returning undefined', () => {
      // The mock returns null for empty keys, which then becomes undefined
      const settings = repository.get();

      expect(settings.apiKeys.anthropic).toBeUndefined();
    });

    it('should not call encryption when undefined API keys are passed', () => {
      repository.update({
        apiKeys: {
          anthropic: 'key1',
          openai: undefined,
        },
      });

      // Should only encrypt anthropic key, not openai
      const calls = (encryption.encryptAPIKey as any).mock.calls;
      expect(calls.some((call: any[]) => call[0] === undefined)).toBe(false);
    });
  });
});
