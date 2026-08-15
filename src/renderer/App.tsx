import { useEffect } from 'react';
import './App.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppLayout } from '@/components/layout/AppLayout';
import { ViewRouter } from '@/components/ViewRouter';
import { AppModals } from '@/components/AppModals';
import { ToastContainer } from '@/components/Toast';
import { DropdownTerminal } from '@/components/DropdownTerminal';
import { PluginHotReload } from '@/components/PluginHotReload';
import { UpdateBanner } from '@/components/UpdateBanner';
import { OOBEWizard } from '@/components/oobe/OOBEWizard';
import { WindowChrome } from '@/components/layout/WindowChrome';
import { useAppInit } from '@/hooks/useAppInit';
import { useChatStream } from '@/hooks/useChatStream';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useProjectStore, useSettingsStore, useUIStore } from '@/stores';

function App() {
  const { loadMemory } = useAppInit();
  const getCurrentProject = useProjectStore(s => s.getCurrentProject);
  const oobeCompleted = useSettingsStore(s => s.settings.oobeCompleted);
  const settingsHydrated = useSettingsStore(s => s.settingsHydrated);
  const setView = useUIStore(s => s.setView);
  // Terminal visibility lives in the store so Tools ▸ Toggle Terminal can
  // reach it; this component just renders the result.
  const isDropdownTerminalOpen = useUIStore(s => s.terminalOpen);
  const setTerminalOpen = useUIStore(s => s.setTerminalOpen);

  useKeyboardShortcuts();

  // Single app-lifetime consumer of the 'chat-stream' IPC — routes envelope-
  // tagged events to the chat and channel stores. Mounted at the root because
  // both surfaces depend on it and a second subscriber would double-apply.
  useChatStream();

  useEffect(() => {
    return window.electron.onTrayNavigate(setView);
  }, [setView]);

  // Wait for settings to load from the main process before deciding which
  // root to render. Without this guard the OOBE wizard flashes on every
  // cold start, because the store's initial `oobeCompleted` is undefined
  // and the gate below reads that as falsy.
  // Both of the early returns below render instead of AppLayout, so they get
  // no TopMenuBar — and on a frameless window that is the only title bar there
  // is. WindowChrome keeps them movable and closable; without it a stalled
  // hydration leaves a blank window the user cannot even shut.
  if (!settingsHydrated) {
    return <WindowChrome />;
  }

  // Show OOBE wizard for first-time users
  if (!oobeCompleted) {
    return (
      <ErrorBoundary>
        <WindowChrome />
        <OOBEWizard onComplete={loadMemory} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppLayout>
        <ErrorBoundary>
          <div className="view-content">
            <ViewRouter loadMemory={loadMemory} />
            <AppModals loadMemory={loadMemory} />
            <ToastContainer />
            <PluginHotReload />
            <UpdateBanner />
            <DropdownTerminal
              isOpen={isDropdownTerminalOpen}
              onClose={() => setTerminalOpen(false)}
              cwd={getCurrentProject()?.directory}
            />
          </div>
        </ErrorBoundary>
      </AppLayout>
    </ErrorBoundary>
  );
}

export default App;
