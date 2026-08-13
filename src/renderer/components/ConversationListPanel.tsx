import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useResize } from '@/hooks/useResize';
import { AppIcon } from '@/components/ui/AppIcon';
import { ConversationList } from './ConversationList';

/**
 * The unified conversations panel (channels + chats) with collapse and
 * resize chrome. Mounted by both ChatsView and ChannelView so the two
 * message surfaces share one navigation rail.
 */
export const ConversationListPanel: React.FC = () => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { size, startResize } = useResize({
    initialSize: 256,
    minSize: 200,
    maxSize: 400,
    storageKey: 'chat-sidebar-width',
  });

  if (isCollapsed) {
    return (
      <div className="w-10 border-r border-border flex flex-col items-center py-2 gap-2" style={{ backgroundColor: 'var(--bg-secondary-transparent)', backdropFilter: 'blur(var(--ui-blur))' }}>
        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          onClick={() => setIsCollapsed(false)}
          title="Expand sidebar"
        >
          <ChevronRight size={14} />
        </button>
        <div className="w-6 h-px bg-border" />
        <button
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          onClick={() => setIsCollapsed(false)}
          title="Conversations"
        >
          <AppIcon name="chat" size={20} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="border-r flex flex-col relative flex-shrink-0"
      style={{ width: `${size}px`, minWidth: `${size}px`, backgroundColor: 'var(--bg-secondary-transparent)', backdropFilter: 'blur(var(--ui-blur))' }}
    >
      <ConversationList onCollapse={() => setIsCollapsed(true)} />
      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
        onMouseDown={startResize}
      />
    </div>
  );
};
