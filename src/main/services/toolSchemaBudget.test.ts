import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./EventBus', () => ({ eventBus: { emitEvent: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => `/tmp/enclave-test-${k}`, on: vi.fn(), whenReady: () => Promise.resolve() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
}));

import { asSchema } from 'ai';
import { builtinTools } from './builtinTools';
import { createChannelTools } from './channelTools';
import { createAgentSelfTools } from './agentSelfTools';
import { createCoreMemoryTools } from './coreMemoryTools';
import { createTranscriptTools } from './transcriptTools';
import { createDiscoveryTools } from './discoveryTools';
import { estimateTokens } from './contextBudget';
import { computeActiveToolNames } from '../ipc/chatHelpers';

/**
 * A standing ceiling on what the default toolset costs to put on the wire.
 *
 * Tool schemas are resent on every step of every turn. Measured on a small
 * turn they were ~88% of its input, and they got there by accretion — no single tool looked expensive. This test is
 * the thing that was missing: a number that has to be argued with.
 *
 * If a genuinely useful tool pushes past the ceiling, raise it deliberately and
 * say so in the commit. Do not raise it reflexively — and prefer moving
 * reference material into `TOOL_DOCS` (served on demand by `get_tool_info`)
 * over spending the budget on prose.
 */

/**
 * Total estimated tokens if every registered tool were sent. Guards catalog growth.
 *
 * Raised 7,000 → 8,200 (2026-08-08) for the transcript-recall surface and the
 * file read/write pair. See the wire ceiling below for the reasoning; this one
 * moves with it.
 */
const TOTAL_TOKEN_CEILING = 8_200;

/**
 * What a default cloud agent actually puts on the wire: everything registered
 * minus the deferred tools. This is the number that gets billed on every step
 * of every turn, so it is the one worth defending.
 *
 * Raised 4,800 → 5,600 (2026-08-08), deliberately, for two capabilities that
 * did not exist when it was set:
 *
 *  - Transcript recall (search_conversations 263, read_conversation_at 167,
 *    list_my_conversations 86). summarize_conversation_at is deferred — large
 *    schema, and never the first call in a recall.
 *  - read_file / write_file (139 + 192). An agent previously could not create
 *    or read a file at all without bash, and both of those vanish in
 *    non-interactive runs.
 *
 * That is ~847 tokens, against 155 of headroom. No arrangement of deferral fits
 * six new tools into that: deferring both recall follow-ups saves 253 and still
 * leaves it over, while toolDeferral.ts warns specifically against deferring
 * common read paths, which file access is.
 *
 * Note what this measurement gained at the same time: createTranscriptTools was
 * missing from measureDefaultToolset, so those four tools were already on the
 * wire and uncounted — the ceiling was passing against a number that was no
 * longer true. Anything that reaches the model belongs in the composition below.
 *
 * Raised 5,600 → 5,650 (2026-08-10) for `enclave_guide`, 117 tokens against 96
 * of headroom. It is already built the way this comment asks: the guide content
 * lives off the wire in enclaveGuide.ts and is fetched only when called, so the
 * 117 is a one-line description and a single optional string — there is no
 * prose left to move. Deferral was the alternative and it does not work here:
 * the tool exists so an agent stops inventing answers about Enclave, and a
 * deferred tool is only reachable by a model that already suspected it should
 * look something up — which a confidently wrong answer means it did not. The
 * other candidates for deferral are all common paths (execute_code 334, bash
 * 184, grep 171, write_file 192), which toolDeferral.ts warns against.
 */
const WIRE_TOKEN_CEILING = 5_650;

/** No single tool should dominate; the worst offender historically was ~1,036. */
const PER_TOOL_TOKEN_CEILING = 700;

function measureDefaultToolset() {
  const all: Record<string, unknown> = {
    ...builtinTools,
    ...createChannelTools('agent-1'),
    ...createAgentSelfTools('agent-1'),
    ...createCoreMemoryTools('agent-1'),
    ...createTranscriptTools('agent-1'),
  };
  // `complete_work_session` is only assembled inside a work-session channel,
  // so it is not part of the default composition.
  delete all.complete_work_session;
  Object.assign(all, createDiscoveryTools(all, { enabledTools: new Set() }, new Map()));

  const measured = Object.entries(all).map(([name, def]) => {
    const schema = (def as any).inputSchema ?? (def as any).parameters;
    const jsonSchema = schema ? (asSchema(schema) as any).jsonSchema : {};
    // The Anthropic wire shape, which is what actually gets billed.
    const wire = JSON.stringify({
      name,
      description: (def as any).description ?? '',
      input_schema: jsonSchema,
    });
    return { name, tokens: estimateTokens(wire) };
  });

  return { measured, all };
}

describe('tool schema budget', () => {
  it('keeps the registered catalog under its total ceiling', () => {
    const { measured } = measureDefaultToolset();
    const total = measured.reduce((sum, t) => sum + t.tokens, 0);
    const worst = [...measured].sort((a, b) => b.tokens - a.tokens).slice(0, 5);

    expect(
      total,
      `registered catalog is ${total} est. tokens across ${measured.length} tools (ceiling ${TOTAL_TOKEN_CEILING}). ` +
        `Largest: ${worst.map(t => `${t.name}=${t.tokens}`).join(', ')}`
    ).toBeLessThanOrEqual(TOTAL_TOKEN_CEILING);
  });

  it('keeps what a default cloud agent actually sends under its ceiling', () => {
    const { measured, all } = measureDefaultToolset();
    const byName = new Map(measured.map(t => [t.name, t.tokens]));
    // A fresh context: nothing explicitly enabled, so this is the floor an
    // ordinary turn pays.
    const active = computeActiveToolNames(all, new Set(), 'all');
    const spend = active.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0);

    expect(
      spend,
      `a default cloud turn sends ${active.length}/${measured.length} tools = ${spend} est. tokens ` +
        `(ceiling ${WIRE_TOKEN_CEILING}). Defer a large, rarely-called tool rather than raising this.`
    ).toBeLessThanOrEqual(WIRE_TOKEN_CEILING);
  });

  it('keeps any single tool under its ceiling', () => {
    for (const { name, tokens } of measureDefaultToolset().measured) {
      expect(tokens, `${name} costs ${tokens} est. tokens on every request`).toBeLessThanOrEqual(
        PER_TOOL_TOKEN_CEILING
      );
    }
  });
});
