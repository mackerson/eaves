import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentConfig, ProviderConfig } from './OOBEWizard';

interface OOBECompleteStepProps {
  agentConfig: AgentConfig;
  providerConfig: ProviderConfig;
  onComplete: (guidedTour: boolean) => Promise<void>;
}

export function OOBECompleteStep({ agentConfig, providerConfig, onComplete }: OOBECompleteStepProps) {
  const [launching, setLaunching] = useState<'tour' | 'plain' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleLaunch = async (guidedTour: boolean) => {
    setLaunching(guidedTour ? 'tour' : 'plain');
    setError(null);
    try {
      await onComplete(guidedTour);
    } catch (err) {
      // Final-step failures (agent creation, settings write) must not fail
      // silently — surface it so the user can retry instead of a dead button.
      setError(err instanceof Error ? err.message : 'Setup failed — please try again.');
      setLaunching(null);
    }
  };

  return (
    <div className="p-8 space-y-8 text-center">
      <div className="space-y-3">
        <div
          className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center text-3xl font-bold shadow-lg"
          style={{ backgroundColor: agentConfig.color }}
        >
          {agentConfig.name.charAt(0).toUpperCase()}
        </div>
        <h2
          className="text-2xl font-bold"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          Meet {agentConfig.name}
        </h2>
        <p
          className="text-sm max-w-md mx-auto"
          style={{ color: 'var(--text-secondary, #999)' }}
        >
          {agentConfig.description}
        </p>
      </div>

      <div
        className="rounded-lg p-4 text-left text-sm space-y-2 max-w-md mx-auto"
        style={{
          backgroundColor: 'var(--bg-tertiary, #1a1a24)',
          color: 'var(--text-secondary, #aaa)',
        }}
      >
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-tertiary, #666)' }}>Provider</span>
          <span>{providerConfig.provider}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-tertiary, #666)' }}>Model</span>
          <span className="text-xs">{providerConfig.model}</span>
        </div>
        <div className="flex justify-between">
          <span style={{ color: 'var(--text-tertiary, #666)' }}>Temperature</span>
          <span>{agentConfig.temperature.toFixed(1)}</span>
        </div>
      </div>

      {/*
        The tour is offered rather than imposed. It opens a first chat with a
        message written in the user's own voice and spends a real API call, so
        it should be something they chose — and someone who already knows the
        app should not have to sit through one.
      */}
      <div className="space-y-3">
        <Button
          onClick={() => handleLaunch(true)}
          disabled={launching !== null}
          size="lg"
          className="px-10"
          style={{
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          }}
        >
          {launching === 'tour'
            ? 'Setting up...'
            : error ? 'Try again' : `Launch and let ${agentConfig.name} show me around`}
        </Button>
        <div>
          <button
            type="button"
            onClick={() => handleLaunch(false)}
            disabled={launching !== null}
            className="text-xs underline underline-offset-4 disabled:opacity-40 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-tertiary, #666)' }}
          >
            {launching === 'plain' ? 'Setting up…' : 'Just launch — I’ll explore on my own'}
          </button>
        </div>
        {error && (
          <p className="text-sm" style={{ color: 'var(--status-error, #ef4444)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
