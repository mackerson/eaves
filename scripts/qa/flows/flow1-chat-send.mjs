#!/usr/bin/env node
/**
 * Flow 1 — 1:1 chat send: the direct-channel persistence + event contract.
 *
 * Contract characterized:
 *  - send-chat-message persists the human turn (ChannelRepository.createMessage,
 *    context:'chat') and the message:created event reaches side services
 *    (activity pipeline).
 *  - chat-with-agent (ChatService) persists the assistant turn server-side —
 *    a real reply when the provider is reachable, an `[Error: …]` assistant
 *    message when it is not (both are the contract).
 *  - context:'chat' events never trigger ChannelDispatcher.
 */

import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, chatMessages, sleep, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow1-chat-send');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama — exercising error-persistence contract');
const { cdp } = await openHarness();

try {
  await ensureProject(cdp);
  const sfx = uid();
  const agent = await createAgent(cdp, {
    name: `QAChat${sfx}`,
    model: model ?? FALLBACK_MODEL,
    systemPrompt: 'You are a QA agent. Answer in one short sentence.',
  });

  const chatRes = await rpc(cdp, async (a) => window.electron.createChat({ name: 'qa-flow1-' + a.sfx, agentId: a.agentId }), { agentId: agent.id, sfx });
  report.assert('create-chat returns success envelope with chat', chatRes?.success === true && !!chatRes.chat?.id, JSON.stringify(chatRes)?.slice(0, 300));
  const chatId = chatRes.chat.id;
  const ptypes = (chatRes.chat.participants || []).map(p => p.type).sort();
  report.assert('chat participants are human + agent', ptypes.join(',') === 'agent,human', ptypes.join(','));

  const before = Date.now();
  const sendRes = await rpc(cdp, async (a) => window.electron.sendChatMessage({ chatId: a.chatId, content: 'Reply with the single word: pong' }), { chatId });
  report.assert('send-chat-message persists human message', sendRes?.success === true && sendRes.message?.senderType === 'human', JSON.stringify(sendRes)?.slice(0, 300));

  const msgs1 = await chatMessages(cdp, chatId);
  report.assert('human turn readable via get-chat', msgs1.length === 1 && msgs1[0].senderType === 'human', `count=${msgs1.length}`);

  const activity = await pollUntil(
    () => rpc(cdp, async (a) => window.electron.getActivityRecentCount(a.since), { since: before - 1 }),
    r => r?.success === true && (r.count ?? 0) > 0,
    { timeout: 10000 },
  );
  report.assert('message:created reached the activity pipeline (EventBus side services)', activity.ok, JSON.stringify(activity.value));

  const turn = await rpc(cdp, async (a) => window.electron.chatWithAgent({ chatId: a.chatId, agentId: a.agentId }), { chatId, agentId: agent.id });
  const agentTurn = await pollUntil(() => chatMessages(cdp, chatId), m => m.length >= 2, { timeout: 15000 });
  const msgs2 = agentTurn.value;
  const last = msgs2[msgs2.length - 1];
  report.assert('assistant turn persisted server-side by ChatService', agentTurn.ok && last?.senderType === 'agent' && (last.content || '').length > 0, `count=${msgs2.length}`);

  if (model) {
    report.assert('chat-with-agent returns success + response text', turn?.success === true && (turn.response || '').length > 0, JSON.stringify(turn)?.slice(0, 300));
    report.assert('persisted assistant message is a real reply, not an error notice', !!last && !String(last.content).startsWith('[Error:'), String(last?.content).slice(0, 120));
  } else {
    report.skip('live LLM reply assertions', 'no local ollama at :11434');
    report.assert('unreachable provider persists an [Error: …] assistant message (turn leaves a trace)', !!last && String(last.content).startsWith('[Error:'), String(last?.content).slice(0, 120));
    report.assert('chat-with-agent surfaces the failure envelope', turn?.success === false && !!turn.error, JSON.stringify(turn)?.slice(0, 300));
  }

  // context:'chat' events must never reach ChannelDispatcher — nothing else
  // may appear in this conversation after the turn completes.
  await sleep(4000);
  const msgs3 = await chatMessages(cdp, chatId);
  report.assert("context:'chat' events do not trigger channel dispatch", msgs3.length === msgs2.length, `before=${msgs2.length} after=${msgs3.length}`);
} finally {
  cdp.close();
}
report.finish();
