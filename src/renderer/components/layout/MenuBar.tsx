import { useRef, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import {
  type DynamicMenuSource,
  type MenuCommandId,
  type MenuDefinition,
  type MenuNode,
} from '@shared/menuModel';
import { formatAccelerator, type MenuPlatform } from '@shared/accelerators';
import './MenuBar.css';

/**
 * Renders the shared menu model as an in-window menu bar.
 *
 * Purely presentational: it knows how to draw a MenuDefinition and nothing
 * about what the commands do. TopMenuBar supplies the handlers, the checkbox
 * state, and the runtime submenu contents, which keeps command behaviour in
 * one place regardless of whether the native mac menu or this bar fired it.
 *
 * Built on Radix rather than hand-rolled: a menu bar needs roving focus,
 * arrow-key navigation, type-ahead, focus restore and correct submenu
 * timing, and reimplementing that badly is worse than not having it.
 */

export interface DynamicMenuEntry {
  id: string;
  label: string;
  checked?: boolean;
}

export interface MenuBarProps {
  menus: MenuDefinition[];
  platform: MenuPlatform;
  onCommand: (id: MenuCommandId, payload?: { dynamicId?: string }) => void;
  /** Tick state for checkable rows. */
  isChecked: (id: MenuCommandId) => boolean;
  /** Contents for runtime-populated submenus. */
  resolveDynamic: (source: DynamicMenuSource) => DynamicMenuEntry[];
}

/** Which command a dynamic submenu reports through. Mirrors ApplicationMenu. */
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

export function MenuBar({
  menus,
  platform,
  onCommand,
  isChecked,
  resolveDynamic,
}: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Each top-level menu is its own Radix root, so they don't coordinate. When
  // hovering the bar switches menus, the one closing restores focus to its own
  // trigger — which the menu that just opened sees as focus leaving it, and it
  // dismisses itself. Tracking the target synchronously lets the closing menu
  // know it is being replaced rather than genuinely dismissed.
  const openMenuRef = useRef<string | null>(null);
  const setOpen = (id: string | null) => {
    openMenuRef.current = id;
    setOpenMenu(id);
  };

  const renderNodes = (nodes: MenuNode[]) =>
    nodes.map((node, index) => renderNode(node, index));

  const renderNode = (node: MenuNode, index: number) => {
    switch (node.kind) {
      case 'separator':
        return <Dropdown.Separator key={`sep-${index}`} className="menu-dropdown-divider" />;

      case 'item':
        return (
          <Dropdown.Item
            key={`${node.id}-${index}`}
            className="menu-dropdown-item"
            onSelect={() => onCommand(node.id)}
          >
            <span className="menu-item-label">{node.label}</span>
            {node.accelerator && (
              <span className="menu-item-shortcut">
                {formatAccelerator(node.accelerator, platform)}
              </span>
            )}
          </Dropdown.Item>
        );

      case 'checkbox':
        return (
          <Dropdown.CheckboxItem
            key={`${node.id}-${index}`}
            className="menu-dropdown-item menu-dropdown-item-checkable"
            checked={isChecked(node.id)}
            onSelect={(event) => {
              // Keep the menu open so several filters can be toggled at once.
              event.preventDefault();
              onCommand(node.id);
            }}
          >
            <span className="menu-item-check">
              <Dropdown.ItemIndicator>
                <Check size={13} />
              </Dropdown.ItemIndicator>
            </span>
            <span className="menu-item-label">{node.label}</span>
            {node.accelerator && (
              <span className="menu-item-shortcut">
                {formatAccelerator(node.accelerator, platform)}
              </span>
            )}
          </Dropdown.CheckboxItem>
        );

      case 'submenu':
        return (
          <Submenu key={`${node.label}-${index}`} label={node.label}>
            {renderNodes(node.items)}
          </Submenu>
        );

      case 'dynamicSubmenu': {
        const entries = resolveDynamic(node.source);
        const commandId = dynamicCommandId(node.source);
        return (
          <Submenu key={`${node.label}-${index}`} label={node.label}>
            {entries.length === 0 ? (
              // Say why the submenu is empty rather than opening a blank box.
              <Dropdown.Item className="menu-dropdown-item" disabled>
                <span className="menu-item-label">None available</span>
              </Dropdown.Item>
            ) : (
              entries.map((entry) => (
                <Dropdown.Item
                  key={entry.id}
                  className="menu-dropdown-item menu-dropdown-item-checkable"
                  onSelect={() => onCommand(commandId, { dynamicId: entry.id })}
                >
                  <span className="menu-item-check">
                    {entry.checked && <Check size={13} />}
                  </span>
                  <span className="menu-item-label">{entry.label}</span>
                </Dropdown.Item>
              ))
            )}
          </Submenu>
        );
      }
    }
  };

  return (
    <nav className="menu-items">
      {menus.map((menu) => (
        <Dropdown.Root
          key={menu.id}
          open={openMenu === menu.id}
          onOpenChange={(open) => {
            // Ignore a close that a sibling has already superseded, or Radix's
            // own dismissal would clear the menu we just switched to.
            if (!open && openMenuRef.current !== menu.id) return;
            setOpen(open ? menu.id : null);
          }}
          // Non-modal so moving the pointer across the bar can switch menus,
          // the way a real menu bar behaves.
          modal={false}
        >
          <Dropdown.Trigger asChild>
            <button
              className={`menu-button ${openMenu === menu.id ? 'active' : ''}`}
              onPointerEnter={() => {
                // Only track the pointer once a menu is already open.
                if (openMenuRef.current !== null) setOpen(menu.id);
              }}
            >
              {menu.label}
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="menu-dropdown"
              align="start"
              sideOffset={2}
              onCloseAutoFocus={(event) => {
                // Returning focus to the trigger is right when the user
                // genuinely dismissed the menu (Escape, click away), but wrong
                // when another menu has already taken over — it would pull
                // focus out of the new menu and close it.
                if (openMenuRef.current !== null) event.preventDefault();
              }}
            >
              {renderNodes(menu.items)}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ))}
    </nav>
  );
}

function Submenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className="menu-dropdown-item menu-dropdown-subtrigger">
        <span className="menu-item-label">{label}</span>
        <ChevronRight size={13} className="menu-item-chevron" />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className="menu-dropdown" sideOffset={2} alignOffset={-4}>
          {children}
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}
