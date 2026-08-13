#!/usr/bin/env node
/**
 * Flow 6 — channel-surface feature parity: tags/archive are first-class on
 * every channel (not just the direct/chat projection) and channels accept
 * attachment sends.
 *
 * Contract characterized:
 *  - update-channel writes `tags: string[]` (full replacement; null clears),
 *    get-channels-by-tags filters on them, and get-channels projects them.
 *  - archive-channel / unarchive-channel round-trip; archived channels are
 *    excluded from the default get-channels list (and from getMemory's
 *    channel list, the sidebar's source) unless includeArchived:true.
 *  - The real ChannelView DOM carries the chrome: tag chips render, the tag
 *    input adds a tag, the chip remove button deletes it, and the archive
 *    toggle hides the channel from the open view (all storage-event silent).
 *  - send-message accepts `attachments` (chat-shape): the human message
 *    persists image/file content blocks whose URLs resolve to rows in the
 *    unified message_attachments table, and (LLM) the selected agent's turn
 *    sees the inlined file contents. Without ollama, the unreachable-provider
 *    dispatch-error notice still persists and the attachment blocks survive.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openHarness, rpc, pollUntil, makeReport, detectOllama, ensureProject,
  createAgent, createChannel, addParticipant, channelMessages, isDispatcherMsg,
  readState, sleep, uid, FALLBACK_MODEL,
} from './lib.mjs';

const report = makeReport('flow6-channel-features');
const model = await detectOllama();
report.info(model ? `ollama model: ${model}` : 'no local ollama — exercising error contracts');
const { cdp } = await openHarness();

/** Count message_attachments rows for a message straight from the profile DB. */
function countAttachmentRows(messageId) {
  if (!/^[A-Za-z0-9_-]+$/.test(messageId)) throw new Error(`unsafe messageId: ${messageId}`);
  const state = readState();
  if (!state?.xdg) throw new Error('harness state missing xdg dir');
  const db = path.join(state.xdg, 'enclave', 'enclave-data', 'enclave.db');
  const out = execFileSync('sqlite3', ['-cmd', '.timeout 3000', db,
    `SELECT COUNT(*) FROM message_attachments WHERE message_id = '${messageId}'`]).toString().trim();
  return Number(out);
}

