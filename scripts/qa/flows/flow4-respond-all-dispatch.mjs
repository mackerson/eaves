#!/usr/bin/env node
/**
 * Flow 4 — respondTo:'all' dispatch + storage-only EventBus (ADR-001).
 *
 * Contract characterized:
 *  - an agent participant with channelBehavior.respondTo:'all' is resolved
 *    as a dispatch target for a plain (mention-free) human message;
 *  - repository writes never start a turn: an empty agent draft created via
 *    the deprecated add-agent-message bridge emits message:created and must
 *    NOT trigger dispatch. Dispatch happens only via explicit requestDispatch
 *    intents (ADR-001), so ANY bare repository write — draft or not — is
 *    dispatch-silent.
 *
 * Note: channelBehavior is seeded directly into the profile DB — there is no
 * renderer IPC that writes it (UpdateAgentIPCSchema strips the key; the only
 * writer is the LLM-driven update_my_channel_behavior self-tool).
 */

import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, createChannel, addParticipant, channelMessages, isDispatcherMsg,
  seedChannelBehavior, sleep, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow4-respond-all-dispatch');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama — expecting persisted dispatch-error notice');
const { cdp } = await openHarness();

try {
  await ensureProject(cdp);
  const sfx = uid();
  const agentAll = await createAgent(cdp, {
    name: `QAAll${sfx}`,
    model: model ?? FALLBACK_MODEL,
    systemPrompt: 'Reply with one short sentence. Do not @mention anyone.',
  });
  const agentQuiet = await createAgent(cdp, {
    name: `QAQuiet${sfx}`,
    model: model ?? FALLBACK_MODEL,
  });

  seedChannelBehavior(agentAll.id, { respondTo: 'all', verbosity: 'brief' });
  const seeded = await rpc(cdp, async (a) => {
    const mem = await window.electron.getMemory();
    return (mem.agents || []).find(x => x.id === a.id)?.channelBehavior || null;
  }, { id: agentAll.id });
  report.assert('setup: channelBehavior.respondTo seeded to all', seeded?.respondTo === 'all', JSON.stringify(seeded));

  const channel = await createChannel(cdp, `qa-flow4-${sfx}`);
  await addParticipant(cdp, channel.id, agentAll.id);
  await addParticipant(cdp, channel.id, agentQuiet.id);

  const human = await rpc(cdp, async (a) => window.electron.sendMessage({ channelId: a.channelId, content: 'hello everyone, plain message with no mentions' }), { channelId: channel.id });
  report.assert('human message persisted', human?.success === true && !!human.message?.id, JSON.stringify(human)?.slice(0, 300));

  const dispatched = await pollUntil(
    () => channelMessages(cdp, channel.id),
    m => m.some(x => x.senderId === agentAll.id && isDispatcherMsg(x)),
    { timeout: 45000 },
  );
  const reply = dispatched.value.find(x => x.senderId === agentAll.id && isDispatcherMsg(x));
  report.assert("respondTo:'all' agent dispatched on a mention-free human message", dispatched.ok, 'no dispatcher message within 45s');
  report.assert('dispatch parented to the human message', reply?.metadata?.parentDispatchMessageId === human.message.id, JSON.stringify(reply?.metadata));
  report.assert('mentions-only agent did not respond', !dispatched.value.some(x => x.senderId === agentQuiet.id && isDispatcherMsg(x)));
  if (!model && reply) {
    report.assert('failed dispatch persisted as [Error: …] notice (contract)', String(reply.content).startsWith('[Error:'), String(reply.content).slice(0, 120));
  }

  // ── Storage events never dispatch ────────────────────────────────────
  // Wait out the per-agent+channel cooldown (2s) so nothing but the
  // storage-only-bus contract stands between the draft write and a dispatch.
  await sleep(2500);
  const baseline = (await channelMessages(cdp, channel.id)).length;

  const draftRes = await rpc(cdp, async (a) => window.electron.addAgentMessage({ channelId: a.channelId, agentId: a.agentId, content: '', isDraft: true }), { channelId: channel.id, agentId: agentQuiet.id });
  report.assert('empty agent draft created (message:created with isDraft:true)', draftRes?.success === true && draftRes.message?.isDraft === true, JSON.stringify(draftRes)?.slice(0, 300));
  const draftId = draftRes.message.id;

  await sleep(6000);
  const after = await channelMessages(cdp, channel.id);
  const draftDispatches = after.filter(m => isDispatcherMsg(m) && m.metadata?.parentDispatchMessageId === draftId);
  report.assert('storage-only bus: empty draft creation triggered no dispatch', draftDispatches.length === 0, JSON.stringify(draftDispatches.map(m => ({ id: m.id, sender: m.senderDisplayName }))));
  report.assert('no other messages appeared after the draft', after.length === baseline + 1, `baseline=${baseline} after=${after.length}`);
} finally {
  cdp.close();
}
report.finish();
