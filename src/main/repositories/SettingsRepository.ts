import Database from 'better-sqlite3';
import { app } from 'electron';
import { Settings, BackgroundSettings, BackgroundType, UpdateMode, FontPreference } from '../types';
import { getDatabase } from '../services/database';
import { encryptAPIKey, decryptAPIKey } from '../services/encryption';
import { logger } from '../services/logger';
import { SettingsRow, CurrentStateRow } from './row-types';
import { PROVIDER_IDS, ProviderId } from '../../shared/providers';

/**
 * Dev-only API-key overrides from the environment. When present, an env var
 * takes precedence over the encrypted stored value for that provider — so a
 * developer can point at a known-good key (e.g. for testing embeddings) without
 * editing the store. Recognizes `EAVES_<PROVIDER>_API_KEY` plus the
 * `EAVES_QA_<PROVIDER>_KEY` alias the QA harness sets. NEVER active in
 * packaged builds — this is strictly a development affordance.
 */
let loggedKeyOverrides = false;
function devEnvKeyOverrides(): Partial<Record<ProviderId, string>> {
  let packaged = false;
  try { packaged = !!app?.isPackaged; } catch { packaged = false; }
  if (packaged) return {};
  const out: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const P = id.toUpperCase();
    const v = process.env[`EAVES_${P}_API_KEY`] ?? process.env[`EAVES_QA_${P}_KEY`];
    if (v && v.trim()) out[id] = v.trim();
  }
  if (!loggedKeyOverrides) {
    loggedKeyOverrides = true;
    const providers = Object.keys(out);
    if (providers.length) logger.warn('Using dev env API-key override(s)', { providers });
  }
  return out;
}

/**
 * API keys live in a single JSON column keyed by provider id. Values are
 * encrypted individually so adding a new provider requires no schema work —
 * just a new registry entry.
 */
function parseApiKeys(raw: string | null | undefined): Settings['apiKeys'] {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const stored = parsed as Record<string, string | null | undefined>;
  const out: Partial<Record<ProviderId, string>> = {};
  for (const id of PROVIDER_IDS) {
    const decrypted = decryptAPIKey(stored[id] ?? null);
    if (decrypted) out[id] = decrypted;
  }
  // Dev-only: env vars win over the stored value (see devEnvKeyOverrides).
  const overrides = devEnvKeyOverrides();
  for (const id of PROVIDER_IDS) {
    if (overrides[id]) out[id] = overrides[id]!;
  }
  return out;
}

