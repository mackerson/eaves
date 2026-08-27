import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PluginDraft } from '@/../shared/types';

/**
 * What is being built, as one panel rather than a row of cards.
 *
 * There is normally exactly one draft in flight — a person asks for a thing,
 * an agent writes that thing — so rendering a list was answering a question
 * nobody had while leaving the real one ("what IS this, and what will it do to
 * my app?") unanswered. This panel answers that one, in the order a person
 * actually asks it: what state is the build in, what will it be able to do,
 * what did it actually add, and only then the buttons that commit.
 *
 * Everything here is already known to the main process. None of it was shown.
 */

interface Props {
  draft: PluginDraft;
  /** The ask that started this build — the first thing the human said. */
  ask?: string;
  busy: boolean;
  onPreview: () => void;
  onReadCode: () => void;
  onRun: () => void;
  onStop: () => void;
  onKeep: () => void;
  onDiscard: () => void;
}

type StepState = 'done' | 'pending' | 'warn';

function Step({ state, label, detail }: { state: StepState; label: string; detail: string }) {
  const Icon = state === 'done' ? Check : state === 'warn' ? AlertTriangle : Circle;
  const tone =
    state === 'done' ? 'text-emerald-600 dark:text-emerald-400'
    : state === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';

  return (
    <div className="flex items-baseline gap-2 text-sm">
      <Icon className={`w-3.5 h-3.5 flex-shrink-0 self-center ${tone}`} />
      <span className="w-16 flex-shrink-0">{label}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </div>
  );
}

/**
 * One line of "it will be able to…".
 *
 * The three gating kinds are not cosmetic. A gated grant is enforced by
 * PermissionGate; an ungated one is a label on access the plugin takes
 * directly; an inert one is a coarse alias that confers nothing at all.
 * Rendering them identically would describe an enforcement that does not
 * exist — see shared/pluginPermissions.ts.
 */
function Capability({ capability }: { capability: NonNullable<PluginDraft['analysis']>['capabilities'][number] }) {
  const { status, gating, elevated, label, calls } = capability;

  if (gating === 'inert') {
    return (
      <li className="text-xs text-muted-foreground">
        <span className="line-through">{label}</span>
        {' — '}a coarse alias the sandbox never matches. It grants nothing.
      </li>
    );
  }

  const unused = status === 'declared-unused';
  const tone = unused
    ? 'text-muted-foreground'
    : elevated
      ? 'text-amber-600 dark:text-amber-400'
      : '';

  return (
    <li className={`text-sm ${tone}`}>
      <span className="mr-1.5">{unused ? '○' : elevated ? '⚠' : '✓'}</span>
      {label}
      {unused && <span className="text-xs"> — declared, never used</span>}
      {gating === 'ungated' && !unused && (
        <span className="text-xs"> — taken directly, not mediated by the sandbox</span>
      )}
      {calls.length > 0 && (
        <div className="ml-5 mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
          {calls.join('\n')}
        </div>
      )}
    </li>
  );
}

