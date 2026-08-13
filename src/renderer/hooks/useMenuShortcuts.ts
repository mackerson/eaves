import { useEffect } from 'react';
import { buildMenuModel, collectAccelerators, type MenuCommandId } from '@shared/menuModel';
import { matchesAccelerator, type MenuPlatform } from '@shared/accelerators';

/**
 * True when the event target is a text-entry surface.
 *
 * Lives here rather than beside the accelerator helpers because it is the
 * one genuinely DOM-bound piece, and those helpers are shared with the main
 * process build.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Binds the menu model's accelerators on platforms without a native menu.
 *
 * On macOS the native menu owns its accelerators; binding them here too
 * would fire every command twice. Windows and Linux have no application
 * menu, so the renderer has to do it — but from the same declaration the
 * menu rows render from, so a chord and its label can never disagree.
 *
 * This replaces the hand-maintained chord list that had drifted from the
 * labels beside it.
 */
export function useMenuShortcuts(
  platform: MenuPlatform,
  onCommand: (id: MenuCommandId) => void,
) {
  useEffect(() => {
    if (platform === 'darwin') return;

    const bindings = collectAccelerators(buildMenuModel(platform));

    const handleKeyDown = (event: KeyboardEvent) => {
      for (const binding of bindings) {
        if (!matchesAccelerator(event, binding.accelerator, platform)) continue;

        // Let the OS/browser keep the clipboard and undo chords while the
        // user is in a text field — intercepting them there would break
        // typing to serve a menu row that does the same thing.
        if (isTextEntryTarget(event.target) && isTextEditingCommand(binding.id)) return;

        event.preventDefault();
        onCommand(binding.id);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [platform, onCommand]);
}

const TEXT_EDITING_COMMANDS = new Set<MenuCommandId>([
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
]);

function isTextEditingCommand(id: MenuCommandId): boolean {
  return TEXT_EDITING_COMMANDS.has(id);
}
