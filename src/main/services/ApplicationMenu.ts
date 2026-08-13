import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import {
  buildMenuModel,
  type DynamicMenuSource,
  type MenuCommandId,
  type MenuNode,
} from '../../shared/menuModel';

/**
 * Native application menu for macOS.
 *
 * Enclave draws its own menu bar in the renderer (TopMenuBar), which is the
 * right call on Windows — where the window is frameless and that bar owns the
 * title row — and on Linux. macOS is different: the system menu bar is always
 * present and cannot be hidden, so an app that sets no menu inherits
 * Electron's stock default. That is exactly what Enclave did, leaving mac
 * users with a stale default menu above a second, custom one.
 *
 * So: real menu on darwin, no menu anywhere else, both driven by the shared
 * model so the two surfaces cannot describe different applications.
 */

/** An entry in a submenu whose contents are only known at runtime. */
export interface DynamicMenuEntry {
  /** Echoed back to the renderer when chosen. */
  id: string;
  label: string;
  checked?: boolean;
}

export class ApplicationMenu {
  private dynamic = new Map<DynamicMenuSource, DynamicMenuEntry[]>();
  private checkboxes = new Map<MenuCommandId, boolean>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /**
   * Every non-role item forwards to the renderer, which owns the handler.
   * The menu deliberately holds no behaviour of its own.
   */
  private onCommand(
    commandId: MenuCommandId,
    payload?: { dynamicId?: string; checked?: boolean },
  ): void {
    this.dispatchToRenderer(commandId, payload);
  }

  /**
   * Replaces the contents of a runtime-populated submenu (themes, routines,
   * workflows, sidebar sections) and rebuilds.
   */
  setDynamicEntries(source: DynamicMenuSource, entries: DynamicMenuEntry[]): void {
    this.dynamic.set(source, entries);
    this.apply();
  }

  /** Updates a checkable row's tick to match renderer state. */
  setCheckboxState(id: MenuCommandId, checked: boolean): void {
    this.checkboxes.set(id, checked);
    this.apply();
  }

  /**
   * Installs the menu. Off macOS this explicitly clears the application menu
   * rather than leaving Electron's default in place.
   */
  apply(): void {
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
      return;
    }

    const template = buildMenuModel('darwin').map((menu) => ({
      label: menu.label,
      submenu: this.toTemplate(menu.items),
    }));

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  private toTemplate(nodes: MenuNode[]): MenuItemConstructorOptions[] {
    const out: MenuItemConstructorOptions[] = [];

    for (const node of nodes) {
      switch (node.kind) {
        case 'separator':
          out.push({ type: 'separator' });
          break;

        case 'item':
          // Roles let the OS implement Undo/Copy/Zoom/Full Screen. That is
          // both less code and more correct than reimplementing them —
          // clipboard and full-screen in particular.
          if (node.role) {
            out.push({ label: node.label, role: node.role, accelerator: node.accelerator });
          } else {
            out.push({
              label: node.label,
              accelerator: node.accelerator,
              click: () => this.onCommand(node.id),
            });
          }
          break;

        case 'checkbox':
          out.push({
            label: node.label,
            accelerator: node.accelerator,
            type: 'checkbox',
            checked: this.checkboxes.get(node.id) ?? false,
            click: (item) => this.onCommand(node.id, { checked: item.checked }),
          });
          break;

        case 'submenu':
          out.push({ label: node.label, submenu: this.toTemplate(node.items) });
          break;

        case 'dynamicSubmenu':
          out.push(this.dynamicSubmenu(node.label, node.source));
          break;
      }
    }

    return out;
  }

  private dynamicSubmenu(label: string, source: DynamicMenuSource): MenuItemConstructorOptions {
    const entries = this.dynamic.get(source) ?? [];

    // An empty runtime submenu is disabled with an explanatory row rather
    // than rendered as an empty box the user can open and learn nothing from.
    if (entries.length === 0) {
      return {
        label,
        submenu: [{ label: 'None available', enabled: false }],
      };
    }

    return {
      label,
      submenu: entries.map((entry) => ({
        label: entry.label,
        type: entry.checked === undefined ? undefined : ('checkbox' as const),
        checked: entry.checked,
        click: () => this.onCommand(dynamicCommandId(source), { dynamicId: entry.id }),
      })),
    };
  }

  /** Sends a command to the renderer, which owns every handler. */
  private dispatchToRenderer(commandId: MenuCommandId, payload?: Record<string, unknown>): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('menu:command', { commandId, ...payload });
  }
}

/**
 * Dynamic submenus report through a single command per source; the chosen
 * entry travels as `dynamicId`.
 */
function dynamicCommandId(source: DynamicMenuSource): MenuCommandId {
  switch (source) {
    case 'appearance':
      return 'view.setTheme';
    case 'runRoutine':
      return 'tools.runRoutine';
    case 'runWorkflow':
      return 'tools.runWorkflow';
  }
}
