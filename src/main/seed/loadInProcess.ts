import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { runMigrations } from '../services/migrations';
import { AgentRepository } from '../repositories/AgentRepository';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { ChannelRepository } from '../repositories/ChannelRepository';
import { WorkflowRepository } from '../repositories/WorkflowRepository';
import { RoutineRepository } from '../repositories/RoutineRepository';
import { MemoryBlockRepository } from '../repositories/MemoryBlockRepository';
import { UsageEventRepository } from '../repositories/UsageEventRepository';
import { calculateCost } from '../../shared/pricing';
import { estimateTurnEnergy } from '../../shared/energy';
import { datasets, type Dataset, type ScenarioName } from './dataset';

/**
 * Load a seed dataset straight into a database, in process.
 *
 * The sibling loader (`scripts/qa/seed.mjs`) drives a live app over IPC, which
 * is the right thing for demos: it can only produce states the product can
 * genuinely reach. It is useless to a unit test, which cannot afford to launch
 * Electron. This one trades that guarantee for speed — it writes through the
 * repositories, so it still cannot invent a *shape* the app would not, but it
 * skips the IPC validation layer above them.
 *
 * Both read the same dataset, which is the point: a test and a screenshot are
 * looking at the same workspace.
 */

export interface SeededDatabase {
  db: Database.Database;
  /** Ids by dataset key, so tests can address seeded rows without a lookup. */
  ids: {
    agents: Record<string, string>;
    projects: Record<string, string>;
    chats: Record<string, string>;
    channels: Record<string, string>;
    workflows: Record<string, string>;
  };
  close(): void;
}

export interface SeedOptions {
  /**
   * The instant every `at` offset counts back from.
   *
   * Defaults to a fixed date rather than `Date.now()`: a test that seeds
   * relative to the wall clock is a test whose data changes overnight, and
   * date-boundary bugs are exactly the kind that surface at 23:59. The IPC
   * loader deliberately does the opposite — a demo wants "2 hours ago" to
   * stay true.
   */
  now?: number;
  /** Provide an existing database instead of an in-memory one. */
  db?: Database.Database;
}

/** 2026-06-15T12:00:00Z — arbitrary, stable, and far from a month boundary. */
export const FIXED_NOW = 1781524800000;

