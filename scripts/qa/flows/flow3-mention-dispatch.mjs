#!/usr/bin/env node
/**
 * Flow 3 — @mention dispatch: a human mention starts exactly one agent turn.
 *
 * Contract characterized:
 *  - a human channel message containing '@AgentName' triggers a server-side
 *    ChannelDispatcher turn for that participant;
 *  - the dispatcher's persisted message (real reply when the provider is
 *    reachable, `[Error: …]` dispatch notice when not) carries
 *    metadata.dispatchedBy:'channel-dispatcher' and
 *    parentDispatchMessageId = the triggering human message id;
 *  - the dispatcher's own message does not re-trigger dispatch: a broadcast
 *    turn chains no dispatch intent and storage events never start a turn, so
 *    the reply is structurally terminal whatever it mentions. A self-mention is
 *    additionally skipped by the agentId === senderId check in requestDispatch.
 *    (metadata.dispatchedBy is observability only — no guard reads it.)
 */

import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, createChannel, addParticipant, channelMessages, isDispatcherMsg,
  sleep, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow3-mention-dispatch');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama — expecting persisted dispatch-error notice');
const { cdp } = await openHarness();

try {
  await ensureProject(cdp);
  const sfx = uid();
  const agent = await createAgent(cdp, {
    name: `QAMention${sfx}`,
    model: model ?? FALLBACK_MODEL,
    systemPrompt: 'When addressed, reply with the single word: pong. Do not @mention anyone.',
  });

  const channel = await createChannel(cdp, `qa-flow3-${sfx}`);
  await addParticipant(cdp, channel.id, agent.id);

  const human = await rpc(cdp, async (a) => window.electron.sendMessage({ channelId: a.channelId, content: a.content }), {
    channelId: channel.id,
    content: `@${agent.name} please reply`,
  });
  report.assert('human @mention message persisted', human?.success === true && !!human.message?.id, JSON.stringify(human)?.slice(0, 300));

  const dispatched = await pollUntil(
    () => channelMessages(cdp, channel.id),
    m => m.some(x => x.senderId === agent.id && isDispatcherMsg(x)),
    { timeout: 45000 },
  );
  const reply = dispatched.value.find(x => x.senderId === agent.id && isDispatcherMsg(x));
  report.assert('@mention produced a server-side dispatcher message', dispatched.ok, 'no dispatcher message within 45s');
  report.assert('dispatcher message tagged dispatchedBy:channel-dispatcher', isDispatcherMsg(reply), JSON.stringify(reply?.metadata));
  report.assert('parentDispatchMessageId = triggering human message id', reply?.metadata?.parentDispatchMessageId === human.message.id, JSON.stringify(reply?.metadata));
  report.assert('dispatcher message senderType is agent', reply?.senderType === 'agent', reply?.senderType);

  if (model) {
    report.assert('dispatch produced a real reply (not an error notice)', !!reply && !String(reply.content).startsWith('[Error:'), String(reply?.content).slice(0, 120));
  } else {
    report.skip('live LLM reply content', 'no local ollama at :11434');
    report.assert('failed dispatch persists an [Error: …] notice in-channel (contract)', !!reply && String(reply.content).startsWith('[Error:'), String(reply?.content).slice(0, 120));
  }

  // The dispatcher's own message must not fan out again.
  await sleep(4000);
  const msgs = await channelMessages(cdp, channel.id);
  const dispatcherMsgs = msgs.filter(m => m.senderId === agent.id && isDispatcherMsg(m));
  report.assert('no re-dispatch from the dispatcher message (loop guard)', dispatcherMsgs.length === 1, `count=${dispatcherMsgs.length}`);
} finally {
  cdp.close();
}
report.finish();
