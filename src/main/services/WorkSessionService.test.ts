import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/enclave-test', isPackaged: true },
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./database', () => ({ getDatabase: vi.fn() }));
vi.mock('../services/database', () => ({ getDatabase: vi.fn() }));

import { runMigrations } from './migrations';
import { getDatabase } from './database';
import {
  startWorkSession,
  getWorkSession,
  listWorkSessionsForTask,
  completeWorkSession,
  reportSessionBlocked,
} from './WorkSessionService';
import { getChannelRepository, getProjectRepository } from '../repositories';

let db: Database.Database;

// The repositories are process-wide singletons that capture the database at
// construction, so a fresh in-memory DB per test would otherwise be written by
// the test and read by nobody — the singleton keeps talking to the first one.
vi.mock('../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories')>();
  const { ChannelRepository } = await import('../repositories/ChannelRepository');
  const { ProjectRepository } = await import('../repositories/ProjectRepository');
  const { AgentRepository } = await import('../repositories/AgentRepository');
  const { UserRepository } = await import('../repositories/UserRepository');
  return {
    ...actual,
    getChannelRepository: () => new ChannelRepository(),
    getProjectRepository: () => new ProjectRepository(),
    getAgentRepository: () => new AgentRepository(),
    getUserRepository: () => new UserRepository(),
  };
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, 0);
  vi.mocked(getDatabase).mockReturnValue(db);

  db.prepare(`INSERT INTO projects (id, name, description, created_at) VALUES ('p-1','P','',1)`).run();
  db.prepare(`INSERT INTO users (id, name, color, created_at) VALUES ('u-1','Miz','#60a5fa',1)`).run();
  db.prepare(`UPDATE users SET is_current = 1 WHERE id = 'u-1'`).run();
  db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, model, provider, color, created_at)
    VALUES ('a-1','Ornith','','a bird','m','lmstudio','#c084fc',1)
  `).run();
  db.prepare(`
    INSERT INTO channels (id, name, type, project_id, created_at) VALUES ('c-1','general','public','p-1',1)
  `).run();
});

const makeTask = (content: string) =>
  getProjectRepository().createTask('p-1', { content }).id;

describe('startWorkSession', () => {
  it('opens a session bound to the task and agent', async () => {
    const taskId = makeTask('Surface inference errors instead of empty messages');
    const result = await startWorkSession({ taskId, agentId: 'a-1' });

    expect(result.success).toBe(true);
    const row = db.prepare('SELECT type, task_id, agent_id, project_id, parent_channel_id FROM channels WHERE id = ?')
      .get(result.session!.id);
    expect(row).toEqual({
      type: 'work', task_id: taskId, agent_id: 'a-1', project_id: 'p-1', parent_channel_id: null,
    });
  });

  it('records where a delegation came from', async () => {
    const taskId = makeTask('Do the thing');
    const result = await startWorkSession({ taskId, agentId: 'a-1', parentChannelId: 'c-1' });

    const row = db.prepare('SELECT parent_channel_id FROM channels WHERE id = ?').get(result.session!.id);
    expect(row).toEqual({ parent_channel_id: 'c-1' });
  });

  // The seed is the whole point of a session: it starts from the task, not
  // from the conversation that produced it. Seeding with channel history would
  // reproduce the context cost sessions exist to avoid.
  it('seeds with the task text and nothing from the channel', async () => {
    db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_type, content, timestamp)
      VALUES ('m-1','c-1','u-1','human','some unrelated channel chatter',1)
    `).run();
    const taskId = makeTask('Fix the flaky test');

    const result = await startWorkSession({ taskId, agentId: 'a-1', parentChannelId: 'c-1' });
    const session = getWorkSession(result.session!.id)!;

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toContain('Fix the flaky test');
    expect(session.messages[0].content).not.toContain('unrelated channel chatter');
    expect(session.messages[0].senderType).toBe('human');
  });

  it('tells the agent it is not being watched', async () => {
    const taskId = makeTask('Something long-running');
    const result = await startWorkSession({ taskId, agentId: 'a-1' });
    const seed = getWorkSession(result.session!.id)!.messages[0].content;

    expect(seed).toContain('work session');
    expect(seed).toMatch(/nobody else is reading/i);
  });

  it('names the session after the task, truncating a long one', async () => {
    const long = 'x'.repeat(120);
    const result = await startWorkSession({ taskId: makeTask(long), agentId: 'a-1' });
    expect(result.session!.name.length).toBeLessThanOrEqual(60);
    expect(result.session!.name.endsWith('…')).toBe(true);
  });

  it('puts both the agent and the user in the session', async () => {
    const result = await startWorkSession({ taskId: makeTask('t'), agentId: 'a-1' });
    const session = getWorkSession(result.session!.id)!;
    expect(session.participants.map(p => p.id).sort()).toEqual(['a-1', 'u-1']);
  });

  it('refuses an unknown task, agent, or parent channel', async () => {
    const taskId = makeTask('t');
    expect((await startWorkSession({ taskId: 'nope', agentId: 'a-1' })).error).toBe('Task not found');
    expect((await startWorkSession({ taskId, agentId: 'nope' })).error).toBe('Agent not found');
    expect((await startWorkSession({ taskId, agentId: 'a-1', parentChannelId: 'nope' })).error)
      .toBe('Parent channel not found');
    expect(db.prepare("SELECT COUNT(*) c FROM channels WHERE type = 'work'").get()).toEqual({ c: 0 });
  });

  // Sessions are containers the turn core must be able to load. If this breaks,
  // an agent cannot take a turn in one at all.
  it('is loadable as a conversation by the turn core', async () => {
    const result = await startWorkSession({ taskId: makeTask('t'), agentId: 'a-1' });
    const loaded = getChannelRepository().getConversationById(result.session!.id);
    expect(loaded?.id).toBe(result.session!.id);
    expect(getChannelRepository().getDirectChatById(result.session!.id)).toBeNull();
  });

  it('lists sessions for a task, newest first', async () => {
    const taskId = makeTask('t');
    const first = await startWorkSession({ taskId, agentId: 'a-1' });
    const second = await startWorkSession({ taskId, agentId: 'a-1' });

    const sessions = listWorkSessionsForTask(taskId);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id)).toContain(first.session!.id);
    expect(sessions.map(s => s.id)).toContain(second.session!.id);
  });

  it('keeps sessions out of the chat list', async () => {
    await startWorkSession({ taskId: makeTask('t'), agentId: 'a-1' });
    expect(getChannelRepository().getDirectChats()).toHaveLength(0);
    expect(getChannelRepository().getAll()).toHaveLength(1); // just #general
  });
});

