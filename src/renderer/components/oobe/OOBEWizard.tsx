import { useState, useCallback, useEffect } from 'react';
import { unwrapIpc } from '@/lib/ipcEnvelope';
import { completeOobeSetup } from './completeOobeSetup';
import { OOBEWelcomeStep } from './OOBEWelcomeStep';
import { OOBEProviderStep } from './OOBEProviderStep';
import { OOBEAgentStep } from './OOBEAgentStep';
import { OOBECompleteStep } from './OOBECompleteStep';

import type { ProviderId } from '@shared/providers';

export interface OOBEDefaults {
  userName: string | null;
  apiKeys: Partial<Record<ProviderId, string | null>>;
}

export type OOBEStep = 0 | 1 | 2 | 3;

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  availableModels: string[];
}

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  temperature: number;
  color: string;
}

interface OOBEWizardProps {
  onComplete: () => Promise<void>;
}

const STEP_LABELS = ['Welcome', 'Provider', 'Agent', 'Ready'];

export function OOBEWizard({ onComplete }: OOBEWizardProps) {
  const [step, setStep] = useState<OOBEStep>(0);
  const [userName, setUserName] = useState('');
  const [providerConfig, setProviderConfig] = useState<ProviderConfig | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [defaults, setDefaults] = useState<OOBEDefaults>({ userName: null, apiKeys: {} });

  useEffect(() => {
    window.electron.getOobeDefaults()
      .then(setDefaults)
      .catch(() => { /* no-op: defaults are a dev convenience */ });
  }, []);

  const handleWelcomeNext = useCallback((name: string) => {
    setUserName(name);
    setStep(1);
  }, []);

  const handleProviderNext = useCallback((config: ProviderConfig) => {
    setProviderConfig(config);
    setStep(2);
  }, []);

  const handleAgentNext = useCallback((config: AgentConfig) => {
    setAgentConfig(config);
    setStep(3);
  }, []);

  // Advanced users can bail out of the wizard after providing their name and
   // configure the rest in Settings. Still marks OOBE complete so they don't
   // get the wizard again on relaunch.
  // unwrapIpc on both paths: these handlers resolve with a `{success:false}`
  // envelope instead of rejecting, so an unchecked await reads as success and
  // the wizard finishes regardless of what actually got saved.
  const handleSkip = useCallback(async (name: string) => {
    unwrapIpc(await window.electron.updateSettings({ userName: name }), 'Saving your name');
    unwrapIpc(await window.electron.completeOobe(), 'Finishing setup');
    await onComplete();
  }, [onComplete]);

  const handleComplete = useCallback(async (guidedTour: boolean) => {
    if (!providerConfig || !agentConfig) return;
    const { agentId, tourChatId } = await completeOobeSetup({
      userName, providerConfig, agentConfig, guidedTour,
    });
    // Reload first so the chat view is mounted and can render the stream live;
    // the reply is persisted server-side regardless, so a slow mount only
    // costs the animation, not the message.
    await onComplete();
    if (tourChatId) {
      window.electron.chatWithAgent({ chatId: tourChatId, agentId });
    }
  }, [providerConfig, agentConfig, userName, onComplete]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--bg-primary, #0a0a0f)' }}>
      {/* Subtle gradient background */}
      <div className="absolute inset-0 opacity-30"
        style={{
          background: 'radial-gradient(ellipse at 30% 20%, rgba(102, 126, 234, 0.15) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(118, 75, 162, 0.1) 0%, transparent 50%)',
        }}
      />

      <div className="relative w-full max-w-2xl mx-4">
        {/* Progress dots */}
        <div className="flex justify-center gap-3 mb-8">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className="w-2.5 h-2.5 rounded-full transition-all duration-300"
                style={{
                  backgroundColor: i <= step ? 'var(--accent-primary, #667eea)' : 'var(--border-primary, #333)',
                  boxShadow: i === step ? '0 0 8px var(--accent-primary, #667eea)' : 'none',
                }}
              />
              <span
                className="text-xs font-medium transition-colors duration-300"
                style={{
                  color: i <= step ? 'var(--text-secondary, #aaa)' : 'var(--text-tertiary, #555)',
                }}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Step content card */}
        <div
          className="rounded-xl border shadow-2xl overflow-hidden"
          style={{
            backgroundColor: 'var(--bg-secondary, #111118)',
            borderColor: 'var(--border-primary, #222)',
          }}
        >
          {step === 0 && (
            <OOBEWelcomeStep
              onNext={handleWelcomeNext}
              onSkip={handleSkip}
              defaultUserName={defaults.userName}
            />
          )}
          {step === 1 && (
            <OOBEProviderStep
              onNext={handleProviderNext}
              onBack={() => setStep(0)}
              defaultApiKeys={defaults.apiKeys}
            />
          )}
          {step === 2 && providerConfig && (
            <OOBEAgentStep
              providerConfig={providerConfig}
              userName={userName}
              onNext={handleAgentNext}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && agentConfig && providerConfig && (
            <OOBECompleteStep
              agentConfig={agentConfig}
              providerConfig={providerConfig}
              onComplete={handleComplete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