export function seedDatabase(
  scenario: ScenarioName | Dataset = 'minimal',
  options: SeedOptions = {},
): SeededDatabase {
  const data: Dataset = typeof scenario === 'string' ? datasets[scenario] : scenario;
  const now = options.now ?? FIXED_NOW;
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;

  const db = options.db ?? new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, db.pragma('user_version', { simple: true }) as number);

  const agents = new AgentRepository(db);
  const projects = new ProjectRepository(db);
  const channels = new ChannelRepository(db);
  const workflows = new WorkflowRepository(db);
  const routines = new RoutineRepository(db);
  const memory = new MemoryBlockRepository(db);
  const usage = new UsageEventRepository(db);

  const ids: SeededDatabase['ids'] = {
    agents: {}, projects: {}, chats: {}, channels: {}, workflows: {},
  };

  /**
   * Ledger rows are *derived* from the seeded turns rather than listed
   * separately in the dataset.
   *
   * The alternative — a `usage:` array alongside `chats:` and `channels:` —
   * would be a second, independent account of the same events, free to drift
   * from the conversations it claims to describe. A demo whose cost view
   * disagrees with its own transcripts is worse than one with no cost view.
   *
   * Token counts come from content length, which is crude but has the two
   * properties that matter here: it is deterministic (rule 2 of this file —
   * an unreviewable screenshot is a useless screenshot) and it is
   * monotonic in the thing a reader can see, so the long answer really is
   * the expensive one.
   */
  const recordSeedTurn = (
    agentKey: string,
    containerId: string,
    projectId: string | null,
    kind: string,
    content: string,
    promptChars: number,
    timestamp: number,
  ) => {
    const agent = data.agents.find(a => a.key === agentKey);
    if (!agent) return;

    const inputTokens = Math.max(1, Math.round(promptChars / 4));
    const outputTokens = Math.max(1, Math.round(content.length / 4));
    const cost = calculateCost(agent.provider, agent.model, inputTokens, outputTokens);
    const energy = estimateTurnEnergy(agent.provider, agent.model, inputTokens, outputTokens);

    usage.create({
      timestamp,
      agentId: ids.agents[agentKey],
      agentName: agent.name,
      projectId,
      containerId,
      kind,
      provider: agent.provider,
      model: agent.model,
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costUsd: cost,
      costBasis: cost === null ? 'unknown' : 'estimated',
      energyWh: energy.wh,
      energyLowWh: energy.whLow,
      energyHighWh: energy.whHigh,
      energyBasis: energy.provenance,
      // Plausible rather than invented from nothing: roughly the time it takes
      // to generate this many tokens at a typical streaming rate.
      durationMs: outputTokens * 25,
      usageIsTotal: true,
    });
  };

  // A user row has to exist before anything can be attributed to one; the app
  // creates it at first run, which this stands in for.
  const userId = randomUUID();
  db.prepare(
    'INSERT INTO users (id, name, color, is_current, created_at) VALUES (?, ?, ?, 1, ?)',
  ).run(userId, data.userName, '#2563eb', now);
  db.prepare(`
    INSERT INTO settings (id, user_name, created_at, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET user_name = excluded.user_name
  `).run(data.userName, now, now);

  for (const a of data.agents) {
    const agent = agents.create({
      name: a.name,
      description: a.description,
      provider: a.provider,
      model: a.model,
      color: a.color,
      systemPrompt: a.systemPrompt,
      temperature: 0.7,
      ...(a.greeting ? { greeting: a.greeting } : {}),
    });
    ids.agents[a.key] = agent.id;
  }

  for (const p of data.projects) {
    const project = projects.create({ name: p.name, description: p.description });
    ids.projects[p.key] = project.id;

    for (const t of p.tasks) {
      const task = projects.createTask(project.id, {
        content: t.content,
        priority: t.priority ?? 'medium',
        ...(t.dueInDays !== undefined ? { dueDate: now + t.dueInDays * 86_400_000 } : {}),
      });
      if (t.completed) projects.updateTask(task.id, { completed: true });
    }

    for (const n of p.notes) {
      projects.createNote(project.id, { title: n.title, content: n.content });
    }
  }

  // A 1:1 chat is a channels row with type='direct' — the same substrate as a
  // room, which is why both go through ChannelRepository here.
  for (const c of data.chats) {
    // Chats store tags as a comma-separated string; channels take an array.
    // The dataset stays an array either way and the loader adapts.
    const chat = channels.createDirectChat({
      name: c.name,
      agentId: ids.agents[c.agent],
      ...(c.tags?.length ? { tags: c.tags.join(',') } : {}),
    });
    ids.chats[c.key] = chat.id;

    // Grows as the conversation does, so each turn's input cost reflects the
    // history it actually had to re-send — the effect the view exists to show.
    let promptChars = 0;
    for (const m of c.messages) {
      const isUser = m.from === 'user';
      channels.createDirectMessage({
        chatId: chat.id,
        senderId: isUser ? userId : ids.agents[m.from],
        senderType: isUser ? 'human' : 'agent',
        senderDisplayName: isUser ? data.userName : data.agents.find(a => a.key === m.from)!.name,
        content: m.content,
        timestamp: at(m.at),
      });
      if (!isUser) recordSeedTurn(m.from, chat.id, null, 'chat', m.content, promptChars, at(m.at));
      promptChars += m.content.length;
    }
  }

  for (const ch of data.channels) {
    const channel = channels.create({ name: ch.name, type: 'public' });
    ids.channels[ch.key] = channel.id;

    for (const key of ch.agents) {
      channels.addParticipant(channel.id, {
        id: ids.agents[key],
        type: 'agent',
        displayName: data.agents.find(a => a.key === key)!.name,
        joinedAt: now,
      });
    }

    // No dispatcher exists in process, so unlike the IPC loader the ordering
    // here carries no risk — nothing can respond to a mention.
    let channelPromptChars = 0;
    for (const m of ch.messages) {
      const isUser = m.from === 'user';
      channels.createMessage({
        channelId: channel.id,
        senderId: isUser ? userId : ids.agents[m.from],
        senderType: isUser ? 'human' : 'agent',
        senderDisplayName: isUser ? data.userName : data.agents.find(a => a.key === m.from)!.name,
        content: m.content,
        timestamp: at(m.at),
      });
      if (!isUser) {
        recordSeedTurn(
          m.from, channel.id, ids.projects[ch.project ?? ''] ?? null,
          'channel', m.content, channelPromptChars, at(m.at),
        );
      }
      channelPromptChars += m.content.length;
    }
  }

  for (const w of data.workflows) {
    const nodes = w.nodes.map((type, i) => ({
      id: `n${i}`, type, position: { x: 120 + i * 190, y: 160 }, data: { label: type },
    }));
    const edges = nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`, source: n.id, target: nodes[i + 1].id,
    }));
    const wf = workflows.create({
      projectId: ids.projects[w.project],
      name: w.name,
      description: w.description,
      dagDefinition: { nodes, edges },
      enabled: true,
      reviewStatus: 'approved',
      createdBy: 'user',
    });
    ids.workflows[w.key] = wf.id;
  }

  for (const r of data.routines) {
    routines.create({
      projectId: ids.projects[r.project],
      name: r.name,
      description: r.description,
      cronSchedule: r.cron,
      enabled: true,
      ...(r.workflow ? { workflowId: ids.workflows[r.workflow] } : {}),
    });
  }

  for (const m of data.memories) {
    memory.setValue(ids.agents[m.agent], m.label, m.value);
  }

  return { db, ids, close: () => db.close() };
}
