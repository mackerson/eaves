#!/usr/bin/env node
/**
 * Flow 5 — tool-approval suspend/resume: a needsApproval tool call parks the
 * turn and the approval response resumes it as a new message.
 *
 * Contract characterized (deterministic, always):
 *  - approval:list-pending returns a success envelope with an array;
 *  - approval:respond (the one mutating handler without a Zod schema)
 *    hand-validates and fails closed on an unknown approvalId with no
 *    fallback context.
 *
 * Contract characterized (needs a live LLM that actually calls a
 * needsApproval tool — skipped with a note otherwise):
 *  - a needsApproval tool call suspends the turn: ChatService persists the
 *    assistant message with a pending tool-approval block and registers the
 *    approval (context:'chat');
 *  - approval:respond approve resumes via approvalResume, which bypasses the
 *    orchestrators and persists the continuation as a NEW message tagged
 *    metadata.resumedFromApproval = approvalId;
 *  - the original message's tool-approval block is updated in place and the
 *    registry entry is consumed.
 */

import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, chatMessages, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow5-approval-suspend-resume');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama');
const { cdp } = await openHarness();
const sfx = uid();

try {
  // ── Deterministic plumbing ────────────────────────────────────────────
  const pendingList = await rpc(cdp, async () => window.electron.listPendingApprovals());
  report.assert('approval:list-pending returns success + array', pendingList?.success === true && Array.isArray(pendingList.approvals), JSON.stringify(pendingList)?.slice(0, 300));

  const bogus = await rpc(cdp, async (a) => window.electron.respondToApproval({ approvalId: a.id, approved: false }), { id: `qa-bogus-${sfx}` });
  report.assert('approval:respond fails closed on unknown approvalId without fallback context', bogus?.success === false && /not found/i.test(bogus.error || ''), JSON.stringify(bogus)?.slice(0, 300));

  // ── LLM-driven suspend/resume ─────────────────────────────────────────
  if (!model) {
    report.skip('needsApproval suspend/resume leg', 'no local ollama at :11434 — cannot produce a real tool call');
  } else {
    await ensureProject(cdp);
    const agent = await createAgent(cdp, {
      name: `QAApprove${sfx}`,
      model,
      systemPrompt: 'You are a tool-running agent. When asked to run a shell command, immediately call the bash tool with exactly that command. Never ask questions, never answer in prose.',
    });
    const chatRes = await rpc(cdp, async (a) => window.electron.createChat({ name: 'qa-flow5-' + a.sfx, agentId: a.agentId }), { agentId: agent.id, sfx });
    const chatId = chatRes?.chat?.id;
    report.assert('setup: chat created', !!chatId, JSON.stringify(chatRes)?.slice(0, 200));

    // Tiny local models get their active toolset gated to discovery+enabled —
    // enable bash explicitly so its schema is exposed.
    const toggle = await rpc(cdp, async (a) => window.electron.toggleChatTool(a.chatId, 'bash', true), { chatId });
    report.info(`toggle-chat-tool bash: ${JSON.stringify(toggle)?.slice(0, 120)}`);

    await rpc(cdp, async (a) => window.electron.sendChatMessage({ chatId: a.chatId, content: a.content }), {
      chatId,
      content: `Run the shell command \`echo qa-approval-${sfx}\` using the bash tool.`,
    });
    const turn = await rpc(cdp, async (a) => window.electron.chatWithAgent({ chatId: a.chatId, agentId: a.agentId }), { chatId, agentId: agent.id });
    report.info(`chat-with-agent: ${JSON.stringify({ success: turn?.success, pending: turn?.pendingApprovals?.length })?.slice(0, 200)}`);

    const pending = await pollUntil(
      () => rpc(cdp, async (a) => window.electron.listPendingApprovals({ context: 'chat', contextId: a.chatId }), { chatId }),
      r => r?.success === true && (r.approvals?.length ?? 0) > 0,
      { timeout: 20000 },
    );

    if (!pending.ok) {
      report.skip('needsApproval suspend/resume leg', `model never called the bash tool (LLM nondeterminism, model=${model}) — no pending approval to resume`);
    } else {
      const approval = pending.value.approvals[0];
      report.assert('needsApproval tool call suspended the turn and registered a pending approval', approval?.toolName === 'bash' && !!approval.approvalId, JSON.stringify(approval)?.slice(0, 300));

      const msgsBefore = await chatMessages(cdp, chatId);
      const suspended = msgsBefore.find(m => JSON.stringify(m.contentBlocks || []).includes(approval.approvalId));
      report.assert('pending tool-approval block persisted on the assistant message', !!suspended, `approvalId=${approval.approvalId}`);

      const respond = await rpc(cdp, async (a) => window.electron.respondToApproval({ approvalId: a.id, approved: true }), { id: approval.approvalId });
      report.assert('approval:respond approve succeeds', respond?.success === true, JSON.stringify(respond)?.slice(0, 300));

      const resumed = await pollUntil(
        () => chatMessages(cdp, chatId),
        m => m.some(x => x.metadata?.resumedFromApproval === approval.approvalId),
        { timeout: 45000 },
      );
      const continuation = resumed.value.find(x => x.metadata?.resumedFromApproval === approval.approvalId);
      report.assert('resume persisted the continuation as a NEW message tagged resumedFromApproval', resumed.ok && continuation?.id !== suspended?.id, JSON.stringify(continuation?.metadata));

      const updatedOriginal = resumed.value.find(m => m.id === suspended?.id);
      report.assert('original tool-approval block updated with the decision', JSON.stringify(updatedOriginal?.contentBlocks || []).includes('approved'), JSON.stringify(updatedOriginal?.contentBlocks)?.slice(0, 300));

      const afterList = await rpc(cdp, async (a) => window.electron.listPendingApprovals({ context: 'chat', contextId: a.chatId }), { chatId });
      report.assert('approval consumed from the registry', afterList?.success === true && !(afterList.approvals || []).some(x => x.approvalId === approval.approvalId), JSON.stringify(afterList)?.slice(0, 200));
    }
  }
} finally {
  cdp.close();
}
report.finish();