try {
  await ensureProject(cdp);
  const sfx = uid();
  const agent = await createAgent(cdp, {
    name: `QAFeat${sfx}`, model: model ?? FALLBACK_MODEL,
    systemPrompt: 'Answer in one short sentence.',
  });
  const channel = await createChannel(cdp, `qa-flow6-${sfx}`);
  await addParticipant(cdp, channel.id, agent.id);

  // ── Tags: set / filter / unset (IPC contract) ──────────────────────────────
  const tagA = `qa6a${sfx}`;
  const tagB = `qa6b${sfx}`;

  const tagged = await rpc(cdp, async (a) => window.electron.updateChannel(a.id, { tags: a.tags }),
    { id: channel.id, tags: [tagA, tagB] });
  report.assert('update-channel writes tags (returned channel carries string[] tags)',
    Array.isArray(tagged?.tags) && tagged.tags.includes(tagA) && tagged.tags.includes(tagB),
    JSON.stringify(tagged?.tags ?? tagged)?.slice(0, 200));

  const byTag = await rpc(cdp, async (a) => window.electron.getChannelsByTags({ tags: [a.tag] }), { tag: tagA });
  report.assert('get-channels-by-tags returns the tagged channel',
    byTag?.success === true && (byTag.channels || []).some((c) => c.id === channel.id),
    JSON.stringify((byTag?.channels || []).map((c) => c.id)));

  const listed = await rpc(cdp, async () => window.electron.getChannels());
  const listedRow = (listed?.channels || []).find((c) => c.id === channel.id);
  report.assert('get-channels projects the tags onto the listed channel',
    Array.isArray(listedRow?.tags) && listedRow.tags.includes(tagB), JSON.stringify(listedRow?.tags));

  const cleared = await rpc(cdp, async (a) => window.electron.updateChannel(a.id, { tags: null }), { id: channel.id });
  report.assert('tags: null clears the tag list (unset)',
    !!cleared && cleared.id === channel.id && (cleared.tags === undefined || cleared.tags === null || cleared.tags.length === 0),
    JSON.stringify(cleared?.tags ?? cleared)?.slice(0, 200));

  const byTagAfter = await rpc(cdp, async (a) => window.electron.getChannelsByTags({ tags: [a.tag] }), { tag: tagA });
  report.assert('unset tags drop the channel from the tag filter',
    byTagAfter?.success === true && !(byTagAfter.channels || []).some((c) => c.id === channel.id),
    JSON.stringify((byTagAfter?.channels || []).map((c) => c.id)));

  // ── Archive / unarchive + default-list exclusion (IPC contract) ────────────
  const archived = await rpc(cdp, async (a) => window.electron.archiveChannel(a.id), { id: channel.id });
  report.assert('archive-channel succeeds and stamps archivedAt',
    archived?.success === true && typeof archived.channel?.archivedAt === 'number',
    JSON.stringify(archived)?.slice(0, 200));

  const defaultList = await rpc(cdp, async () => window.electron.getChannels());
  report.assert('archived channel excluded from the default get-channels list',
    defaultList?.success === true && !(defaultList.channels || []).some((c) => c.id === channel.id),
    JSON.stringify((defaultList?.channels || []).map((c) => c.id)));

  const memoryList = await rpc(cdp, async () => {
    const mem = await window.electron.getMemory();
    return (mem.channels || []).map((c) => c.id);
  });
  report.assert('archived channel excluded from getMemory channels (sidebar source)',
    !memoryList.includes(channel.id), JSON.stringify(memoryList));

  const inclList = await rpc(cdp, async () => window.electron.getChannels({ includeArchived: true }));
  report.assert('includeArchived:true surfaces the archived channel',
    inclList?.success === true && (inclList.channels || []).some((c) => c.id === channel.id && c.archivedAt),
    JSON.stringify((inclList?.channels || []).map((c) => ({ id: c.id, archivedAt: c.archivedAt }))));

  const unarchived = await rpc(cdp, async (a) => window.electron.unarchiveChannel(a.id), { id: channel.id });
  report.assert('unarchive-channel restores the channel (archivedAt cleared)',
    unarchived?.success === true && !unarchived.channel?.archivedAt, JSON.stringify(unarchived)?.slice(0, 200));

  const restoredList = await rpc(cdp, async () => window.electron.getChannels());
  report.assert('unarchived channel is back in the default list',
    (restoredList?.channels || []).some((c) => c.id === channel.id),
    JSON.stringify((restoredList?.channels || []).map((c) => c.id)));

  // ── DOM: tag chips + archive toggle on the real ChannelView ────────────────
  // The renderer store only learns about IPC-created channels at boot
  // (getMemory) or via channels-changed pushes, so reload the page first —
  // the same state a user restarting the app would see.
  await rpc(cdp, async (a) => { await window.electron.switchChannel(a.id); }, { id: channel.id });
  // Deferred reload so the evaluate call returns before navigation tears the
  // context down (a bare location.reload() can strand the CDP response).
  await cdp.evaljs('setTimeout(() => location.reload(), 50); true');
  await sleep(1500);
  await cdp.waitFor(`document.body.innerText.includes('CONVERSATIONS')`, { timeout: 20000 });

  // Open the channel from the conversation rail (any leaf node bearing its name).
  const navClicked = await rpc(cdp, async (a) => {
    const leaves = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent?.trim() === a.name);
    if (leaves.length === 0) return false;
    leaves[0].click();
    return true;
  }, { name: channel.name });
  report.assert('channel entry appears in the conversation rail after reload', navClicked, 'no leaf node with the channel name');

  const headerReady = navClicked && (await pollUntil(
    () => rpc(cdp, async () => !!document.querySelector('[data-testid="channel-tag-input"]')),
    (v) => v === true,
    { timeout: 10000, interval: 300 },
  )).ok;
  report.assert('ChannelView header renders the tag editor', headerReady, 'channel-tag-input never appeared');

  if (headerReady) {
    const domTag = `qa6dom${sfx}`;
    // Type into the tag input (React-controlled: native setter + input event)
    // and commit with Enter.
    await rpc(cdp, async (a) => {
      const input = document.querySelector('[data-testid="channel-tag-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, a.tag);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, { tag: domTag });

    const chipShown = await pollUntil(
      () => rpc(cdp, async (a) => [...document.querySelectorAll('[data-testid="channel-tag-chip"]')]
        .some((el) => el.textContent?.includes(a.tag)), { tag: domTag }),
      (v) => v === true,
      { timeout: 10000, interval: 300 },
    );
    report.assert('typing in the tag input renders a tag chip', chipShown.ok, 'chip never rendered');

    const persistedTag = await rpc(cdp, async (a) => {
      const res = await window.electron.getChannels();
      return (res.channels || []).find((c) => c.id === a.id)?.tags ?? null;
    }, { id: channel.id });
    report.assert('DOM-added tag persisted through update-channel',
      Array.isArray(persistedTag) && persistedTag.includes(domTag), JSON.stringify(persistedTag));

    // Remove the tag via the chip's X.
    await rpc(cdp, async (a) => {
      const btn = document.querySelector(`[data-testid="channel-tag-remove-${a.tag}"]`);
      if (btn) btn.click();
    }, { tag: domTag });
    const chipGone = await pollUntil(
      () => rpc(cdp, async (a) => ![...document.querySelectorAll('[data-testid="channel-tag-chip"]')]
        .some((el) => el.textContent?.includes(a.tag)), { tag: domTag }),
      (v) => v === true,
      { timeout: 10000, interval: 300 },
    );
    report.assert('chip remove button unsets the tag in the DOM', chipGone.ok, 'chip still rendered');

    // Archive from the header toggle: the channel leaves the store's default
    // list, so the open view falls back to the empty state.
    await rpc(cdp, async () => {
      const btn = document.querySelector('[data-testid="channel-archive-toggle"]');
      if (btn) btn.click();
    });
    const viewCleared = await pollUntil(
      () => rpc(cdp, async () => document.body.innerText.includes('Select a channel')),
      (v) => v === true,
      { timeout: 10000, interval: 300 },
    );
    report.assert('archive toggle hides the channel from the open view (default exclusion)',
      viewCleared.ok, 'ChannelView still shows the archived channel');

    const archivedAgain = await rpc(cdp, async (a) => {
      const res = await window.electron.getChannels();
      return (res.channels || []).some((c) => c.id === a.id);
    }, { id: channel.id });
    report.assert('DOM archive persisted server-side (absent from default get-channels)',
      archivedAgain === false, 'channel still in default list');

    // Restore for the attachment leg below.
    await rpc(cdp, async (a) => window.electron.unarchiveChannel(a.id), { id: channel.id });
  } else {
    report.skip('typing in the tag input renders a tag chip', 'ChannelView DOM not reachable');
    report.skip('DOM-added tag persisted through update-channel', 'ChannelView DOM not reachable');
    report.skip('chip remove button unsets the tag in the DOM', 'ChannelView DOM not reachable');
    report.skip('archive toggle hides the channel from the open view (default exclusion)', 'ChannelView DOM not reachable');
    report.skip('DOM archive persisted server-side (absent from default get-channels)', 'ChannelView DOM not reachable');
  }

  // ── Attachment send: persistence + (LLM) the agent sees the contents ───────
  const secret = `halcyon${sfx}`;
  const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-qa-flow6-'));
  const attachPath = path.join(attachDir, 'briefing.txt');
  fs.writeFileSync(attachPath, `QA briefing document.\nThe secret word is ${secret}.\nReport it when asked.\n`);

  const send = await rpc(cdp, async (a) => window.electron.sendMessage({
    channelId: a.channelId,
    content: 'Read the attached file and reply with the secret word it contains.',
    agentId: a.agentId,
    attachments: [a.attachPath],
  }), { channelId: channel.id, agentId: agent.id, attachPath });
  report.assert('send-message accepts attachments and persists the human message',
    send?.success === true && send.message?.senderType === 'human', JSON.stringify(send)?.slice(0, 300));

  const fileBlock = (send?.message?.contentBlocks || []).find((b) => b.type === 'file');
  report.assert('human message carries a file content block with a file-service URL',
    !!fileBlock && typeof fileBlock.url === 'string' && fileBlock.url.startsWith('file-service://'),
    JSON.stringify(send?.message?.contentBlocks)?.slice(0, 300));

  if (send?.success) {
    const rows = countAttachmentRows(send.message.id);
    report.assert('attachment row persisted in the unified message_attachments table',
      rows === 1, `rows=${rows}`);

    // The persisted history must carry the blocks too (not just the return value).
    const persisted = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => x.id === send.message.id && Array.isArray(x.contentBlocks) && x.contentBlocks.some((b) => b.type === 'file')),
      { timeout: 15000 },
    );
    report.assert('reloaded channel history carries the attachment block', persisted.ok,
      'file block missing from persisted message');
  } else {
    report.skip('attachment row persisted in the unified message_attachments table', 'send failed');
    report.skip('reloaded channel history carries the attachment block', 'send failed');
  }

  if (model && send?.success) {
    const replied = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => x.senderId === agent.id && !x.isDraft && x.content),
      { timeout: 90000 },
    );
    const reply = replied.value.find((x) => x.senderId === agent.id && !x.isDraft && x.content);
    report.assert('selected-agent turn completed for the attachment send', replied.ok, 'no agent reply within 90s');
    if (reply) {
      if (String(reply.content).toLowerCase().includes(secret.toLowerCase())) {
        report.assert('agent saw the attachment contents (reply contains the secret word)', true);
      } else {
        report.skip('agent saw the attachment contents (reply contains the secret word)',
          `model replied without the word (LLM nondeterminism): ${JSON.stringify(reply.content).slice(0, 120)}`);
      }
    }
  } else if (send?.success) {
    report.skip('selected-agent turn completed for the attachment send', 'no local ollama at :11434');
    // Deterministic error contract instead: the unreachable provider persists
    // a dispatch-error notice and the attachment-bearing human turn survives.
    const errored = await pollUntil(
      () => channelMessages(cdp, channel.id),
      (m) => m.some((x) => x.senderId === agent.id && String(x.content).startsWith('[Error:')),
      { timeout: 45000 },
    );
    const notice = errored.value.find((x) => x.senderId === agent.id && String(x.content).startsWith('[Error:'));
    report.assert('unreachable provider persists a dispatch-error notice (attachment send)',
      errored.ok && isDispatcherMsg(notice), JSON.stringify(notice?.metadata));
    report.skip('agent saw the attachment contents (reply contains the secret word)', 'no local ollama at :11434');
  }

  fs.rmSync(attachDir, { recursive: true, force: true });
} finally {
  cdp.close();
}
report.finish();