function serializeApiKeys(existingRaw: string | null, patch: Partial<Record<ProviderId, string | undefined>>): string {
  // Merge the encrypted patch onto the existing JSON so other providers'
  // encrypted values survive untouched.
  let existing: Record<string, string | null | undefined> = {};
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw) as Record<string, string | null | undefined>; } catch { existing = {}; }
  }
  for (const id of PROVIDER_IDS) {
    if (!(id in patch)) continue;
    const plain = patch[id];
    if (plain === undefined || plain === null || plain === '') {
      // Intentional clear — the user emptied the field.
      delete existing[id];
      continue;
    }
    try {
      const encrypted = encryptAPIKey(plain);
      if (encrypted) existing[id] = encrypted;
      // encrypted being falsy on a non-empty input shouldn't happen, but if
      // it does we preserve the prior value instead of silently clearing.
    } catch (err) {
      // safeStorage unavailable (e.g. headless Linux). Preserve the existing
      // stored value rather than wiping it — a caller elsewhere will still
      // surface the failure up through the IPC error path.
      logger.error('Failed to encrypt API key; preserving previous value', {
        providerId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return JSON.stringify(existing);
}

function parseMemoryEmbedding(raw: string | null | undefined): Settings['memoryEmbedding'] {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && typeof p.provider === 'string') {
      return { enabled: !!p.enabled, provider: p.provider, model: typeof p.model === 'string' ? p.model : '' };
    }
  } catch { /* fall through */ }
  return undefined;
}

export class SettingsRepository {
  private db: Database.Database;

  /**
   * @param db Injected for tests and the seed loader; production callers use
   * the singletons in ./index.ts and get the app database.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Get the current settings. API keys are decrypted on read.
   */
  get(): Settings {
    const row = this.db.prepare(`
      SELECT user_name, user_avatar, api_keys_json,
             theme, light_theme, dark_theme, current_chat_id, default_agent_id, system_agent_id,
             background_type, background_value, background_opacity, background_blur,
             oobe_completed, workflow_review_required, routines_paused, update_mode, openrouter_sticky_provider,
             font_family, custom_font_family, font_scale, line_spacing, memory_embedding
      FROM settings WHERE id = 1
    `).get() as SettingsRow;

    let background: BackgroundSettings | undefined;
    if (row.background_type && row.background_type !== 'none') {
      background = {
        type: row.background_type as BackgroundType,
        value: row.background_value || '',
        opacity: row.background_opacity ?? 0.3,
        blur: row.background_blur ?? 0,
      };
    }

    return {
      userName: row.user_name ?? '',
      userAvatar: row.user_avatar || undefined,
      apiKeys: parseApiKeys(row.api_keys_json),
      theme: row.theme || undefined,
      lightTheme: row.light_theme || 'light',
      darkTheme: row.dark_theme || 'dark',
      currentChatId: row.current_chat_id || undefined,
      defaultAgentId: row.default_agent_id || undefined,
      systemAgentId: row.system_agent_id || undefined,
      background,
      oobeCompleted: !!row.oobe_completed,
      // Default ON for safety if the column is null/missing
      workflowReviewRequired: row.workflow_review_required === null ? true : !!row.workflow_review_required,
      routinesPaused: !!row.routines_paused,
      updateMode: (row.update_mode as UpdateMode) || 'auto',
      // Default ON if the column is null/missing (rows written before the
      // column existed).
      openrouterStickyProvider: row.openrouter_sticky_provider === null ? true : !!row.openrouter_sticky_provider,
      memoryEmbedding: parseMemoryEmbedding(row.memory_embedding),
      // NULL = defaults (rows written before these columns existed, and users
      // who never touched the controls).
      fontFamily: (row.font_family as FontPreference) || 'default',
      customFontFamily: row.custom_font_family || undefined,
      fontScale: row.font_scale ?? 1,
      lineSpacing: row.line_spacing ?? 1,
    };
  }

  update(settings: Partial<Settings>): Settings {
    if (settings.userName !== undefined) {
      this.db.prepare('UPDATE settings SET user_name = ?, updated_at = ? WHERE id = 1')
        .run(settings.userName, Date.now());
      this.syncCurrentUserName(settings.userName);
    }

    if (settings.userAvatar !== undefined) {
      this.db.prepare('UPDATE settings SET user_avatar = ?, updated_at = ? WHERE id = 1')
        .run(settings.userAvatar || null, Date.now());
    }

    if (settings.apiKeys) {
      const existingRow = this.db.prepare('SELECT api_keys_json FROM settings WHERE id = 1')
        .get() as { api_keys_json: string | null } | undefined;
      const merged = serializeApiKeys(existingRow?.api_keys_json ?? null, settings.apiKeys);
      this.db.prepare('UPDATE settings SET api_keys_json = ?, updated_at = ? WHERE id = 1')
        .run(merged, Date.now());
    }

    if (settings.theme !== undefined) {
      this.db.prepare('UPDATE settings SET theme = ?, updated_at = ? WHERE id = 1')
        .run(settings.theme, Date.now());
    }

    if (settings.lightTheme !== undefined) {
      this.db.prepare('UPDATE settings SET light_theme = ?, updated_at = ? WHERE id = 1')
        .run(settings.lightTheme, Date.now());
    }

    if (settings.darkTheme !== undefined) {
      this.db.prepare('UPDATE settings SET dark_theme = ?, updated_at = ? WHERE id = 1')
        .run(settings.darkTheme, Date.now());
    }

    if (settings.background !== undefined) {
      const bg = settings.background;
      this.db.prepare(`
        UPDATE settings SET
          background_type = ?,
          background_value = ?,
          background_opacity = ?,
          background_blur = ?,
          updated_at = ?
        WHERE id = 1
      `).run(
        bg.type,
        bg.value || null,
        bg.opacity,
        bg.blur,
        Date.now()
      );
    }

    if (settings.currentChatId !== undefined) {
      this.db.prepare('UPDATE settings SET current_chat_id = ?, updated_at = ? WHERE id = 1')
        .run(settings.currentChatId, Date.now());
    }

    if (settings.defaultAgentId !== undefined) {
      this.db.prepare('UPDATE settings SET default_agent_id = ?, updated_at = ? WHERE id = 1')
        .run(settings.defaultAgentId || null, Date.now());
    }

    if (settings.systemAgentId !== undefined) {
      this.db.prepare('UPDATE settings SET system_agent_id = ?, updated_at = ? WHERE id = 1')
        .run(settings.systemAgentId || null, Date.now());
    }

    if (settings.oobeCompleted !== undefined) {
      this.db.prepare('UPDATE settings SET oobe_completed = ?, updated_at = ? WHERE id = 1')
        .run(settings.oobeCompleted ? 1 : 0, Date.now());
    }

    if (settings.openrouterStickyProvider !== undefined) {
      this.db.prepare('UPDATE settings SET openrouter_sticky_provider = ?, updated_at = ? WHERE id = 1')
        .run(settings.openrouterStickyProvider ? 1 : 0, Date.now());
    }

    if (settings.memoryEmbedding !== undefined) {
      this.db.prepare('UPDATE settings SET memory_embedding = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(settings.memoryEmbedding), Date.now());
    }

    if (settings.routinesPaused !== undefined) {
      this.db.prepare('UPDATE settings SET routines_paused = ?, updated_at = ? WHERE id = 1')
        .run(settings.routinesPaused ? 1 : 0, Date.now());
    }
    if (settings.workflowReviewRequired !== undefined) {
      this.db.prepare('UPDATE settings SET workflow_review_required = ?, updated_at = ? WHERE id = 1')
        .run(settings.workflowReviewRequired ? 1 : 0, Date.now());
    }

    if (settings.updateMode !== undefined) {
      this.db.prepare('UPDATE settings SET update_mode = ?, updated_at = ? WHERE id = 1')
        .run(settings.updateMode, Date.now());
    }

    if (settings.fontFamily !== undefined) {
      this.db.prepare('UPDATE settings SET font_family = ?, updated_at = ? WHERE id = 1')
        .run(settings.fontFamily === 'default' ? null : settings.fontFamily, Date.now());
    }

    if (settings.customFontFamily !== undefined) {
      this.db.prepare('UPDATE settings SET custom_font_family = ?, updated_at = ? WHERE id = 1')
        .run(settings.customFontFamily || null, Date.now());
    }

    if (settings.fontScale !== undefined) {
      this.db.prepare('UPDATE settings SET font_scale = ?, updated_at = ? WHERE id = 1')
        .run(settings.fontScale === 1 ? null : settings.fontScale, Date.now());
    }

    if (settings.lineSpacing !== undefined) {
      this.db.prepare('UPDATE settings SET line_spacing = ?, updated_at = ? WHERE id = 1')
        .run(settings.lineSpacing === 1 ? null : settings.lineSpacing, Date.now());
    }

    return this.get();
  }

  /**
   * Propagate the settings display name onto the current user's identity
   * everywhere it's snapshotted: the users row, channel_participants, and
   * messages.
   *
   * Match on the current user's row id, which is a generated `user-<ts>` (see
   * the database seed) and NOT the literal string 'user'. Filtering on the
   * literal matches zero rows, which fails silently: the system prompt picks
   * up settings.userName while every stored attribution keeps the seeded name.
   */
  private syncCurrentUserName(name: string): void {
    const current = this.db
      .prepare('SELECT id FROM users WHERE is_current = 1')
      .get() as { id: string } | undefined;
    if (!current) return;
    const id = current.id;

    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);

    // A direct (1:1) chat is a `channels` row, so channel_participants and
    // messages cover both the group and 1:1 cases — there is no separate
    // chat-side table to update.
    this.db
      .prepare(`UPDATE channel_participants SET display_name = ? WHERE participant_id = ? AND participant_type = 'human'`)
      .run(name, id);

    this.db
      .prepare(`UPDATE messages SET sender_display_name = ? WHERE sender_id = ? AND sender_type = 'human'`)
      .run(name, id);
  }

  /**
   * Self-heal for a users row that drifted from settings.userName (a rename
   * that never reached the users table): re-apply the sync. Idempotent, so
   * it's safe to call on every launch. Guarded to single-user setups so a
   * deliberate multi-human config isn't clobbered.
   */
  reconcileCurrentUserName(): void {
    const userCount = this.db
      .prepare('SELECT COUNT(*) as count FROM users')
      .get() as { count: number };
    if (userCount.count !== 1) return;

    const current = this.db
      .prepare('SELECT name FROM users WHERE is_current = 1')
      .get() as { name: string } | undefined;
    const settingsRow = this.db
      .prepare('SELECT user_name FROM settings WHERE id = 1')
      .get() as { user_name: string | null } | undefined;
    const desired = settingsRow?.user_name ?? '';

    if (current && desired && current.name !== desired) {
      this.syncCurrentUserName(desired);
    }
  }

  // Current state operations

  getCurrentState(): { projectId: string | null; agentId: string | null; channelId: string | null; chatId: string | null } {
    const row = this.db.prepare(`
      SELECT current_project_id, current_agent_id, current_channel_id, current_chat_id
      FROM settings WHERE id = 1
    `).get() as CurrentStateRow;

    return {
      projectId: row.current_project_id,
      agentId: row.current_agent_id,
      channelId: row.current_channel_id,
      chatId: row.current_chat_id,
    };
  }

  setCurrentProject(projectId: string | null): void {
    this.db.prepare('UPDATE settings SET current_project_id = ?, updated_at = ? WHERE id = 1')
      .run(projectId, Date.now());
  }

  setCurrentAgent(agentId: string | null): void {
    this.db.prepare('UPDATE settings SET current_agent_id = ?, updated_at = ? WHERE id = 1')
      .run(agentId, Date.now());
  }

  setCurrentChannel(channelId: string | null): void {
    this.db.prepare('UPDATE settings SET current_channel_id = ?, updated_at = ? WHERE id = 1')
      .run(channelId, Date.now());
  }

  setCurrentChat(chatId: string | null): void {
    this.db.prepare('UPDATE settings SET current_chat_id = ?, updated_at = ? WHERE id = 1')
      .run(chatId, Date.now());
  }
}