describe('report-back to the originating channel', () => {
  const parentMessages = () =>
    db.prepare("SELECT content, sender_type, sender_display_name FROM messages WHERE channel_id = 'c-1' ORDER BY timestamp").all() as
      Array<{ content: string; sender_type: string; sender_display_name: string }>;

  it('announces the session in the channel that delegated it', async () => {
    const result = await startWorkSession({
      taskId: makeTask('Audit the tool suite'), agentId: 'a-1', parentChannelId: 'c-1',
    });

    const posts = parentMessages();
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain('Audit the tool suite');
    expect(posts[0].sender_display_name).toBe('Ornith');
  });

  it('says nothing anywhere when the session has no parent', async () => {
    await startWorkSession({ taskId: makeTask('Standalone'), agentId: 'a-1' });
    expect(parentMessages()).toHaveLength(0);
  });

  it('posts the summary on completion', async () => {
    const started = await startWorkSession({
      taskId: makeTask('Fix the thing'), agentId: 'a-1', parentChannelId: 'c-1',
    });

    const result = completeWorkSession(started.session!.id, 'Found two bugs, fixed one, the other needs a decision.', null);

    expect(result.success).toBe(true);
    expect(result.reportedTo).toBe('c-1');
    const posts = parentMessages();
    expect(posts).toHaveLength(2);
    expect(posts[1].content).toContain('Found two bugs');
    expect(posts[1].content).toContain('done');
  });

  it('completes a standalone session without a report, and says so', () => {
    // Started with no parent — the summary has nowhere to go, which is not an error.
    return startWorkSession({ taskId: makeTask('Solo'), agentId: 'a-1' }).then((started) => {
      const result = completeWorkSession(started.session!.id, 'All done.', null);
      expect(result.success).toBe(true);
      expect(result.reportedTo).toBeUndefined();
      expect(parentMessages()).toHaveLength(0);
    });
  });

  // The report that makes isolation safe: a session nobody has open would
  // otherwise sit on a pending approval with no sign of it anywhere.
  it('announces a session blocked on approval, naming the tools', async () => {
    const started = await startWorkSession({
      taskId: makeTask('Edit some files'), agentId: 'a-1', parentChannelId: 'c-1',
    });

    reportSessionBlocked(started.session!.id, ['edit_file', 'edit_file', 'bash'], null);

    const posts = parentMessages();
    expect(posts).toHaveLength(2);
    expect(posts[1].content).toMatch(/waiting on approval/i);
    expect(posts[1].content).toContain('edit_file');
    expect(posts[1].content).toContain('bash');
    // Deduplicated — two edit_file approvals are one mention, not two.
    expect(posts[1].content.match(/edit_file/g)).toHaveLength(1);
  });

  it('refuses to complete a session that does not exist', () => {
    expect(completeWorkSession('work-nope', 'summary', null)).toEqual({
      success: false, error: 'Work session not found',
    });
  });
});
