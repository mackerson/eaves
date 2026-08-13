#!/usr/bin/env node
/**
 * Flow 2 — channel selected-agent send: the server-side turn. One
 * send-message({channelId, content, agentId}) carries the whole exchange — the
 * renderer neither creates the draft nor accumulates the stream.
 *
 * Contract characterized:
 *  - send-message with agentId persists the human turn stamped
 *    metadata.addressedAgentId and returns immediately; the agent turn runs
 *    server-side (draft → live 'chat-stream' → finalize).
 *  - The reply is created as an empty draft (dispatch-silent: a bare
 *    repository write never starts a turn),
 *    finalized via updateMessageContentBlocks so
 *    message:updated(draftFinalized) fires — @mentions in the reply re-enter
 *    dispatch, parented to the draft id. The reply carries NO dispatchedBy.
 *  - addressedAgentId suppresses respondTo:'all' broadcast for that message
 *    and dedupes the addressed agent (exactly one turn, even if @mentioned);
 *    explicit @mentions of OTHER agents still dispatch.
 *  - An unreachable provider persists a dispatch-error notice (dispatchedBy +
 *    parentDispatchMessageId = the human message) and removes the draft.
 */

import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, createChannel, addParticipant, channelMessages, isDispatcherMsg,
  seedChannelBehavior, sleep, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow2-channel-selected-agent');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama — exercising error contracts');
const { cdp } = await openHarness();

