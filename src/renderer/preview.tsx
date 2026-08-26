/**
 * The draft preview surface — a whole separate window, on purpose.
 *
 * A plugin UI bundle is `import()`ed into the realm of whatever window renders
 * it. In the main window that is fine for an *installed* plugin: the user
 * approved it. A draft has not been approved, and the dialog that would approve
 * it is reachable from the main window's realm, so previewing a draft there
 * would let unreviewed agent-written code script its own approval. Hence a
 * second window, and hence this entry rather than a route in the app.
 *
 * Two things this deliberately does NOT provide:
 *  - `window.electron`. The window is created with no preload at all, so the
 *    IPC bridge does not exist here. Draft code cannot call `promotePluginDraft`
 *    because there is nothing to call.
 *  - the app's stores. A preview renders; it does not act.
 *
 * A component that throws must be *visible*, not a blank window: the whole
 * point of looking at a preview is to find out whether it works.
 */

import React from 'react';
import ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import './index.css';

// The shims that resolve a bundle's `/node_modules/react` imports read exactly
// these keys (see main/protocols/moduleShim.ts), so the shape has to match the
// main window's — minus `electron` and `stores`, which is the entire point.
(window as any).EavesAPI = {
  React: Object.assign(React, { jsxRuntime }),
  ReactDOM,
  ReactDOMClient,
  UI: {
    Button, Input, Card, CardHeader, CardTitle, CardDescription,
    CardContent, CardFooter, Label, Textarea, Badge, Separator,
  },
  utils: { cn },
};

/**
 * How this window tells main what happened, without gaining a bridge to do it.
 *
 * The whole point of the preview is that this realm has no preload and no IPC,
 * so there is nothing here to send an outcome with. But main owns the
 * BrowserWindow, and a window's console is something main can listen to
 * (`webContents.on('console-message')`). So the report rides out on a console
 * line and costs no new surface at all.
 *
 * Main additionally checks that the line came from *this* bundle rather than
 * from the plugin's — draft code shares this realm and could log the same
 * marker. That is a hardening, not a guarantee: the worst a draft can do is
 * lie about its own render status, which reaches no data and approves nothing.
 */
const RENDER_MARKER = '[eaves:render]';

let failed = false;
let reported = false;

function report(status: 'ok' | 'failed', message?: string): void {
  if (status === 'failed') failed = true;
  else if (failed) return; // never overwrite a failure with a late all-clear
  reported = true;
  const line = `${RENDER_MARKER} ${JSON.stringify({ draftId, status, message })}`;
  if (status === 'failed') console.error(line);
  else console.info(line);
}

/**
 * Silence is the one outcome that helps nobody: a draft that suspends forever,
 * or wedges before React commits, reads as "never previewed" — indistinguishable
 * from one nobody has opened. Say what actually happened instead.
 */
const WATCHDOG_MS = 8000;
setTimeout(() => {
  if (!reported) {
    report('failed', `Nothing rendered within ${WATCHDOG_MS / 1000}s. The component may be suspended or stuck in a loop.`);
  }
}, WATCHDOG_MS);

const params = new URLSearchParams(window.location.search);
const bundleUrl = params.get('bundle') ?? '';
const componentName = params.get('component') ?? '';
const exportType = params.get('exportType') === 'default' ? 'default' : 'named';
const draftName = params.get('name') ?? 'Draft';
const draftId = params.get('draftId') ?? '';

function Banner() {
  return (
    <div style={{
      padding: '8px 14px', fontSize: 12, lineHeight: 1.4,
      background: 'rgba(220, 38, 38, 0.10)', borderBottom: '1px solid rgb(220, 38, 38)',
      color: 'hsl(0 0% 98%)', fontFamily: 'system-ui, sans-serif', flex: '0 0 auto',
    }}>
      <strong>Preview — {draftName}</strong>
      <span style={{ opacity: 0.75 }}>
        {' · '}Not installed. Written by an agent, reviewed by nobody yet. This window has no access
        to your data.
      </span>
    </div>
  );
}

function Failure({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{
      padding: 20, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12, color: 'hsl(0 0% 98%)', whiteSpace: 'pre-wrap', overflow: 'auto',
    }}>
      <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'rgb(248, 113, 113)' }}>{title}</p>
      {detail}
    </div>
  );
}

/**
 * "It rendered" is an effect, not a frame.
 *
 * This used to be a `requestAnimationFrame` after `root.render`, which is two
 * assumptions deep: that a concurrent root has committed by the next frame, and
 * that there *is* a next frame — the window is created `show: false`, and a
 * hidden window's rAF is throttled or parked entirely. A mount effect asks the
 * question React can actually answer, and child effects flush before parent
 * ones, so a component that throws in its own effect has already set `failed`
 * by the time this runs.
 */
function Mounted() {
  React.useEffect(() => { report('ok'); }, []);
  return null;
}

/**
 * Render failures happen after a successful load, so nothing upstream can catch
 * them. Without this the window goes blank and reads as "the preview is broken"
 * rather than "the component is".
 */
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    report('failed', error.stack || error.message);
  }
  render() {
    if (this.state.error) {
      return <Failure title="The component threw while rendering." detail={this.state.error.stack || this.state.error.message} />;
    }
    return <>{this.props.children}</>;
  }
}

async function mount() {
  const root = ReactDOMClient.createRoot(document.getElementById('root')!);
  const frame = (body: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Banner />
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>{body}</div>
    </div>
  );

  if (!bundleUrl || !componentName) {
    report('failed', 'This draft declares no UI bundle.');
    root.render(frame(<Failure title="Nothing to preview." detail="This draft declares no UI bundle." />));
    return;
  }

  let Component: React.ComponentType<any>;
  try {
    const module_ = await import(/* @vite-ignore */ bundleUrl);
    const candidate = exportType === 'default' ? module_.default : module_[componentName];
    if (typeof candidate !== 'function') {
      report('failed', `The bundle has no ${exportType} export "${componentName}". It exports: ${Object.keys(module_).join(', ') || '(nothing)'}`);
      root.render(frame(
        <Failure
          title={`The bundle has no ${exportType} export "${componentName}".`}
          detail={`It exports: ${Object.keys(module_).join(', ') || '(nothing)'}`}
        />,
      ));
      return;
    }
    Component = candidate;
  } catch (error) {
    report('failed', error instanceof Error ? (error.stack || error.message) : String(error));
    root.render(frame(
      <Failure
        title="The bundle failed to load."
        detail={error instanceof Error ? (error.stack || error.message) : String(error)}
      />,
    ));
    return;
  }

  root.render(frame(<><Boundary><Component /></Boundary><Mounted /></>));
}

// Anything React never sees — an async throw inside an effect, a rejected
// promise the component did not handle. Without these a preview can look fine
// and be quietly broken.
window.addEventListener('error', (event) =>
  report('failed', event.error?.stack || event.message),
);
window.addEventListener('unhandledrejection', (event) =>
  report('failed', String((event.reason as Error)?.stack || event.reason)),
);

void mount();
