/**
 * DropdownTerminal Component
 * Drop-down terminal overlay that slides down over the app
 * Toggle with Cmd+` (Mac) or Ctrl+` (Windows/Linux)
 */

import React, { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import Terminal from './Terminal';

export interface DropdownTerminalProps {
  isOpen: boolean;
  onClose: () => void;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

// Theme object defined outside component to avoid recreating on every render
const DROPDOWN_TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  selection: '#264f78',
};

const MIN_HEIGHT_PCT = 30;
const MAX_HEIGHT_PCT = 90;
/**
 * Floor in pixels as well as percent. 30% of a 420px-tall window is 126px, and
 * the header and resize strip take a fixed ~39px of that — leaving a terminal
 * a few rows tall that its own scrollback immediately overruns. `min()` keeps
 * the floor from exceeding a genuinely tiny window, where overflowing past the
 * bottom edge would be worse than being short.
 */
const MIN_HEIGHT_PX = 220;
const RESIZE_STRIP_PX = 6;

const clampHeight = (pct: number) => Math.min(MAX_HEIGHT_PCT, Math.max(MIN_HEIGHT_PCT, pct));

/** Last path segment — enough to recognise a directory without eating the header. */
function basename(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || dir;
}

/**
 * POSIX single-quote so a directory with a space, `$`, or `;` in it can't turn
 * a `cd` into arbitrary shell. Single quotes suppress every expansion; the only
 * character needing care is `'` itself, closed and re-escaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const driftButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  background: 'none',
  border: '1px solid #5c4d2a',
  color: '#e0cfa0',
  cursor: 'pointer',
  fontSize: '11px',
  padding: '2px 8px',
  borderRadius: '3px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

export const DropdownTerminal: React.FC<DropdownTerminalProps> = ({
  isOpen,
  onClose,
  command, // undefined = use system default shell
  args = [],
  cwd,
  env,
}) => {
  const [height, setHeight] = useState(60); // Percentage of viewport
  const [hasSession, setHasSession] = useState(false); // Track if terminal session exists
  // Where the live shell was started, as resolved by the main process. Only
  // the launch directory is knowable from here — a `cd` typed into the shell
  // is invisible to us — so the UI says "started in", never "is in".
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  // Bumping this remounts Terminal, which is the only way to get a new PTY.
  const [terminalKey, setTerminalKey] = useState(0);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false); // Show close confirmation
  const terminalIdRef = useRef<string | null>(null); // Store terminal ID for cleanup
  const containerRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the drag listeners are attached by an effect, and an
  // effect cannot observe a ref changing. Keyed off a ref, the effect ran once
  // at mount with `isDragging.current === false`, never attached anything, and
  // never re-ran — so the resize handle did nothing at all and the terminal
  // was permanently stuck at its initial height.
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Handle terminal ready callback
  const handleTerminalReady = (terminalId: string, launchCwd?: string) => {
    terminalIdRef.current = terminalId;
    setSessionCwd(launchCwd ?? null);
    setHasSession(true);
  };

  // Handle close terminal confirmation
  const handleCloseTerminal = async () => {
    if (!terminalIdRef.current) return;

    setShowCloseConfirm(false);
    setHasSession(false);
    setSessionCwd(null);

    // Destroy terminal session
    await window.electron.destroyTerminal(terminalIdRef.current);
    terminalIdRef.current = null;
  };

  /**
   * The session keeps running across project switches — `Terminal` short-
   * circuits on `hasCreatedTerminal` and this component deliberately stays
   * mounted to preserve it, so the `cwd` prop changing does nothing. That is a
   * reasonable default (nobody wants a build killed by a sidebar click) but it
   * used to be invisible: the prompt stayed in project A's tree while the app
   * said B, and `git`, `rm` or a build hit the wrong checkout with nothing on
   * screen saying so. Surface the mismatch and offer both ways out.
   */
  const drifted = !!(hasSession && cwd && sessionCwd && cwd !== sessionCwd);

  const handleCdToProject = () => {
    if (!terminalIdRef.current || !cwd) return;
    window.electron.writeToTerminal(terminalIdRef.current, `cd ${shellQuote(cwd)}\n`);
    setSessionCwd(cwd);
  };

  const handleRestartHere = async () => {
    const id = terminalIdRef.current;
    setHasSession(false);
    setSessionCwd(null);
    terminalIdRef.current = null;
    if (id) await window.electron.destroyTerminal(id);
    // Remount Terminal so it spawns a fresh PTY — its creation effect is
    // guarded by a ref that only resets on unmount.
    setTerminalKey(k => k + 1);
  };

  // Handle ESC key to hide (not close)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !showCloseConfirm) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showCloseConfirm]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Drag handle logic for height adjustment
  const handleDragStart = (e: React.MouseEvent) => {
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;
    setDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;

    const handleDragMove = (e: MouseEvent) => {
      const deltaPercent = ((e.clientY - dragStartY.current) / window.innerHeight) * 100;
      setHeight(clampHeight(dragStartHeight.current + deltaPercent));
    };

    const handleDragEnd = () => setDragging(false);

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };
  }, [dragging]);


  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        pointerEvents: isOpen ? 'auto' : 'none',
        visibility: hasSession || isOpen ? 'visible' : 'hidden', // Always visible if session exists
        // Now that the handle actually works, a drag across the terminal would
        // otherwise select its text on the way past.
        userSelect: dragging ? 'none' : undefined,
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          opacity: isOpen ? 1 : 0,
          transition: 'opacity 0.2s ease-in-out',
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
      />

      {/* Terminal Container */}
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: `${clampHeight(height)}vh`,
          minHeight: `min(${MIN_HEIGHT_PX}px, 100vh)`,
          maxHeight: '100vh',
          backgroundColor: '#1e1e1e',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
          transform: isOpen ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex',
          flexDirection: 'column',
          borderBottom: '1px solid #3e3e42',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 16px',
            backgroundColor: '#252526',
            borderBottom: '1px solid #3e3e42',
            color: '#cccccc',
            fontSize: '13px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            gap: '8px',
          }}
        >
          {/*
            minWidth: 0 is what stops the title running under the buttons on a
            narrow window. A flex item defaults to `min-width: auto`, i.e. it
            refuses to shrink below its content — so "Dropdown Terminal  Ctrl+`
            to toggle" held its full width and the space-between layout pushed
            it straight through the button group on the right.
          */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Zap size={16} style={{ flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Dropdown Terminal
            </span>
            {/* First thing to go when space runs out — it's a reminder, not a control. */}
            {sessionCwd ? (
              <span
                style={{
                  opacity: 0.6,
                  fontSize: '11px',
                  fontFamily: 'Menlo, Monaco, monospace',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flexShrink: 100,
                }}
                title={`Shell started in ${sessionCwd}`}
              >
                {basename(sessionCwd)}
              </span>
            ) : (
              <span
                style={{
                  opacity: 0.5,
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flexShrink: 100,
                }}
              >
                {navigator.platform.includes('Mac') ? 'Cmd+`' : 'Ctrl+`'} to toggle
              </span>
            )}
          </div>
          {/* The controls never shrink — losing the close button is not an option. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {hasSession && (
              <button
                onClick={() => setShowCloseConfirm(true)}
                style={{
                  background: 'none',
                  border: '1px solid #3e3e42',
                  color: '#cccccc',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '4px 8px',
                  borderRadius: '3px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
                title="Close terminal session"
              >
                Close Terminal
              </button>
            )}
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#cccccc',
                cursor: 'pointer',
                fontSize: '20px',
                padding: '0 4px',
                lineHeight: 1,
              }}
              title="Hide (ESC)"
            >
              ×
            </button>
          </div>
        </div>

        {/* Project-drift notice. Never acts on its own — a running build must
            not be interrupted, and a `cd` written into a shell with something
            in the foreground would land in that process's stdin. */}
        {drifted && (
          <div
            data-testid="terminal-cwd-drift"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 16px',
              backgroundColor: '#3a3222',
              borderBottom: '1px solid #5c4d2a',
              color: '#e0cfa0',
              fontSize: '11px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              flexShrink: 0,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              This shell started in <code>{basename(sessionCwd!)}</code> — the active project is{' '}
              <code>{basename(cwd!)}</code>.
            </span>
            <button
              onClick={handleCdToProject}
              style={driftButtonStyle}
              title={`cd ${cwd}`}
            >
              cd here
            </button>
            <button onClick={handleRestartHere} style={driftButtonStyle} title="Kill this shell and start a new one in the active project">
              Restart
            </button>
          </div>
        )}

        {/* Terminal. minHeight: 0 lets this flex child actually shrink — without
            it a flex item won't go below its content height, so the terminal
            pushed the resize strip off the bottom of a short panel. */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Always render terminal once created to preserve session */}
          {(hasSession || isOpen) && (
            <Terminal
              key={terminalKey}
              command={command}
              args={args}
              cwd={cwd}
              env={env}
              theme={DROPDOWN_TERMINAL_THEME}
              fontFamily="Menlo, Monaco, 'Courier New', monospace"
              fontSize={14}
              onReady={handleTerminalReady}
            />
          )}
        </div>

        {/* Resize strip. A real flex child at the end of the column rather than
            an absolutely-positioned overlay: as an overlay it sat on top of the
            terminal's bottom rows, hiding output and swallowing clicks meant
            for the text underneath. */}
        <div
          onMouseDown={handleDragStart}
          style={{
            flexShrink: 0,
            height: `${RESIZE_STRIP_PX}px`,
            cursor: 'ns-resize',
            backgroundColor: '#1e1e1e',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title="Drag to resize"
        >
          <div
            style={{
              width: '40px',
              height: '3px',
              backgroundColor: '#3e3e42',
              borderRadius: '2px',
            }}
          />
        </div>

        {/* Close Confirmation Dialog */}
        {showCloseConfirm && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 20,
            }}
            onClick={() => setShowCloseConfirm(false)}
          >
            <div
              style={{
                backgroundColor: '#252526',
                border: '1px solid #3e3e42',
                borderRadius: '6px',
                padding: '24px',
                maxWidth: '400px',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  color: '#cccccc',
                  fontSize: '16px',
                  marginBottom: '12px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  fontWeight: 600,
                }}
              >
                Close Terminal Session?
              </div>
              <div
                style={{
                  color: '#999999',
                  fontSize: '13px',
                  marginBottom: '24px',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  lineHeight: 1.5,
                }}
              >
                This will terminate the running process and clear the terminal history. You can hide the terminal with ESC or × to preserve the session.
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowCloseConfirm(false)}
                  style={{
                    background: 'none',
                    border: '1px solid #3e3e42',
                    color: '#cccccc',
                    cursor: 'pointer',
                    fontSize: '13px',
                    padding: '6px 16px',
                    borderRadius: '3px',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCloseTerminal}
                  style={{
                    background: '#c94c4c',
                    border: 'none',
                    color: '#ffffff',
                    cursor: 'pointer',
                    fontSize: '13px',
                    padding: '6px 16px',
                    borderRadius: '3px',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                  }}
                >
                  Close Terminal
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DropdownTerminal;
