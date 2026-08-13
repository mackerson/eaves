/**
 * The application menu, declared once as data.
 *
 * Two renderers consume this tree: Electron's native menu on macOS
 * (src/main/services/ApplicationMenu.ts) and the in-window TopMenuBar on
 * Windows/Linux. Neither owns the structure, so the two cannot drift.
 *
 * Structure follows docs/design/menu-reorg: menus are verbs (make/find/
 * change/look/run), the sidebar keeps the nouns, and no command appears
 * in two places.
 */

import type { MenuPlatform } from './accelerators';

/**
 * Every command the menu bar can invoke.
 *
 * The renderer maps these to handlers (src/renderer/menu/commands.ts). The
 * native menu sends the id over IPC rather than duplicating the handler, so
 * a command's behaviour is defined in exactly one place regardless of which
 * menu surface triggered it.
 */
export type MenuCommandId =
  // App
  | 'app.about'
  | 'app.checkForUpdates'
  | 'app.settings'
  | 'app.hide'
  | 'app.quit'
  // File
  | 'file.newChat'
  | 'file.newChannel'
  | 'file.newProject'
  | 'file.newAgent'
  | 'file.newWorkflow'
  | 'file.newRoutine'
  | 'file.newNote'
  | 'file.newTask'
  | 'file.uploadFiles'
  | 'file.import'
  | 'file.exportConversation'
  // Edit — these carry native roles on macOS, but Windows/Linux has no
  // native menu to supply them, so each still needs a real command id.
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.findInConversation'
  // View
  | 'view.toggleSidebar'
  | 'view.toggleDetailPanel'
  | 'view.compactConversation'
  | 'view.showArchived'
  | 'view.showAgentToAgent'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.resetZoom'
  | 'view.toggleFullScreen'
  // Dynamic submenus report through one command per source; the chosen entry
  // travels alongside as a `dynamicId`.
  | 'view.setTheme'
  // Go
  | 'go.searchEverything'
  | 'go.conversations'
  | 'go.projects'
  | 'go.agents'
  | 'go.workflows'
  | 'go.routines'
  | 'go.files'
  | 'go.notes'
  | 'go.tasks'
  | 'go.calendar'
  | 'go.activity'
  | 'go.memory'
  // Tools
  | 'tools.plugins'
  | 'tools.modelProviders'
  | 'tools.runRoutine'
  | 'tools.runWorkflow'
  | 'tools.toggleDevTools'
  | 'tools.toggleTerminal'
  | 'tools.viewLogs'
  | 'tools.openDataDir'
  // Help
  | 'help.documentation'
  | 'help.keyboardShortcuts'
  | 'help.releaseNotes'
  | 'help.reportIssue';

/**
 * Submenus whose contents are only known at runtime.
 *
 * The renderer resolves these from stores; the native menu asks the
 * renderer for them over IPC and rebuilds when they change.
 */
export type DynamicMenuSource = 'appearance' | 'runRoutine' | 'runWorkflow';

/**
 * Electron menu roles. Used only by the native builder — letting the OS
 * implement Undo/Copy/Zoom is both less code and more correct than
 * reimplementing them, especially for clipboard and full-screen.
 */
export type MenuRole =
  | 'about'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'togglefullscreen'
  | 'minimize'
  | 'close'
  | 'hide'
  | 'quit';

export type MenuNode =
  | { kind: 'separator' }
  | {
      kind: 'item';
      id: MenuCommandId;
      label: string;
      accelerator?: string;
      /** When set, the native menu uses the OS implementation instead of the command id. */
      role?: MenuRole;
    }
  | {
      kind: 'checkbox';
      id: MenuCommandId;
      label: string;
      accelerator?: string;
    }
  | {
      kind: 'submenu';
      label: string;
      items: MenuNode[];
    }
  | {
      kind: 'dynamicSubmenu';
      label: string;
      source: DynamicMenuSource;
    };

export interface MenuDefinition {
  /** Stable identifier for the top-level menu, used as React key and for open/close state. */
  id: string;
  label: string;
  items: MenuNode[];
}

const separator: MenuNode = { kind: 'separator' };

/**
 * Rows that live in the macOS app menu. On Windows/Linux there is no app
 * menu, so per the design these fold into File (Settings) and Help
 * (About, Check for Updates) — the platform convention, not a port of the
 * mac layout.
 */
function appMenu(): MenuDefinition {
  return {
    id: 'app',
    label: 'Enclave',
    items: [
      { kind: 'item', id: 'app.about', label: 'About Enclave', role: 'about' },
      { kind: 'item', id: 'app.checkForUpdates', label: 'Check for Updates…' },
      separator,
      { kind: 'item', id: 'app.settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,' },
      separator,
      { kind: 'item', id: 'app.hide', label: 'Hide Enclave', role: 'hide', accelerator: 'Cmd+H' },
      { kind: 'item', id: 'app.quit', label: 'Quit Enclave', role: 'quit', accelerator: 'Cmd+Q' },
    ],
  };
}

