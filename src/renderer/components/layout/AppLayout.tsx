import { ReactNode } from 'react';
import { TopMenuBar } from './TopMenuBar';
import { Sidebar } from './Sidebar';
import { BackgroundLayer } from '../BackgroundLayer';
import { ActionGutter } from '../ActionGutter';
import { useCompactMode } from '@/hooks/useCompactMode';
import './AppLayout.css';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const isCompact = useCompactMode();

  return (
    <div className={`app-layout${isCompact ? ' compact' : ''}`}>
      <BackgroundLayer />
      {/* Stays mounted in compact mode — it becomes the conversation header,
          and it owns the title bar and every keyboard accelerator. */}
      <TopMenuBar />
      <div className="app-body">
        {!isCompact && <Sidebar />}
        <main className="main-content">
          {children}
        </main>
        {/* Renders itself away when there is nothing pending. Hidden in
            compact mode: approval cards also render inline in the transcript,
            so a pending action stays visible and decidable without it. */}
        {!isCompact && <ActionGutter />}
      </div>
    </div>
  );
}
