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

const params = new URLSearchParams(window.location.search);
const bundleUrl = params.get('bundle') ?? '';
const componentName = params.get('component') ?? '';
const exportType = params.get('exportType') === 'default' ? 'default' : 'named';
const draftName = params.get('name') ?? 'Draft';

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
    root.render(frame(<Failure title="Nothing to preview." detail="This draft declares no UI bundle." />));
    return;
  }

  let Component: React.ComponentType<any>;
  try {
    const module_ = await import(/* @vite-ignore */ bundleUrl);
    const candidate = exportType === 'default' ? module_.default : module_[componentName];
    if (typeof candidate !== 'function') {
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
    root.render(frame(
      <Failure
        title="The bundle failed to load."
        detail={error instanceof Error ? (error.stack || error.message) : String(error)}
      />,
    ));
    return;
  }

  root.render(frame(<Boundary><Component /></Boundary>));
}

void mount();
