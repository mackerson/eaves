import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DropdownTerminal, shellQuote } from './DropdownTerminal';

// The real Terminal opens xterm against a live PTY; none of that is what this
// file is about. The stub still reports readiness, since the launch directory
// it hands back is exactly what the drift notice keys off.
let launchCwd: string | undefined;
let terminalMountCount = 0;
vi.mock('./Terminal', () => ({
  default: ({ onReady }: { onReady?: (id: string, cwd?: string) => void }) => {
    React.useEffect(() => {
      terminalMountCount++;
      onReady?.(`term-${terminalMountCount}`, launchCwd);
      // Mount-once semantics, like the real component's creation guard.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="terminal-stub" />;
  },
}));

function panel(container: HTMLElement): HTMLElement {
  // Root → [backdrop, panel]
  return container.firstElementChild!.children[1] as HTMLElement;
}

describe('DropdownTerminal layout', () => {
  beforeEach(() => {
    launchCwd = undefined;
    terminalMountCount = 0;
    (window.electron as any).destroyTerminal = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).writeToTerminal = vi.fn().mockResolvedValue({ success: true });
  });

  /**
   * The header is `justify-content: space-between` with two flex children. A
   * flex item defaults to `min-width: auto` — it refuses to shrink below its
   * content — so on a narrow window the title and the keyboard hint held their
   * full width and ran straight through the button group on the right.
   */
  it('lets the title group shrink and pins the controls', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const header = panel(container).children[0] as HTMLElement;
    const [titleGroup, controls] = [header.children[0], header.children[1]] as HTMLElement[];

    expect(titleGroup.style.minWidth).toBe('0');
    expect(controls.style.flexShrink).toBe('0');
  });

  it('ellipsises the title rather than letting it overflow', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const titleGroup = (panel(container).children[0] as HTMLElement).children[0] as HTMLElement;
    const label = titleGroup.querySelector('span')!;

    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.textOverflow).toBe('ellipsis');
  });

  // A short window can't be handled by the percentage bounds alone: 30% of a
  // 420px window leaves a terminal a few rows tall once the chrome takes its
  // fixed share.
  it('floors the panel height in pixels as well as percent', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const style = panel(container).style;

    expect(style.height).toBe('60vh');
    expect(style.minHeight).toContain('220px');
    expect(style.maxHeight).toBe('100vh');
  });

  // As an absolutely-positioned overlay the strip covered the terminal's bottom
  // rows and swallowed clicks meant for the text underneath.
  it('gives the resize strip its own row instead of overlaying the terminal', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const children = [...panel(container).children] as HTMLElement[];
    const strip = children.find(c => c.title === 'Drag to resize')!;
    const terminalPane = screen.getByTestId('terminal-stub').parentElement!;

    expect(strip.style.position).not.toBe('absolute');
    expect(children.indexOf(strip)).toBeGreaterThan(children.indexOf(terminalPane));
    // Without minHeight:0 the terminal refuses to shrink and pushes the strip
    // off the bottom of a short panel.
    expect(terminalPane.style.minHeight).toBe('0');
  });

  /**
   * The regression this file exists for: the drag effect was keyed off a ref
   * (`if (isDragging.current)`) with `[]` deps, so it ran once at mount when
   * the ref was false, attached nothing, and never re-ran. The handle was
   * inert and the height could never change.
   */
  it('resizes when the handle is dragged', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const strip = ([...panel(container).children] as HTMLElement[])
      .find(c => c.title === 'Drag to resize')!;

    expect(panel(container).style.height).toBe('60vh');

    act(() => { fireEvent.mouseDown(strip, { clientY: 400 }); });
    act(() => { fireEvent.mouseMove(window, { clientY: 400 + window.innerHeight * 0.1 }); });

    expect(panel(container).style.height).toBe('70vh');

    act(() => { fireEvent.mouseUp(window); });
    // Listeners are torn down on mouseup, so a stray move afterwards is inert.
    act(() => { fireEvent.mouseMove(window, { clientY: 900 }); });
    expect(panel(container).style.height).toBe('70vh');
  });

  it('clamps the drag to the allowed range', () => {
    const { container } = render(<DropdownTerminal isOpen onClose={vi.fn()} />);
    const strip = ([...panel(container).children] as HTMLElement[])
      .find(c => c.title === 'Drag to resize')!;

    act(() => { fireEvent.mouseDown(strip, { clientY: 0 }); });
    act(() => { fireEvent.mouseMove(window, { clientY: window.innerHeight * 5 }); });
    expect(panel(container).style.height).toBe('90vh');

    act(() => { fireEvent.mouseMove(window, { clientY: -window.innerHeight * 5 }); });
    expect(panel(container).style.height).toBe('30vh');
  });
});

