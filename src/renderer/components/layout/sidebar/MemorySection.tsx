import { useState, useEffect } from 'react';
import { useUIStore } from '@/stores';
import { AppIcon } from '@/components/ui/AppIcon';
import { CollapsibleSection } from './CollapsibleSection';

/**
 * Sidebar panel for the active memory backend — a preview of recent memory keys
 * plus a title-click into the full Memory view. Backend-agnostic (reads through
 * the memory:* IPC).
 */
export function MemorySection() {
  const { setView } = useUIStore();
  const [keys, setKeys] = useState<string[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.electron.memoryList().then(res => {
      if (cancelled || !res.success) return;
      setKeys((res.keys ?? []).slice(0, 5));
      setTotal(res.total ?? res.count ?? 0);
    });
    return () => { cancelled = true; };
  }, []);

  const openMemory = () => setView('memory');

  return (
    <CollapsibleSection title="Memory" badge={total || undefined} onTitleClick={openMemory}>
      {keys.length === 0 ? (
        <div className="section-empty">No memories yet.</div>
      ) : (
        <div className="section-list">
          {keys.map(key => (
            <button key={key} className="section-item" onClick={openMemory} title={key}>
              <AppIcon name="memory" size={16} className="item-icon" />
              <span className="item-label">{key.length > 30 ? `${key.slice(0, 30)}…` : key}</span>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