export function DraftManifest({
  draft, ask, busy, onPreview, onReadCode, onRun, onStop, onKeep, onDiscard,
}: Props) {
  const analysis = draft.analysis;
  const contributions = draft.contributions;
  const undeclared = analysis?.undeclared ?? [];
  const hasUi = !!draft.bundleUrl;

  const renderState: StepState =
    !hasUi ? 'done'
    : draft.lastRender?.status === 'ok' ? 'done'
    : draft.lastRender?.status === 'failed' ? 'warn'
    : 'pending';

  const renderDetail =
    !hasUi ? 'no UI to render'
    : draft.lastRender?.status === 'ok' ? 'previewed cleanly'
    : draft.lastRender?.status === 'failed' ? 'preview failed'
    : 'nobody has looked yet';

  return (
    <div className="space-y-5">
      {ask && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">You asked for</h3>
          <p className="text-sm italic">“{ask}”</p>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Being built</h3>
          <span className="text-sm font-medium truncate">
            {draft.name} <span className="text-muted-foreground font-normal">v{draft.version}</span>
          </span>
        </div>
        {draft.description && (
          <p className="text-xs text-muted-foreground mb-2">{draft.description}</p>
        )}
        <div className="space-y-1">
          <Step state="done" label="written" detail={`${draft.files.length} file${draft.files.length === 1 ? '' : 's'}`} />
          <Step
            state={draft.running ? 'done' : 'pending'}
            label="running"
            detail={draft.running ? 'sandboxed worker up' : 'staged, not started'}
          />
          <Step state={renderState} label="renders" detail={renderDetail} />
          {/* Never 'done'. Keeping a draft installs it, and an installed
              plugin is not a draft — it leaves this panel entirely. The step
              exists to say what has not happened yet. */}
          <Step state="pending" label="kept" detail="not installed" />
        </div>
      </section>

      {draft.lastRender?.status === 'failed' && (
        <section className="p-2.5 rounded border border-red-500/40 bg-red-500/10">
          <p className="text-xs font-medium text-red-500 dark:text-red-400">Preview failed to render</p>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground max-h-32 overflow-y-auto">
            {draft.lastRender.message}
          </pre>
        </section>
      )}

      {/* A call the manifest never declared is not a style note: PermissionGate
          denies it, so the plugin throws the first time that path runs. Said
          before it is kept, rather than discovered after. */}
      {undeclared.length > 0 && (
        <section className="p-2.5 rounded border border-amber-500/40 bg-amber-500/10">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {undeclared.length === 1 ? 'A call' : `${undeclared.length} calls`} the sandbox will refuse
          </p>
          <ul className="mt-1 space-y-1">
            {undeclared.map((entry) => (
              <li key={entry.call} className="text-[11px] text-muted-foreground">
                <span className="font-mono break-all">{entry.call}</span> in {entry.file} — needs{' '}
                {entry.requires.join(' and ')}, which the manifest does not declare.
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis && analysis.capabilities.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
            It will be able to
          </h3>
          <ul className="space-y-1.5">
            {analysis.capabilities.map((capability) => (
              <Capability key={capability.permission} capability={capability} />
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground mt-2">
            Read from the source, not proven — a call inside a comment counts. Read the code before
            you keep it.
          </p>
        </section>
      )}

      {analysis && analysis.capabilities.length === 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
            It will be able to
          </h3>
          <p className="text-sm text-muted-foreground">
            Nothing it has to ask for. This plugin declares no permissions at all.
          </p>
        </section>
      )}

      {/* What it actually added, once it ran — as opposed to what it said it
          would. Empty before activation by definition, which is a different
          statement from "it adds nothing". */}
      {draft.running && contributions && (contributions.tools.length > 0 || contributions.views.length > 0) && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
            What it added
          </h3>
          <div className="space-y-2">
            {contributions.tools.map((tool) => (
              <div key={tool.name} className="text-sm">
                <span className="font-mono text-xs">
                  {tool.name}({tool.parameters.join(', ')})
                </span>
                <p className="text-xs text-muted-foreground">{tool.description}</p>
              </div>
            ))}
            {contributions.views.map((view) => (
              <div key={view.id} className="text-sm">
                {view.icon && <span className="mr-1.5">{view.icon}</span>}
                {view.title}
                <span className="text-xs text-muted-foreground">
                  {' '}— a view. Drafts never appear in the sidebar; use Preview.
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {draft.running && contributions && contributions.tools.length === 0 && contributions.views.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Running, but it registered no tools and no views.
        </p>
      )}

      <section className="space-y-2 pt-1">
        <div className="flex flex-wrap gap-1.5">
          {hasUi && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onPreview}>
              Preview
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={onReadCode}>
            Read the code
          </Button>
          {draft.running ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onStop}>Stop</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRun}>Run</Button>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" className="flex-1" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" className="flex-1" disabled={busy} onClick={onKeep}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Keep'}
          </Button>
        </div>
      </section>
    </div>
  );
}
