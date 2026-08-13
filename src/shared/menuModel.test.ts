import { describe, it, expect } from 'vitest';
import { buildMenuModel, collectAccelerators, type MenuDefinition, type MenuNode } from './menuModel';
import { parseAccelerator, formatAccelerator, type MenuPlatform } from './accelerators';

const PLATFORMS: MenuPlatform[] = ['darwin', 'win32', 'linux'];

function walk(nodes: MenuNode[], visit: (node: MenuNode) => void) {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'submenu') walk(node.items, visit);
  }
}

function allNodes(menus: MenuDefinition[]): MenuNode[] {
  const out: MenuNode[] = [];
  walk(menus.flatMap((m) => m.items), (n) => out.push(n));
  return out;
}

describe.each(PLATFORMS)('menu model — %s', (platform) => {
  const menus = buildMenuModel(platform);

  // Rule 1 of the design: "Nothing appears in two menus." This is the rule the
  // old bar broke — New Project and New Agent each had two homes, and the two
  // copies drifted. Enforcing it here means a future edit can't quietly
  // reintroduce the duplication that motivated the reorg.
  it('gives every command exactly one home', () => {
    const seen = new Map<string, string[]>();
    for (const menu of menus) {
      walk(menu.items, (node) => {
        if (node.kind === 'item' || node.kind === 'checkbox') {
          const homes = seen.get(node.id) ?? [];
          homes.push(`${menu.label} ▸ ${node.label}`);
          seen.set(node.id, homes);
        }
      });
    }
    const duplicated = [...seen.entries()].filter(([, homes]) => homes.length > 1);
    expect(duplicated).toEqual([]);
  });

  // Rule 4: shortcuts are spent on convention. Two rows answering the same
  // chord means one of them silently never fires.
  it('never binds one accelerator to two commands', () => {
    const byChord = new Map<string, string[]>();
    for (const { accelerator, label } of collectAccelerators(menus)) {
      const normalized = formatAccelerator(accelerator, platform);
      byChord.set(normalized, [...(byChord.get(normalized) ?? []), label]);
    }
    const collisions = [...byChord.entries()].filter(([, labels]) => labels.length > 1);
    expect(collisions).toEqual([]);
  });

  it('declares a resolvable key for every accelerator', () => {
    for (const { accelerator, label } of collectAccelerators(menus)) {
      const parsed = parseAccelerator(accelerator);
      expect(parsed.key, `${label} has no key in "${accelerator}"`).not.toBe('');
    }
  });

  // The single-window design means a Window menu would have nothing to act on.
  it('has no Window menu', () => {
    expect(menus.map((m) => m.id)).not.toContain('window');
  });

  it('routes every non-role item to a command the renderer can dispatch', () => {
    for (const node of allNodes(menus)) {
      if (node.kind === 'item' && !node.role) {
        expect(node.id).toBeTruthy();
      }
    }
  });
});

describe('menu model — platform shape', () => {
  it('puts Settings and Quit in the app menu on macOS only', () => {
    const mac = buildMenuModel('darwin');
    expect(mac[0].id).toBe('app');
    expect(mac[0].items.some((n) => n.kind === 'item' && n.id === 'app.settings')).toBe(true);
  });

  // Per the design's "match the platform, not the web app": Windows and Linux
  // have no app menu, so those rows come home to File and Help rather than
  // being dropped or ported as a fake mac menu.
  it('folds the app menu into File and Help off macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const menus = buildMenuModel(platform);
      expect(menus.map((m) => m.id)).not.toContain('app');

      const file = menus.find((m) => m.id === 'file')!;
      expect(file.items.some((n) => n.kind === 'item' && n.id === 'app.settings')).toBe(true);

      const help = menus.find((m) => m.id === 'help')!;
      expect(help.items.some((n) => n.kind === 'item' && n.id === 'app.about')).toBe(true);
    }
  });

  it('gives New Chat the bare primary+N, not New Agent', () => {
    const file = buildMenuModel('darwin').find((m) => m.id === 'file')!;
    const newChat = file.items.find((n) => n.kind === 'item' && n.id === 'file.newChat');
    expect(newChat).toMatchObject({ accelerator: 'CmdOrCtrl+N' });
  });

  // ⌘K was spent on New Channel; every peer app uses it for search.
  it('spends the primary+K chord on search', () => {
    const go = buildMenuModel('darwin').find((m) => m.id === 'go')!;
    const search = go.items.find((n) => n.kind === 'item' && n.id === 'go.searchEverything');
    expect(search).toMatchObject({ accelerator: 'CmdOrCtrl+K' });
  });
});
