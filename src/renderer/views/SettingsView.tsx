import { useCallback, useEffect, useMemo, useState } from 'react';
import { getPersisted } from '@/lib/legacyStorage';
import { GeneralSection } from '@/components/settings/GeneralSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { DefaultsSection } from '@/components/settings/DefaultsSection';
import { ProvidersSection } from '@/components/settings/ProvidersSection';
import { MemorySettingsSection } from '@/components/settings/MemorySettingsSection';
import { UsageSection } from '@/components/settings/UsageSection';
import { MessagingIntegrationsSection } from '@/components/settings/MessagingIntegrationsSection';
import { AdvancedSection } from '@/components/settings/AdvancedSection';
import { UpdatesSection } from '@/components/settings/UpdatesSection';
import { DataSection } from '@/components/settings/DataSection';
import { SyncSection } from '@/components/settings/SyncSection';
import { useUIStore } from '@/stores/useUIStore';
import type { SettingsTabId as TabId } from '@/types';

interface TabMeta {
  id: TabId;
  label: string;
  description: string;
}

// Every tab auto-saves its own state — the user never needs to click Save.
// Text/password inputs commit on blur; toggles/radios/dropdowns commit on change.
const TABS: TabMeta[] = [
  { id: 'general', label: 'General', description: 'Your identity and name.' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and background.' },
  { id: 'defaults', label: 'Defaults', description: 'Default agent for new chats and the system model for background work.' },
  { id: 'providers', label: 'Providers', description: 'API keys and local endpoints.' },
  { id: 'memory', label: 'Memory', description: 'Semantic (vector) search embeddings for agent memory.' },
  { id: 'usage', label: 'Usage', description: 'Model prices, grid carbon intensity, and hardware power measurement.' },
  { id: 'integrations', label: 'Integrations', description: 'Messaging bridges and external connections.' },
  { id: 'sync', label: 'Sync', description: 'Keep your devices in sync over your local network — private, serverless, end-to-end encrypted.' },
  { id: 'advanced', label: 'Advanced', description: 'Safety, setup wizard, logs.' },
  { id: 'updates', label: 'Updates', description: 'Version and update checks.' },
  { id: 'data', label: 'Data', description: 'Your Eaves data directory.' },
];

const LAST_TAB_KEY = 'eaves.settings.lastTab';

function loadLastTab(): TabId {
  try {
    const saved = getPersisted(LAST_TAB_KEY);
    if (saved && TABS.some(t => t.id === saved)) return saved as TabId;
  } catch { /* localStorage unavailable */ }
  return 'general';
}

export function SettingsView() {
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab);
  const clearPendingSettingsTab = useUIStore((s) => s.clearPendingSettingsTab);
  const [activeTab, setActiveTab] = useState<TabId>(() => pendingSettingsTab ?? loadLastTab());

  // Deep link from elsewhere (menu bar): honor it whether it was set before
  // this view mounted or while it was already open, then clear it.
  useEffect(() => {
    if (!pendingSettingsTab) return;
    setActiveTab(pendingSettingsTab);
    clearPendingSettingsTab();
  }, [pendingSettingsTab, clearPendingSettingsTab]);

  useEffect(() => {
    try { localStorage.setItem(LAST_TAB_KEY, activeTab); } catch { /* ignore */ }
  }, [activeTab]);

  const currentTab = useMemo(() => TABS.find(t => t.id === activeTab) ?? TABS[0], [activeTab]);

  const renderPane = useCallback(() => {
    switch (activeTab) {
      case 'general': return <GeneralSection />;
      case 'appearance': return <AppearanceSection />;
      case 'defaults': return <DefaultsSection />;
      case 'providers': return <ProvidersSection />;
      case 'memory': return <MemorySettingsSection />;
      case 'usage': return <UsageSection />;
      case 'integrations': return <MessagingIntegrationsSection />;
      case 'sync': return <SyncSection />;
      case 'advanced': return <AdvancedSection />;
      case 'updates': return <UpdatesSection />;
      case 'data': return <DataSection />;
    }
  }, [activeTab]);

  return (
    <div className="flex h-full overflow-hidden">
      <nav
        className="shrink-0 border-r border-border overflow-y-auto"
        style={{ width: '220px', backgroundColor: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
      >
        <div className="p-4">
          <h2 className="text-lg font-semibold mb-4">Settings</h2>
          <ul className="space-y-1">
            {TABS.map((tab) => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary/10 font-medium'
                      : 'hover:bg-muted/50'
                  }`}
                  style={activeTab === tab.id ? { color: 'var(--accent-primary)' } : undefined}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="p-8 max-w-2xl">
          <div className="mb-6">
            <h3 className="text-2xl font-semibold">{currentTab.label}</h3>
            <p className="text-sm text-muted-foreground mt-1">{currentTab.description}</p>
          </div>
          {renderPane()}
        </div>
      </div>
    </div>
  );
}
