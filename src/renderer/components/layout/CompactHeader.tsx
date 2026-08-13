import { Hash, Folder, Minimize2, PanelTop, Settings2 } from 'lucide-react';
import { AvatarPip } from '@/components/AvatarPip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useAgentStore } from '@/stores/useAgentStore';
import { useConversationsStore, useUIPreferencesStore, useUIStore } from '@/stores';
import { useChannelActions } from '@/hooks/useChannelActions';
import './CompactHeader.css';

/**
 * The header for compact ("companion") mode.
 *
 * Rendered by TopMenuBar in place of the menu bar, which means it inherits
 * that bar's job as the title bar on the frameless platforms — it is the drag
 * region, and the caption buttons sit beside it. That is why the control rail
 * renders even when the user has hidden the header: without it a compact
 * window on Linux would have nothing to grab, and no way out of compact mode
 * short of remembering the chord.
 */
export function CompactHeader() {
  const header = useUIPreferencesStore((s) => s.compactHeader);
  const setPart = useUIPreferencesStore((s) => s.setCompactHeaderPart);
  const toggleHeader = useUIPreferencesStore((s) => s.toggleCompactHeader);
  const setCompactMode = useUIPreferencesStore((s) => s.setCompactMode);

  const view = useUIStore((s) => s.view);
  const isChannel = view === 'channels';

  return (
    <div className="compact-header">
      {header.visible && (
        isChannel ? <ChannelIdentity showIdentity={header.identity} showTitle={header.title} />
                  : <ChatIdentity showIdentity={header.identity} showTitle={header.title} showModel={header.model} />
      )}

      <div className="compact-header-spacer" />

      <div className="compact-header-controls">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="compact-header-btn" title="Header options" aria-label="Header options">
              <Settings2 size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Compact header</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={header.visible}
              onCheckedChange={(checked) => setPart('visible', checked === true)}
            >
              Show header
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={header.identity}
              disabled={!header.visible}
              onCheckedChange={(checked) => setPart('identity', checked === true)}
            >
              Agent identity
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={header.title}
              disabled={!header.visible}
              onCheckedChange={(checked) => setPart('title', checked === true)}
            >
              Conversation title
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={header.model}
              disabled={!header.visible || isChannel}
              onCheckedChange={(checked) => setPart('model', checked === true)}
            >
              Model &amp; provider
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          className={`compact-header-btn ${header.visible ? '' : 'is-off'}`}
          onClick={toggleHeader}
          title={header.visible ? 'Hide header' : 'Show header'}
          aria-label={header.visible ? 'Hide header' : 'Show header'}
        >
          <PanelTop size={14} />
        </button>

        <button
          className="compact-header-btn"
          onClick={() => setCompactMode(false)}
          title="Exit compact mode"
          aria-label="Exit compact mode"
        >
          <Minimize2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** Live indicator: filled while the agent holds the turn, hollow when idle. */
function StatusDot({ streaming, color }: { streaming: boolean; color: string }) {
  return (
    <span
      className={`compact-status-dot ${streaming ? 'is-streaming' : ''}`}
      style={{ backgroundColor: streaming ? color : 'transparent', borderColor: color }}
      title={streaming ? 'Replying…' : 'Idle'}
      aria-label={streaming ? 'Replying' : 'Idle'}
    />
  );
}

function ChatIdentity({
  showIdentity,
  showTitle,
  showModel,
}: {
  showIdentity: boolean;
  showTitle: boolean;
  showModel: boolean;
}) {
  const currentChat = useConversationsStore((s) => s.chats.find((c) => c.id === s.currentChatId));
  const isLoading = useConversationsStore((s) => s.isLoading);
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === currentChat?.agentId));

  if (!currentChat) return null;

  const name = agent?.name ?? 'Agent';
  const color = agent?.color ?? '#c084fc';

  return (
    <div className="compact-header-identity">
      {showIdentity && (
        <>
          <StatusDot streaming={isLoading} color={color} />
          <AvatarPip avatar={agent?.avatar} name={name} color={color} />
          <span className="compact-header-name" style={{ color }} title={name}>
            {name}
          </span>
        </>
      )}
      {showTitle && (
        <>
          {showIdentity && <span className="compact-header-sep">·</span>}
          <span className="compact-header-title" title={currentChat.name}>
            {currentChat.name}
          </span>
        </>
      )}
      {showModel && agent && (
        <>
          {(showIdentity || showTitle) && <span className="compact-header-sep">·</span>}
          <span className="compact-header-model" title={`${agent.provider} · ${agent.model}`}>
            {agent.model}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Channels have no single agent, so identity is the one that answers an
 * un-mentioned message — the same "Ask:" choice the full header offers. It
 * stays reachable here because compact mode hides that header, and without it
 * the only way to direct a message would be to type an @mention.
 */
function ChannelIdentity({ showIdentity, showTitle }: { showIdentity: boolean; showTitle: boolean }) {
  const currentChannel = useConversationsStore((s) =>
    s.channels.find((c) => c.id === s.currentChannelId),
  );
  const selectedAgents = useConversationsStore((s) => s.channelSelectedAgents);
  const isLoading = useConversationsStore((s) => s.channelIsLoading);
  const agents = useAgentStore((s) => s.agents);
  const { handleAgentChange } = useChannelActions();

  if (!currentChannel) return null;

  const selectedId = selectedAgents.get(currentChannel.id) ?? '';
  const channelAgents = agents.filter((agent) =>
    currentChannel.participants.some((p) => p.id === agent.id && p.type === 'agent'),
  );
  const selected = channelAgents.find((a) => a.id === selectedId);
  const color = selected?.color ?? '#c084fc';

  return (
    <div className="compact-header-identity">
      {showTitle && (
        <span className="compact-header-title" title={currentChannel.name}>
          {currentChannel.type === 'project' ? <Folder size={14} /> : <Hash size={14} />}
          {currentChannel.name}
        </span>
      )}
      {showIdentity && channelAgents.length > 0 && (
        <>
          {showTitle && <span className="compact-header-sep">·</span>}
          <StatusDot streaming={isLoading} color={color} />
          <select
            className="compact-header-select"
            value={selectedId}
            onChange={(e) => handleAgentChange(e.target.value)}
            title="Which agent answers an un-mentioned message"
            aria-label="Ask agent"
          >
            {channelAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
