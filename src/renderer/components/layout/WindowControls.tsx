import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import './WindowControls.css';

/**
 * Minimise / maximise / close for the frameless Linux window.
 *
 * Windows does not render this: there the OS still paints the caption buttons
 * into the Window Controls Overlay and we only tint them. Linux has no such
 * API, so dropping the frame means owning these outright.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.electron.isWindowMaximized().then((s) => setMaximized(s.maximized));
    // The window manager can maximise us without going through the button —
    // tiling shortcuts, double-clicking the drag region, snapping to an edge.
    return window.electron.onMaximizeChanged(({ maximized: next }) => setMaximized(next));
  }, []);

  return (
    <div className="window-controls">
      <button
        className="window-control"
        onClick={() => void window.electron.minimizeWindow()}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus size={15} />
      </button>
      <button
        className="window-control"
        onClick={() => void window.electron.toggleMaximizeWindow()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
      <button
        className="window-control window-control-close"
        onClick={() => void window.electron.closeWindow()}
        aria-label="Close"
        title="Close"
      >
        <X size={15} />
      </button>
    </div>
  );
}