function fileMenu(platform: MenuPlatform): MenuDefinition {
  const items: MenuNode[] = [
    // Conversations first: the twenty-times-a-day action owns the bare ⌘N.
    { kind: 'item', id: 'file.newChat', label: 'New Chat', accelerator: 'CmdOrCtrl+N' },
    { kind: 'item', id: 'file.newChannel', label: 'New Channel', accelerator: 'Shift+CmdOrCtrl+N' },
    separator,
    // Containers.
    { kind: 'item', id: 'file.newProject', label: 'New Project', accelerator: 'Shift+CmdOrCtrl+P' },
    { kind: 'item', id: 'file.newAgent', label: 'New Agent', accelerator: 'Shift+CmdOrCtrl+A' },
    separator,
    // Automation — deliberately unshortcut; a bad chord is worse than none.
    { kind: 'item', id: 'file.newWorkflow', label: 'New Workflow' },
    { kind: 'item', id: 'file.newRoutine', label: 'New Routine' },
    separator,
    // Artifacts. macOS distinguishes ⌃⌘N from ⌘N; Windows/Linux has only one
    // Ctrl, so the mac chord would collide with New Chat. Alt is the
    // conventional third modifier there.
    {
      kind: 'item',
      id: 'file.newNote',
      label: 'New Note',
      accelerator: platform === 'darwin' ? 'Control+Cmd+N' : 'Alt+CmdOrCtrl+N',
    },
    {
      kind: 'item',
      id: 'file.newTask',
      label: 'New Task',
      accelerator: platform === 'darwin' ? 'Control+Cmd+T' : 'Alt+CmdOrCtrl+T',
    },
    separator,
    { kind: 'item', id: 'file.uploadFiles', label: 'Upload Files…', accelerator: 'CmdOrCtrl+O' },
    { kind: 'item', id: 'file.import', label: 'Import…' },
    { kind: 'item', id: 'file.exportConversation', label: 'Export Conversation…' },
  ];

  if (platform !== 'darwin') {
    // No app menu off macOS — Settings and Quit come home to File.
    items.push(separator);
    items.push({ kind: 'item', id: 'app.settings', label: 'Preferences…', accelerator: 'CmdOrCtrl+,' });
    items.push({ kind: 'item', id: 'app.quit', label: 'Exit', role: 'quit' });
  }

  return { id: 'file', label: 'File', items };
}

