import { useEffect, useMemo, useState } from 'react';
import { LogoSection } from './LogoSection';
import { UserMenu } from './UserMenu';
import { MenuBar } from './MenuBar';
import { WindowControls } from './WindowControls';
import { CompactHeader } from './CompactHeader';
import { AboutModal } from '@/components/modals/AboutModal';
import { GlobalSearchModal } from '@/components/modals/GlobalSearchModal';
import { LogViewerModal } from '@/components/modals/LogViewerModal';
import { buildMenuModel } from '@shared/menuModel';
import type { MenuPlatform } from '@shared/accelerators';
import { useMenuCommands } from '@/menu/useMenuCommands';
import { useMenuShortcuts } from '@/hooks/useMenuShortcuts';
import { useCompactMode } from '@/hooks/useCompactMode';
import './TopMenuBar.css';

/**
 * The in-window menu bar.
 *
 * On macOS the real menu lives in the system menu bar (see
 * src/main/services/ApplicationMenu.ts) and this renders only the logo and
 * identity, so the app does not show two menus at once. Everywhere else this
 * is the menu — Windows in particular has no native bar here because the
 * window is frameless and this component owns the title row.
 *
 * Compact mode swaps the bar's *contents* for the conversation header rather
 * than unmounting the bar. Two things depend on it staying: off macOS this is
 * the title bar — the drag region and, on Linux, the caption buttons — and it
 * is where useMenuShortcuts binds every accelerator, including the one that
 * leaves compact mode.
 */
export function TopMenuBar() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const platform = (window.electron?.platform ?? 'linux') as MenuPlatform;
  const isMac = platform === 'darwin';
  const isCompact = useCompactMode();
  // Linux is frameless, so this bar is the title bar and owns the caption
  // buttons. Windows is also frameless but the OS still paints them.
  const ownsCaptionButtons = platform === 'linux';

  const modals = useMemo(
    () => ({
      openAbout: () => setAboutOpen(true),
      openGlobalSearch: () => setSearchOpen(true),
      openLogViewer: () => setLogsOpen(true),
    }),
    [],
  );

  const { onCommand, isChecked, resolveDynamic } = useMenuCommands(modals);

  // macOS accelerators belong to the native menu; binding them here too would
  // fire every command twice.
  useMenuShortcuts(platform, onCommand);

  const menus = useMemo(() => buildMenuModel(platform), [platform]);

  // The native mac menu holds no behaviour — it forwards a command id here so
  // both surfaces run the same handler.
  useEffect(() => {
    if (!isMac) return;
    return window.electron.onMenuCommand(({ commandId, dynamicId }) => {
      onCommand(commandId as Parameters<typeof onCommand>[0], { dynamicId });
    });
  }, [isMac, onCommand]);

  // Ticks and runtime submenu contents live in renderer state, so the native
  // menu has to be told when they change or it redraws stale.
  useEffect(() => {
    if (!isMac) return;
    void window.electron.syncMenuState({
      checkboxes: {
        'view.showArchived': isChecked('view.showArchived'),
        'view.showAgentToAgent': isChecked('view.showAgentToAgent'),
        'view.compactConversation': isChecked('view.compactConversation'),
      },
      dynamic: {
        appearance: resolveDynamic('appearance'),
        runRoutine: resolveDynamic('runRoutine'),
        runWorkflow: resolveDynamic('runWorkflow'),
      },
    });
  }, [isMac, isChecked, resolveDynamic]);

  return (
    <div
      className={`top-menu-bar${isCompact ? ' compact' : ''}`}
      // Dropping the frame loses double-click-to-maximise, which is muscle
      // memory on every desktop. Only the drag region itself should do it —
      // double-clicking a menu button must not resize the window.
      onDoubleClick={(event) => {
        if (!ownsCaptionButtons) return;
        if (event.target !== event.currentTarget) return;
        void window.electron.toggleMaximizeWindow();
      }}
    >
      {isCompact ? (
        <CompactHeader />
      ) : (
        <>
          <LogoSection />

          {!isMac && (
            <MenuBar
              menus={menus}
              platform={platform}
              onCommand={onCommand}
              isChecked={isChecked}
              resolveDynamic={resolveDynamic}
            />
          )}

          <div className="spacer" />

          <UserMenu />
        </>
      )}

      {ownsCaptionButtons && <WindowControls />}

      <AboutModal open={aboutOpen} onOpenChange={setAboutOpen} />
      <GlobalSearchModal open={searchOpen} onOpenChange={setSearchOpen} />
      <LogViewerModal open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}
