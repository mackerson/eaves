import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WindowChrome } from './WindowChrome';

/**
 * WindowChrome stands in for the title bar wherever AppLayout isn't rendered
 * (OOBE, pre-hydration). On a frameless window it is the only thing keeping
 * the window movable and closable, so what it renders per platform is the
 * whole contract.
 */
describe('WindowChrome', () => {
  const setPlatform = (platform: string) => {
    (window.electron as any).platform = platform;
  };

  beforeEach(() => {
    (window.electron as any).isWindowMaximized = vi.fn().mockResolvedValue({ maximized: false });
    (window.electron as any).onMaximizeChanged = vi.fn(() => () => {});
  });

  it('owns the caption buttons on Linux, where the window is frameless', () => {
    setPlatform('linux');

    const { container } = render(<WindowChrome />);

    const labels = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Minimize', 'Maximize', 'Close']);
    expect(container.querySelector('.window-chrome')).not.toBeNull();
  });

  it('renders a bare drag strip on Windows, where the OS paints the buttons', () => {
    setPlatform('win32');

    const { container } = render(<WindowChrome />);

    expect(container.querySelector('.window-chrome')).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders nothing on macOS, which keeps its native frame', () => {
    setPlatform('darwin');

    const { container } = render(<WindowChrome />);

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the preload bridge is missing', () => {
    delete (window as any).electron;

    const { container } = render(<WindowChrome />);

    // Assuming Linux here would mount WindowControls, which calls through
    // window.electron unguarded — white-screening the one state that has no
    // ErrorBoundary above it.
    expect(container.firstChild).toBeNull();
  });
});