/**
 * The session survives project switches on purpose — Terminal short-circuits on
 * its creation guard and DropdownTerminal stays mounted to preserve the shell,
 * so the `cwd` prop changing does nothing. That default is right (a sidebar
 * click should not kill a build) but it was silent: the prompt stayed in
 * project A's tree while the app said B, and git/rm/a build hit the wrong
 * checkout with nothing on screen saying so.
 */
describe('DropdownTerminal project drift', () => {
  beforeEach(() => {
    launchCwd = undefined;
    terminalMountCount = 0;
    (window.electron as any).destroyTerminal = vi.fn().mockResolvedValue({ success: true });
    (window.electron as any).writeToTerminal = vi.fn().mockResolvedValue({ success: true });
  });

  const renderAt = (cwd?: string) => {
    launchCwd = cwd;
    return render(<DropdownTerminal isOpen onClose={vi.fn()} cwd={cwd} />);
  };

  it('says nothing while the shell matches the active project', () => {
    renderAt('/home/dev/project-a');
    expect(screen.queryByTestId('terminal-cwd-drift')).toBeNull();
  });

  it('flags the mismatch once the project moves out from under the session', () => {
    const { rerender } = renderAt('/home/dev/project-a');

    rerender(<DropdownTerminal isOpen onClose={vi.fn()} cwd="/home/dev/project-b" />);

    const notice = screen.getByTestId('terminal-cwd-drift');
    expect(notice.textContent).toContain('project-a');
    expect(notice.textContent).toContain('project-b');
  });

  it('cds into the active project on request without killing the shell', () => {
    const { rerender } = renderAt('/home/dev/project-a');
    rerender(<DropdownTerminal isOpen onClose={vi.fn()} cwd="/home/dev/project-b" />);

    act(() => { fireEvent.click(screen.getByText('cd here')); });

    expect(window.electron.writeToTerminal).toHaveBeenCalledWith('term-1', "cd '/home/dev/project-b'\n");
    expect(window.electron.destroyTerminal).not.toHaveBeenCalled();
    // The notice clears; nothing is destroyed.
    expect(screen.queryByTestId('terminal-cwd-drift')).toBeNull();
  });

  it('restarts the shell in the active project on request', async () => {
    const { rerender } = renderAt('/home/dev/project-a');
    rerender(<DropdownTerminal isOpen onClose={vi.fn()} cwd="/home/dev/project-b" />);
    launchCwd = '/home/dev/project-b';

    await act(async () => { fireEvent.click(screen.getByText('Restart')); });

    expect(window.electron.destroyTerminal).toHaveBeenCalledWith('term-1');
    // A fresh Terminal mounted, so a new PTY was spawned — the creation guard
    // only resets on unmount, which is why the remount is keyed.
    expect(terminalMountCount).toBe(2);
    expect(screen.queryByTestId('terminal-cwd-drift')).toBeNull();
  });

  it('stays quiet when there is no project directory to compare against', () => {
    const { rerender } = renderAt('/home/dev/project-a');
    rerender(<DropdownTerminal isOpen onClose={vi.fn()} cwd={undefined} />);
    expect(screen.queryByTestId('terminal-cwd-drift')).toBeNull();
  });
});

// The quoted path is written straight into a live interactive shell, so a
// directory containing a quote, a space or a `;` must not become extra
// commands.
describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('/home/dev/project a')).toBe("'/home/dev/project a'");
  });

  it('neutralises metacharacters', () => {
    expect(shellQuote('/tmp/x; rm -rf /')).toBe("'/tmp/x; rm -rf /'");
    expect(shellQuote('/tmp/$(whoami)')).toBe("'/tmp/$(whoami)'");
  });

  it('escapes an embedded single quote by closing and reopening', () => {
    expect(shellQuote("/home/dev/it's")).toBe(`'/home/dev/it'\\''s'`);
  });
});
