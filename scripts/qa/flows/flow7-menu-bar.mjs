#!/usr/bin/env node
/**
 * Flow 7 — menu bar interaction: the open/switch/dismiss contract.
 *
 * Each top-level menu is its own Radix root, so nothing coordinates them —
 * the bar's "click to open, then hover to switch" behaviour is assembled by
 * hand in MenuBar.tsx and is easy to break from either side.
 *
 * The regression this exists for: switching by hover used to open the next
 * menu and then dismiss it ~half a second later, because the menu that was
 * closing restored focus to its own trigger and the newly opened menu read
 * that as focus leaving it. It looked like the menu "closed itself" and had
 * to be clicked again.
 *
 * Contract characterized:
 *  - clicking a trigger opens that menu; hovering the bar with nothing open
 *    does NOT (this is a menu bar, not a hover menu)
 *  - hovering a sibling while open switches to it AND STAYS OPEN
 *  - submenus still open after a hover-switch
 *  - Escape closes and returns focus to the trigger (suppressing focus
 *    return during a switch must not cost keyboard users the normal case)
 *  - clicking the open menu's own trigger toggles it shut
 *  - choosing an item closes the menu and runs the command
 *
 * Needs real input events — synthetic pointerenter does not bubble, so React's
 * delegated handler never sees it and the bug cannot be reproduced from
 * Runtime.evaluate alone.
 */

import { openHarness, makeReport, sleep } from './lib.mjs';

const report = makeReport('flow7-menu-bar');
const { cdp } = await openHarness();

const mouse = (type, x, y, extra = {}) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, buttons: 0, ...extra });
const move = (x, y) => mouse('mouseMoved', x, y);
const click = async (x, y) => {
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
};
const pressEscape = async () => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
};

const openPanels = async () => Number(await cdp.evaljs('document.querySelectorAll(".menu-dropdown").length'));
const firstPanelText = async () =>
  String(await cdp.evaljs('([...document.querySelectorAll(".menu-dropdown")][0]?.textContent || "").slice(0, 16)'));

/**
 * Centre point of an element, or null when it isn't there.
 *
 * Returns rather than throws: a missing element usually means an earlier
 * assertion already failed, and crashing here would hide every check below it.
 */
const centreOf = async (selectorExpr) => {
  const raw = await cdp.evaljs(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
};

const trigger = async (name) => {
  const at = await centreOf(
    `[...document.querySelectorAll(".menu-items .menu-button")].find(b => b.textContent.trim() === ${JSON.stringify(name)})`,
  );
  if (!at) {
    report.assert(`the ${name} menu exists in the bar`, false);
    report.finish();
  }
  return at;
};

/** Click a neutral area so each assertion starts from a closed bar. */
const reset = async () => {
  await click(400, 500);
  await sleep(400);
};

try {
  // macOS has no in-window bar — the native menu owns it there.
  const platform = await cdp.evaljs('window.electron?.platform');
  if (platform === 'darwin') {
    report.skip('menu bar interaction', 'macOS uses the native application menu');
    report.finish();
  }

  await cdp.send('Page.bringToFront', {});
  await reset();

  const file = await trigger('File');
  const edit = await trigger('Edit');
  const view = await trigger('View');

  // Hovering the bar with nothing open must not open anything.
  await move(view.x, view.y);
  await sleep(500);
  report.assert('hover with nothing open does not open a menu', (await openPanels()) === 0);

  await click(file.x, file.y);
  await sleep(400);
  report.assert('clicking a trigger opens its menu', (await openPanels()) === 1 && /New Chat/.test(await firstPanelText()));

  // The regression: switch by hover, then wait past the point where the old
  // behaviour dismissed the new menu.
  await move((file.x + edit.x) / 2, edit.y);
  await sleep(60);
  await move(edit.x, edit.y);
  await sleep(150);
  const switchedPromptly = (await openPanels()) === 1 && /Undo/.test(await firstPanelText());
  await sleep(700);
  const stillOpen = (await openPanels()) === 1 && /Undo/.test(await firstPanelText());
  report.assert('hovering a sibling switches to it', switchedPromptly);
  report.assert('the switched-to menu stays open', stillOpen, 'it dismissed itself — focus is being pulled out of the new menu');

  // A second switch must work too; the bug left the bar unable to switch again.
  await move(view.x, view.y);
  await sleep(600);
  report.assert('a second hover-switch works', (await openPanels()) === 1 && /Toggle Sidebar/.test(await firstPanelText()));

  const appearance = await centreOf(
    '[...document.querySelectorAll(".menu-dropdown-subtrigger")].find(e => /Appearance/.test(e.textContent))',
  );
  if (!appearance) {
    report.assert('a submenu opens after a hover-switch', false, 'View menu was not open, so its submenu trigger was unreachable');
  } else {
    await move(appearance.x, appearance.y);
    await sleep(800);
    const subOpen = (await openPanels()) === 2;
    await sleep(500);
    report.assert('a submenu opens after a hover-switch', subOpen && (await openPanels()) === 2);
  }

  await reset();
  await click(file.x, file.y);
  await sleep(400);
  await pressEscape();
  await sleep(400);
  report.assert('Escape closes the menu', (await openPanels()) === 0);
  report.assert(
    'Escape returns focus to the trigger',
    (await cdp.evaljs('document.activeElement?.textContent?.trim()')) === 'File',
    'focus suppression during a switch must not leak into normal dismissal',
  );

  await reset();
  await click(file.x, file.y);
  await sleep(400);
  await click(file.x, file.y);
  await sleep(400);
  report.assert('clicking the open menu\'s trigger closes it', (await openPanels()) === 0);

  await reset();
  await click(file.x, file.y);
  await sleep(400);
  await move(edit.x, edit.y);
  await sleep(500);
  await click(400, 500);
  await sleep(500);
  report.assert('clicking away after a switch closes the bar', (await openPanels()) === 0);

  await reset();
  await click(file.x, file.y);
  await sleep(400);
  const importRow = await centreOf(
    '[...document.querySelectorAll(".menu-dropdown-item")].find(e => /^Import/.test(e.textContent))',
  );
  if (!importRow) {
    report.assert('choosing an item closes the menu', false, 'File menu did not open');
    report.assert('choosing an item runs its command', false, 'File menu did not open');
  } else {
    await move(importRow.x, importRow.y);
    await sleep(80);
    await click(importRow.x, importRow.y);
    await sleep(700);
    report.assert('choosing an item closes the menu', (await openPanels()) === 0);
    report.assert(
      'choosing an item runs its command',
      /import/i.test(String(await cdp.evaljs('document.querySelector(".view-content")?.innerText?.slice(0, 40) || ""'))),
    );
  }

  await reset();
} finally {
  cdp.close();
}

report.finish();
