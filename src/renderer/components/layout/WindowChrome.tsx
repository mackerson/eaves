import { WindowControls } from './WindowControls';
import './WindowChrome.css';

/**
 * The caption row for app states that render outside `AppLayout`.
 *
 * `TopMenuBar` is the title bar for the app proper — it carries the drag
 * region and, on Linux, the caption buttons. Anything rendered instead of the
 * layout (the OOBE wizard, the pre-hydration blank) therefore has no title bar
 * at all, and on a frameless Linux window that leaves no way to move, maximise
 * or close it. This is the minimum that keeps the window operable.
 *
 * macOS renders nothing: it keeps its native frame, so the traffic lights are
 * already there. Windows gets the drag strip but no buttons — the OS paints
 * those into the Window Controls Overlay.
 */
export function WindowChrome() {
  const platform = window.electron?.platform;

  // No bridge means no window controls to drive — and the Linux branch below
  // is the one that calls through `window.electron` unguarded, so defaulting
  // to it was the one choice that could white-screen the pre-hydration state.
  if (!platform || platform === 'darwin') return null;

  return (
    <div className="window-chrome">
      {platform === 'linux' && <WindowControls />}
    </div>
  );
}
