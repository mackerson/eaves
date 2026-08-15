# Phase-0 characterization flows

Executable characterization coverage for the five interactive AI paths of the
chat/channel collapse, Phase 0 (design notes maintained outside the public
repo). These pin the persistence/event contract that later phases must not
silently change; they drive a real headless app instance (real renderer, real
IPC, real SQLite) via [`../harness.mjs`](../harness.mjs) on an isolated
profile — never the real one.

| Flow | Path | Pins |
|------|------|------|
| `flow1-chat-send.mjs` | 1:1 chat (`send-chat-message` + `chat-with-agent`) | human turn persisted, `message:created` reaches side services, ChatService persists the assistant turn (reply **or** `[Error: …]` notice), `context:'chat'` never dispatches |
| `flow2-channel-selected-agent.mjs` | channel selected-agent send (server-side, one call) | `send-message({channelId, content, agentId})` → server draft + live `chat-stream` → finalize (no `dispatchedBy` on the reply) → mentions in the reply dispatch via chained intent, parented to the reply id; `respondTo:'all'` suppressed on both sends; addressed agent deduped |
| `flow3-mention-dispatch.mjs` | @mention dispatch | human `@Agent` message → server-side dispatcher message tagged `dispatchedBy:'channel-dispatcher'` + `parentDispatchMessageId`, no re-dispatch loop |
| `flow4-respond-all-dispatch.mjs` | `respondTo:'all'` dispatch + storage-only bus (ADR-001) | broadcast agent responds to a mention-free human message; a bare repository write (empty agent draft via the deprecated `add-agent-message` bridge) triggers **no** dispatch — nothing on the EventBus starts a turn |
| `flow5-approval-suspend-resume.mjs` | tool-approval suspend/resume | `approval:list-pending` envelope; `approval:respond` fails closed on unknown id; (LLM) `needsApproval` suspends + registers, approve resumes as a **new** message tagged `resumedFromApproval`, block updated, registry consumed |
| `flow7-menu-bar.mjs` | menu bar open/switch/dismiss (not a Phase-0 pin) | click opens; hover switches **and stays open**; submenus survive a switch; Escape closes *and* restores trigger focus; same-trigger toggle, click-away, and item-select all close. Needs real CDP input — synthetic `pointerenter` doesn't bubble, so the switch bug is invisible to `Runtime.evaluate` alone. Skips on macOS (native menu) |
| `flow6-channel-features.mjs` | channel tags/archive + attachment sends (Phase 3 Round 3, not a Phase-0 pin) | `update-channel` tags set/filter/unset via `get-channels-by-tags`; archive/unarchive round-trip + default `get-channels`/`getMemory` exclusion; real ChannelView DOM (tag chip add/remove, archive toggle); `send-message` attachments persist file blocks + a `message_attachments` row; (LLM) the selected agent's reply proves it saw the inlined file contents |

## Running

```bash
yarn build:main            # Electron runs dist/main — always
yarn build:renderer        # unless a Vite dev server is on :5173
yarn rebuild-sqlite3       # if `yarn test` ran since the last dev/build

node scripts/qa/flows/run-all.mjs          # fresh profile, all flows, stop at end
```

Individual flows expect a running harness and leave it running (remember
`node scripts/qa/harness.mjs stop` when done):

```bash
node scripts/qa/harness.mjs launch --fresh
node scripts/qa/flows/flow3-mention-dispatch.mjs
node scripts/qa/harness.mjs stop
```

Flows exit **0 on pass** (skips allowed, reported inline) and **1 on any
contract violation**. Each flow creates uniquely-suffixed agents/channels, so
re-running against the same instance is safe; `run-all.mjs` always starts
`--fresh`.

## LLM determinism policy

Flows probe `localhost:11434` and use the smallest local ollama model
(override: `EAVES_QA_MODEL=name`). Without ollama every flow still asserts
the plumbing it can reach deterministically — an unreachable provider must
*persist* its failure (`[Error: …]` assistant message / in-channel dispatch
notice, still carrying dispatch metadata), which is itself part of the pinned
contract — and marks live-reply assertions as `SKIP`. Flow 5's suspend/resume
leg additionally depends on the model actually calling the `bash` tool; if it
never does, that leg is a `SKIP` (LLM nondeterminism), not a failure.

## Known seams (deliberate)

- `flow4` seeds `channel_behavior` straight into the profile DB via the
  `sqlite3` CLI: no renderer IPC writes it (`UpdateAgentIPCSchema` strips the
  key; the only production writer is the LLM-driven
  `update_my_channel_behavior` self-tool).
- `flow2`/`flow4` assert the interim Phase-0 draft fence in
  `ChannelDispatcher.handleMessageCreated` (`if (data.isDraft) return`).
  When Phase 2 replaces the fence with explicit dispatch intent, these
  assertions should keep passing unchanged — that is the point of the fence
  tests.