try {
  await ensureProject(cdp);
  const sfx = uid();
  const otherName = `QAOther${sfx}`;
  const agentSel = await createAgent(cdp, { name: `QASel${sfx}`, model: model ?? FALLBACK_MODEL, systemPrompt: 'Answer in one short sentence. Do not @mention anyone.' });
  const agentOther = await createAgent(cdp, { name: otherName, model: model ?? FALLBACK_MODEL, systemPrompt: 'Answer in one short sentence. Do not @mention anyone.' });
  const agentAll = await createAgent(cdp, { name: `QAAll${sfx}`, model: model ?? FALLBACK_MODEL, systemPrompt: 'Answer in one short sentence. Do not @mention anyone.' });

  const channel = await createChannel(cdp, `qa-flow2-${sfx}`);
  await addParticipant(cdp, channel.id, agentSel.id);
  await addParticipant(cdp, channel.id, agentOther.id);
  await addParticipant(cdp, channel.id, agentAll.id);
  seedChannelBehavior(agentAll.id, { respondTo: 'all', verbosity: 'brief' });

  // Collect live 'chat-stream' pushes — the selected-agent turn must stream
  // through the same routing the dispatcher and ChatService use.
  await rpc(cdp, async () => {
    window.__qaStreamEvents = [];
    window.__qaStreamUnsub = window.electron.onChatStream((e) => {
      window.__qaStreamEvents.push(typeof e === 'string' ? e : (e && e.type) || 'unknown');
    });
  });

  // ── Send 1: mention-free addressed send ───────────────────────────────────
  const human = await rpc(cdp, async (a) => window.electron.sendMessage({
    channelId: a.channelId, content: 'flow2 selected-agent send, no mentions here', agentId: a.agentId,
  }), { channelId: channel.id, agentId: agentSel.id });
  report.assert('send-message with agentId persists the human message and returns immediately',
    human?.success === true && human.message?.senderType === 'human', JSON.stringify(human)?.slice(0, 300));
  report.assert('human message is stamped metadata.addressedAgentId',
    human?.message?.metadata?.addressedAgentId === agentSel.id, JSON.stringify(human?.message?.metadata));

  const isSel = (m) => m.senderId === agentSel.id;

  if (model) {
    // Best-effort draft observation — the draft row exists only while the
    // model streams, so a fast turn can finish between polls.
    const draftSeen = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => isSel(x) && (x.isDraft || (!x.isDraft && x.content))),
      { timeout: 45000, interval: 200 },
    );
    if (draftSeen.value.some((x) => isSel(x) && x.isDraft)) {
      report.assert('server creates the agent reply as an empty draft first', true);
    } else if (draftSeen.ok) {
      report.skip('server creates the agent reply as an empty draft first', 'turn finalized between polls (draft is transient)');
    } else {
      report.assert('server creates the agent reply as an empty draft first', false, 'no draft or reply from selected agent within 45s');
    }

    const finalized = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => isSel(x) && !x.isDraft && x.content),
      { timeout: 60000 },
    );
    const reply = finalized.value.find((x) => isSel(x) && !x.isDraft && x.content);
    report.assert('selected-agent reply finalized server-side (is_draft 1→0 with content)', finalized.ok, 'no finalized reply within 60s');
    report.assert('reply carries NO dispatchedBy (renderer-parity shape — reply mentions re-enter dispatch)',
      !!reply && !reply.metadata?.dispatchedBy, JSON.stringify(reply?.metadata));

    const streamed = await rpc(cdp, async () => window.__qaStreamEvents.length);
    report.assert('live chat-stream events reached the renderer during the turn', streamed > 0, `events=${streamed}`);

    // respondTo:'all' still fires on the reply finalize (pre-existing pinned
    // behavior) — wait for it so the suppression check below is meaningful.
    if (reply) {
      await pollUntil(
        () => channelMessages(cdp, channel.id),
        (m) => m.some((x) => x.senderId === agentAll.id),
        { timeout: 60000 },
      );
    }
  } else {
    report.skip('server creates the agent reply as an empty draft first', 'no local ollama at :11434');
    report.skip('live chat-stream events reached the renderer during the turn', 'no local ollama at :11434');

    const errored = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => isSel(x) && String(x.content).startsWith('[Error:')),
      { timeout: 45000 },
    );
    const notice = errored.value.find((x) => isSel(x) && String(x.content).startsWith('[Error:'));
    report.assert('unreachable provider persists a dispatch-error notice in-channel', errored.ok, 'no error notice within 45s');
    report.assert('error notice is terminal (dispatchedBy) and parented to the human message',
      isDispatcherMsg(notice) && notice?.metadata?.parentDispatchMessageId === human.message.id, JSON.stringify(notice?.metadata));
    report.assert('the dangling draft was removed on failure',
      !errored.value.some((x) => isSel(x) && x.isDraft), JSON.stringify(errored.value.filter(isSel).map((x) => ({ id: x.id, isDraft: x.isDraft }))));
  }

  // Let any stray (= contract-violating) dispatches land before counting.
  await sleep(3000);
  let msgs = await channelMessages(cdp, channel.id);
  report.assert('exactly one selected-agent turn for send 1',
    msgs.filter(isSel).length === 1, `count=${msgs.filter(isSel).length}`);
  const allParentedToHuman = msgs.filter((x) => x.senderId === agentAll.id && x.metadata?.parentDispatchMessageId === human.message.id);
  report.assert("respondTo:'all' broadcast suppressed for the addressed human send",
    allParentedToHuman.length === 0, JSON.stringify(allParentedToHuman.map((x) => x.id)));
  if (!model) {
    report.assert("respondTo:'all' agent produced no turn at all (no reply to re-enter on)",
      !msgs.some((x) => x.senderId === agentAll.id), `count=${msgs.filter((x) => x.senderId === agentAll.id).length}`);
  }

  // ── Send 2: addressed send that @mentions the selected agent AND another ──
  const selCountBefore = msgs.filter(isSel).length;
  await sleep(2500); // clear the 2s dispatch cooldown for agentOther
  const human2 = await rpc(cdp, async (a) => window.electron.sendMessage({
    channelId: a.channelId, content: a.content, agentId: a.agentId,
  }), { channelId: channel.id, content: `@QASel${sfx} and @${otherName} please check in`, agentId: agentSel.id });
  report.assert('second addressed send accepted', human2?.success === true, JSON.stringify(human2)?.slice(0, 300));

  const otherDispatched = await pollUntil(
    () => channelMessages(cdp, channel.id),
    (m) => m.some((x) => x.senderId === agentOther.id && isDispatcherMsg(x) && x.metadata?.parentDispatchMessageId === human2.message.id),
    { timeout: 60000 },
  );
  report.assert('explicit @mention of ANOTHER agent in an addressed send still dispatches (parented to the human message)',
    otherDispatched.ok, 'no dispatcher message from mentioned agent within 60s');

  const selTurn2 = await pollUntil(
    () => channelMessages(cdp, channel.id),
    (m) => m.filter(isSel).length > selCountBefore,
    { timeout: 60000 },
  );
  report.assert('selected agent turn ran for send 2', selTurn2.ok, 'no new selected-agent message within 60s');

  await sleep(3000);
  msgs = await channelMessages(cdp, channel.id);
  const newSelMsgs = msgs.filter(isSel).slice(selCountBefore);
  report.assert('addressed agent deduped: @mentioning it adds no second turn (exactly one new message)',
    newSelMsgs.length === 1, `new=${newSelMsgs.length}`);
  if (model) {
    report.assert('send-2 reply also carries NO dispatchedBy',
      newSelMsgs[0] && !newSelMsgs[0].metadata?.dispatchedBy, JSON.stringify(newSelMsgs[0]?.metadata));
  }
  const allParentedToHuman2 = msgs.filter((x) => x.senderId === agentAll.id && x.metadata?.parentDispatchMessageId === human2.message.id);
  report.assert("respondTo:'all' broadcast suppressed for the second addressed send",
    allParentedToHuman2.length === 0, JSON.stringify(allParentedToHuman2.map((x) => x.id)));

  // ── Re-entry leg: @mention inside the server-finalized reply dispatches ──
  // A dedicated channel with a relay agent whose reply @mentions QAOther —
  // the mention exists ONLY in the finalized reply, so a dispatch parented
  // to the reply id proves the message:updated(draftFinalized) hook. The
  // relay prompt is deliberately trivial; retries absorb LLM nondeterminism.
  if (model) {
    const echoName = `echo${sfx}`;
    const agentEcho = await createAgent(cdp, { name: echoName, model, systemPrompt: 'Answer in one short sentence. Do not @mention anyone.' });
    // Constant-output prompt + roleplay archetype: the archetype's empty-tool
    // jail keeps discovery-tool schemas out of the request — with tools bound,
    // the smallest local models stop following even trivial instructions.
    const agentRelay = await rpc(cdp, async (a) => {
      const agent = await window.electron.createAgent({
        name: a.name, description: 'QA relay agent', provider: 'ollama', model: a.model,
        temperature: 0, systemPrompt: a.systemPrompt, archetype: { type: 'roleplay' },
      });
      if (!agent?.id) throw new Error('createAgent failed: ' + JSON.stringify(agent));
      return { id: agent.id, name: agent.name };
    }, {
      name: `Relay${sfx}`, model,
      systemPrompt: `Whenever anyone sends you any message, your entire reply is exactly this and nothing else: @${echoName} ack`,
    });

    let reentryReply = null;
    let reentryChannelId = null;
    for (let attempt = 1; attempt <= 3 && !reentryReply; attempt++) {
      // Fresh channel per attempt — a failed attempt's chatter would pollute
      // the next attempt's history and compound the noncompliance.
      const channelB = await createChannel(cdp, `qa-flow2b-${sfx}-${attempt}`);
      await addParticipant(cdp, channelB.id, agentRelay.id);
      await addParticipant(cdp, channelB.id, agentEcho.id);
      await rpc(cdp, async (a) => window.electron.sendMessage({
        channelId: a.channelId, content: 'go ahead', agentId: a.agentId,
      }), { channelId: channelB.id, agentId: agentRelay.id });
      const turn = await pollUntil(
        () => channelMessages(cdp, channelB.id),
        (m) => m.some((x) => x.senderId === agentRelay.id && !x.isDraft && x.content),
        { timeout: 60000 },
      );
      const candidate = turn.value.find((x) => x.senderId === agentRelay.id && !x.isDraft && x.content);
      if (candidate?.content?.includes(`@${echoName}`)) {
        reentryReply = candidate;
        reentryChannelId = channelB.id;
      } else if (attempt < 3) {
        report.info(`re-entry attempt ${attempt}: reply lacked the mention (${JSON.stringify(candidate?.content)?.slice(0, 80)}), retrying`);
        await sleep(2500); // clear dispatch cooldowns before the next attempt
      }
    }

    if (reentryReply) {
      const mentionDispatch = await pollUntil(
        () => channelMessages(cdp, reentryChannelId),
        (m) => m.some((x) => x.senderId === agentEcho.id && isDispatcherMsg(x) && x.metadata?.parentDispatchMessageId === reentryReply.id),
        { timeout: 60000 },
      );
      report.assert('draftFinalized re-entry: @mention in the server-finalized reply dispatches, parented to the reply id',
        mentionDispatch.ok, 'no dispatcher message from mentioned agent within 60s');
    } else {
      report.skip('draftFinalized re-entry: @mention in the server-finalized reply dispatches', 'model never emitted the instructed mention in 3 attempts (LLM nondeterminism)');
    }
  } else {
    report.skip('draftFinalized re-entry: @mention in the server-finalized reply dispatches', 'no local ollama at :11434');
  }

  await rpc(cdp, async () => { window.__qaStreamUnsub?.(); });
} finally {
  cdp.close();
}
report.finish();
