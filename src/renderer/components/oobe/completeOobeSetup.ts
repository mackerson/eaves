import { unwrapIpc } from '@/lib/ipcEnvelope';
import type { AgentConfig, ProviderConfig } from './OOBEWizard';

export interface CompleteOobeSetupParams {
  userName: string;
  providerConfig: ProviderConfig;
  agentConfig: AgentConfig;
  /** Open a first chat and ask the agent to show the user around. */
  guidedTour: boolean;
}

/**
 * The kickoff message, written as the user's own request rather than a stage
 * direction, because that is what it is — they clicked the button asking for
 * it, and it lands in their chat history where a system-voice instruction
 * would read as noise they never wrote.
 *
 * The agent's knowledge of Eaves comes from the `eaves_guide` tool, which
 * is always active, so this only has to point at it. Don't restate the app's
 * features here: a copy would drift out of step with the guide and the guide
 * is the version that stays correct.
 */
export function buildTourKickoff(userName: string): string {
  return [
    `Hi — I'm ${userName}, and this is my first time using Eaves.`,
    '',
    'Start by checking the eaves_guide tool so you know how this app actually works,',
    "then introduce yourself and show me around. I'd rather you asked what I'm here to do",
    'and worked from that than ran through a feature list.',
    '',
    'Once you know, help me actually set something up — use your tools to do the work',
    'rather than telling me where to click. Go one step at a time and check in as you go.',
  ].join('\n');
}

/**
 * The final OOBE commit: save the credential, create the agent, point the
 * defaults at it, and mark first-run done.
 *
 * Every call goes through `unwrapIpc`. These handlers resolve with a
 * `{success:false}` envelope instead of rejecting, so an unchecked `await`
 * reads as success — which is how a rejected step-1 patch (a >50-char name
 * fails `UserNameSchema`, taking the API key down with it, since it's one Zod
 * object) still ended with `oobeCompleted = true` and the user staring at an
 * auth error on their first message.
 *
 * Order matters: `complete-oobe` is last, so a failure anywhere above leaves
 * the wizard resumable rather than stranding the user in an app with no agent.
 */
export async function completeOobeSetup(
  { userName, providerConfig, agentConfig, guidedTour }: CompleteOobeSetupParams,
): Promise<{ agentId: string; tourChatId: string | null }> {
  unwrapIpc(
    await window.electron.updateSettings({
      userName,
      apiKeys: { [providerConfig.provider]: providerConfig.apiKey },
    }),
    'Saving your provider key',
  );

  const agent = unwrapIpc(
    await window.electron.createAgent({
      name: agentConfig.name,
      description: agentConfig.description,
      systemPrompt: agentConfig.systemPrompt,
      provider: providerConfig.provider,
      model: providerConfig.model,
      temperature: agentConfig.temperature,
      color: agentConfig.color,
    }),
    'Creating your agent',
  );
  // A validation failure is an envelope and unwrapIpc catches it. Anything else
  // unexpected would leave `agent.id` undefined and silently no-op every write
  // below, so require it explicitly rather than trusting the declared type.
  if (!agent?.id) throw new Error('Creating your agent: no agent was returned');

  unwrapIpc(await window.electron.switchAgent(agent.id), 'Selecting your agent');

  // Pin the freshly-created agent as both the chat-facing default and the
  // background-work system model. There's only one agent in the world at this
  // point, so any background call (chat title generation, note metadata) has a
  // sane target instead of erroring on "no agent selected". The user can
  // re-point either picker later from Settings → Defaults.
  unwrapIpc(
    await window.electron.updateSettings({
      defaultAgentId: agent.id,
      systemAgentId: agent.id,
    }),
    'Setting your default agent',
  );

  // The tour is a convenience, not part of a working install. If chat creation
  // or the first message fails, finish setup anyway and drop the user into an
  // app that works — failing here would strand them at the last step of the
  // wizard over something they can redo with one click.
  let tourChatId: string | null = null;
  if (guidedTour) {
    try {
      tourChatId = await startTourChat(agent.id, userName);
    } catch (error) {
      window.electron.logError({ message: 'OOBE tour chat could not be started', error });
    }
  }

  unwrapIpc(await window.electron.completeOobe(), 'Finishing setup');

  return { agentId: agent.id, tourChatId };
}

/**
 * Create the first chat and post the kickoff as the user's message. Deliberately
 * stops short of starting the agent's turn: the caller reloads app state first
 * so the chat view is mounted for the stream, and the reply is persisted
 * server-side either way.
 */
async function startTourChat(agentId: string, userName: string): Promise<string> {
  const created = unwrapIpc(
    await window.electron.createChat({ name: 'Getting started', agentId }),
    'Opening your first chat',
  );
  const chatId = created?.chat?.id;
  if (!chatId) throw new Error('Opening your first chat: no chat was returned');

  unwrapIpc(
    await window.electron.sendChatMessage({ chatId, content: buildTourKickoff(userName) }),
    'Sending your first message',
  );
  unwrapIpc(await window.electron.switchChat(chatId), 'Selecting your first chat');
  return chatId;
}
