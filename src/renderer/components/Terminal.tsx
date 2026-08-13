/**
 * Terminal Component
 * Embedded terminal using xterm.js with PTY backend
 */

import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

export interface TerminalProps {
  /**
   * Terminal ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * Command to run (default: system shell)
   */
  command?: string;

  /**
   * Command arguments
   */
  args?: string[];

  /**
   * Working directory
   */
  cwd?: string;

  /**
   * Environment variables
   */
  env?: Record<string, string>;

  /**
   * Terminal theme
   */
  theme?: {
    background?: string;
    foreground?: string;
    cursor?: string;
    selection?: string;
  };

  /**
   * Font family
   */
  fontFamily?: string;

  /**
   * Font size
   */
  fontSize?: number;

  /**
   * Called when the PTY is up. `launchCwd` is the directory the shell was
   * actually started in, resolved by the main process — `cwd` is only a
   * request and falls back to the home directory when undefined, so the
   * caller cannot work this out for itself.
   */
  onReady?: (terminalId: string, launchCwd?: string) => void;

  /**
   * Called when terminal exits
   */
  onExit?: (code: number) => void;
}

/**
 * Terminal component with xterm.js
 */
export const Terminal: React.FC<TerminalProps> = ({
  id,
  command,
  args,
  cwd,
  env,
  theme,
  fontFamily = 'Menlo, Monaco, "Courier New", monospace',
  fontSize = 14,
  onReady,
  onExit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminalId] = useState(() => id || crypto.randomUUID());
  const [, setIsReady] = useState(false);
  const hasCreatedTerminal = useRef(false);
  const cleanupFunctionsRef = useRef<Array<() => void>>([]);
  const mountCountRef = useRef(0);

  // Stabilize theme object to prevent unnecessary re-renders
  const stableTheme = React.useMemo(() => ({
    background: theme?.background || '#1e1e1e',
    foreground: theme?.foreground || '#d4d4d4',
    cursor: theme?.cursor || '#ffffff',
    selection: theme?.selection || '#264f78',
  }), [theme?.background, theme?.foreground, theme?.cursor, theme?.selection]);

  // Stabilize args array to prevent recreation on reference change
  const stableArgs = React.useMemo(() => args || [], [args ? args.join(',') : '']);

  // Stabilize env object to prevent recreation on reference change
  const stableEnv = React.useMemo(() => env, [env ? JSON.stringify(env) : '']);

  useEffect(() => {
    if (!containerRef.current) return;

    // Skip if we've already created this terminal (React Strict Mode double-mount)
    if (hasCreatedTerminal.current) {
      return;
    }

    hasCreatedTerminal.current = true;

    // Create xterm instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontFamily,
      fontSize,
      theme: stableTheme,
      allowProposedApi: true,
    });

    // Add fit addon for auto-sizing
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    // Add web links addon for clickable URLs
    const webLinksAddon = new WebLinksAddon();
    xterm.loadAddon(webLinksAddon);

    // Open terminal in container
    xterm.open(containerRef.current);

    // Store refs
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Fit to container after DOM is ready (next tick)
    // This prevents "Cannot read properties of undefined (reading 'dimensions')" error
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    // Create PTY process in main
    window.electron
      .createTerminal(terminalId, {
        command,
        args: stableArgs,
        cwd,
        env: stableEnv,
        cols: xterm.cols,
        rows: xterm.rows,
      })
      .then((result) => {
        if (result.success) {
          setIsReady(true);
          onReady?.(terminalId, result.cwd);
        } else {
          console.error('[Terminal] Failed to create PTY:', result.error);
          xterm.writeln(`\x1b[31mError: ${result.error}\x1b[0m`);
        }
      });

    // Listen for data from PTY
    const dataListener = (data: string) => {
      xterm.write(data);
      // Auto-scroll to bottom on new output
      // This prevents the terminal from jumping around when new output arrives
      xterm.scrollToBottom();
    };
    window.electron.on(`terminal:data:${terminalId}`, dataListener);

    // Listen for exit
    const exitListener = ({ exitCode }: { exitCode: number; signal?: number }) => {
      xterm.writeln(`\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`);
      onExit?.(exitCode);
    };
    window.electron.on(`terminal:exit:${terminalId}`, exitListener);

    // Send user input to PTY
    const disposable = xterm.onData((data) => {
      window.electron.writeToTerminal(terminalId, data);
    });

    // Handle terminal resize
    const resizeDisposable = xterm.onResize(({ cols, rows }) => {
      window.electron.resizeTerminal(terminalId, cols, rows);
    });

    // Fit terminal on window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    // Store cleanup functions to run on true unmount
    cleanupFunctionsRef.current = [
      () => window.removeEventListener('resize', handleResize),
      () => disposable.dispose(),
      () => resizeDisposable.dispose(),
      () => window.electron.off(`terminal:data:${terminalId}`, dataListener),
      () => window.electron.off(`terminal:exit:${terminalId}`, exitListener),
      () => window.electron.destroyTerminal(terminalId),
      () => xterm.dispose(),
    ];

    // No cleanup in effect return - we handle it in a separate effect
    return () => {
    };
    // Only recreate terminal when core params change (not theme/font)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, command, stableArgs, cwd, stableEnv]);

  // Cleanup on true unmount (separate from main effect to avoid Strict Mode issues)
  useEffect(() => {
    // Increment mount counter on each mount
    mountCountRef.current++;
    const currentMountCount = mountCountRef.current;

    return () => {

      // In Strict Mode, component mounts twice (mountCount 1, then 2)
      // Only run cleanup if this is the second unmount (mountCount >= 2)
      // OR if we're in production (no Strict Mode)
      const isDev = import.meta.env.DEV;

      if (isDev && currentMountCount === 1) {
        return;
      }

      // Real unmount - run cleanup
      if (!hasCreatedTerminal.current || cleanupFunctionsRef.current.length === 0) {
        return;
      }

      cleanupFunctionsRef.current.forEach(fn => fn());
      cleanupFunctionsRef.current = [];
      hasCreatedTerminal.current = false;
    };
  }, []);

  // Fit terminal when container size changes
  useEffect(() => {
    if (!fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    />
  );
};

export default Terminal;