function editMenu(): MenuDefinition {
  return {
    id: 'edit',
    label: 'Edit',
    items: [
      { kind: 'item', id: 'edit.undo', label: 'Undo', role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { kind: 'item', id: 'edit.redo', label: 'Redo', role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z' },
      separator,
      { kind: 'item', id: 'edit.cut', label: 'Cut', role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { kind: 'item', id: 'edit.copy', label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { kind: 'item', id: 'edit.paste', label: 'Paste', role: 'paste', accelerator: 'CmdOrCtrl+V' },
      separator,
      {
        kind: 'item',
        id: 'edit.findInConversation',
        label: 'Find in Conversation…',
        accelerator: 'CmdOrCtrl+F',
      },
    ],
  };
}

function viewMenu(platform: MenuPlatform): MenuDefinition {
  return {
    id: 'view',
    label: 'View',
    items: [
      { kind: 'item', id: 'view.toggleSidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\' },
      {
        kind: 'item',
        id: 'view.toggleDetailPanel',
        label: 'Toggle Detail Panel',
        accelerator: 'Alt+CmdOrCtrl+\\',
      },
      {
        // A letter, not the ⌘\ family this belongs to conceptually: off macOS
        // these chords are matched against KeyboardEvents, and Shift+\ reports
        // the shifted glyph ("|") rather than the key the accelerator names.
        kind: 'checkbox',
        id: 'view.compactConversation',
        label: 'Compact Conversation',
        accelerator: 'Shift+CmdOrCtrl+M',
      },
      separator,
      { kind: 'checkbox', id: 'view.showArchived', label: 'Show Archived' },
      { kind: 'checkbox', id: 'view.showAgentToAgent', label: 'Show Agent-to-Agent' },
      separator,
      { kind: 'dynamicSubmenu', label: 'Appearance', source: 'appearance' },
      { kind: 'item', id: 'view.zoomIn', label: 'Zoom In', role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
      { kind: 'item', id: 'view.zoomOut', label: 'Zoom Out', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { kind: 'item', id: 'view.resetZoom', label: 'Actual Size', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
      separator,
      {
        kind: 'item',
        id: 'view.toggleFullScreen',
        // ⌃⌘F is the mac convention; F11 is the Windows/Linux one. Porting
        // the mac chord would collide with Find in Conversation, since off
        // macOS Control and the primary modifier are the same key.
        label: platform === 'darwin' ? 'Enter Full Screen' : 'Full Screen',
        role: 'togglefullscreen',
        accelerator: platform === 'darwin' ? 'Control+Cmd+F' : 'F11',
      },
    ],
  };
}

/**
 * Go is the single place things get found. ⌘1–8 cover the eight surfaces
 * from the design; Calendar, Activity and Memory follow un-shortcut rather
 * than being left unreachable from the menu bar, per "a tenth object type
 * adds a row, not a menu".
 */
function goMenu(): MenuDefinition {
  return {
    id: 'go',
    label: 'Go',
    items: [
      { kind: 'item', id: 'go.searchEverything', label: 'Search Everything…', accelerator: 'CmdOrCtrl+K' },
      separator,
      { kind: 'item', id: 'go.conversations', label: 'Conversations', accelerator: 'CmdOrCtrl+1' },
      { kind: 'item', id: 'go.projects', label: 'Projects', accelerator: 'CmdOrCtrl+2' },
      { kind: 'item', id: 'go.agents', label: 'Agents', accelerator: 'CmdOrCtrl+3' },
      { kind: 'item', id: 'go.workflows', label: 'Workflows', accelerator: 'CmdOrCtrl+4' },
      { kind: 'item', id: 'go.routines', label: 'Routines', accelerator: 'CmdOrCtrl+5' },
      { kind: 'item', id: 'go.files', label: 'Files', accelerator: 'CmdOrCtrl+6' },
      { kind: 'item', id: 'go.notes', label: 'Notes', accelerator: 'CmdOrCtrl+7' },
      { kind: 'item', id: 'go.tasks', label: 'Tasks', accelerator: 'CmdOrCtrl+8' },
      separator,
      { kind: 'item', id: 'go.calendar', label: 'Calendar' },
      { kind: 'item', id: 'go.activity', label: 'Activity' },
      { kind: 'item', id: 'go.memory', label: 'Memory' },
    ],
  };
}

function toolsMenu(): MenuDefinition {
  return {
    id: 'tools',
    label: 'Tools',
    items: [
      { kind: 'dynamicSubmenu', label: 'Run Routine', source: 'runRoutine' },
      { kind: 'dynamicSubmenu', label: 'Run Workflow', source: 'runWorkflow' },
      separator,
      { kind: 'item', id: 'tools.plugins', label: 'Plugins…' },
      { kind: 'item', id: 'tools.modelProviders', label: 'Model Providers…' },
      separator,
      {
        kind: 'submenu',
        label: 'Developer',
        items: [
          // The terminal toggle existed only as an undiscoverable chord.
          // Giving it a row is the same fix the reorg applies everywhere else.
          { kind: 'item', id: 'tools.toggleTerminal', label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`' },
          { kind: 'item', id: 'tools.toggleDevTools', label: 'Toggle Developer Tools' },
          separator,
          { kind: 'item', id: 'tools.viewLogs', label: 'View Logs…' },
          { kind: 'item', id: 'tools.openDataDir', label: 'Open Data Directory' },
        ],
      },
    ],
  };
}

function helpMenu(platform: MenuPlatform): MenuDefinition {
  const items: MenuNode[] = [
    { kind: 'item', id: 'help.documentation', label: 'Enclave Help' },
    {
      kind: 'item',
      id: 'help.keyboardShortcuts',
      label: 'Keyboard Shortcuts',
      accelerator: 'CmdOrCtrl+/',
    },
    separator,
    { kind: 'item', id: 'help.releaseNotes', label: 'Release Notes' },
    { kind: 'item', id: 'help.reportIssue', label: 'Report an Issue…' },
  ];

  if (platform !== 'darwin') {
    items.push(separator);
    items.push({ kind: 'item', id: 'app.checkForUpdates', label: 'Check for Updates…' });
    items.push({ kind: 'item', id: 'app.about', label: 'About Enclave' });
  }

  return { id: 'help', label: 'Help', items };
}

/**
 * The whole bar for a platform.
 *
 * There is no Window menu: Enclave is single-window by design (see the
 * single-instance lock in main.ts), so New Window and Bring All to Front
 * have nothing to act on. Minimize/Zoom/Full Screen live in View instead.
 */
export function buildMenuModel(platform: MenuPlatform): MenuDefinition[] {
  const menus: MenuDefinition[] = [];
  if (platform === 'darwin') menus.push(appMenu());
  menus.push(fileMenu(platform));
  menus.push(editMenu());
  menus.push(viewMenu(platform));
  menus.push(goMenu());
  menus.push(toolsMenu());
  menus.push(helpMenu(platform));
  return menus;
}

/** Every accelerator in the model, paired with the command it fires. */
export function collectAccelerators(
  menus: MenuDefinition[],
): Array<{ id: MenuCommandId; accelerator: string; label: string }> {
  const out: Array<{ id: MenuCommandId; accelerator: string; label: string }> = [];

  const walk = (nodes: MenuNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'submenu') {
        walk(node.items);
      } else if (
        (node.kind === 'item' || node.kind === 'checkbox') &&
        node.accelerator
      ) {
        out.push({ id: node.id, accelerator: node.accelerator, label: node.label });
      }
    }
  };

  walk(menus.flatMap((menu) => menu.items));
  return out;
}
