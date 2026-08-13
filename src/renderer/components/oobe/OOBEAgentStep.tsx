import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { OOBEInterviewFlow } from './OOBEInterviewFlow';
import { OOBEDirectFlow } from './OOBEDirectFlow';
import { OOBEManualFlow } from './OOBEManualFlow';
import type { ProviderConfig, AgentConfig } from './OOBEWizard';

type CreationMethod = 'interview' | 'direct' | 'manual' | null;

interface OOBEAgentStepProps {
  providerConfig: ProviderConfig;
  userName: string;
  onNext: (config: AgentConfig) => void;
  onBack: () => void;
}

interface MethodOption {
  id: CreationMethod;
  icon: string;
  title: string;
  description: string;
}

const METHODS: MethodOption[] = [
  {
    id: 'interview',
    icon: '\u{1f4ac}',
    title: 'Guided Interview',
    description: 'Answer a few questions and the AI will craft your perfect agent',
  },
  {
    id: 'direct',
    icon: '\u26a1',
    title: 'Direct Instructions',
    description: 'Describe what you want in your own words',
  },
  {
    id: 'manual',
    icon: '\u{1f527}',
    title: 'Manual Setup',
    description: 'Configure every detail yourself with a form',
  },
];

export function OOBEAgentStep({ providerConfig, userName, onNext, onBack }: OOBEAgentStepProps) {
  const [method, setMethod] = useState<CreationMethod>(null);

  if (method === 'interview') {
    return (
      <OOBEInterviewFlow
        providerConfig={providerConfig}
        userName={userName}
        onComplete={onNext}
        onBack={() => setMethod(null)}
      />
    );
  }

  if (method === 'direct') {
    return (
      <OOBEDirectFlow
        providerConfig={providerConfig}
        onComplete={onNext}
        onBack={() => setMethod(null)}
      />
    );
  }

  if (method === 'manual') {
    return (
      <OOBEManualFlow
        onComplete={onNext}
        onBack={() => setMethod(null)}
      />
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="space-y-1">
        <h2
          className="text-2xl font-bold"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          Create Your First Agent
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--text-secondary, #999)' }}
        >
          How would you like to set up your agent?
        </p>
      </div>

      <div className="space-y-3">
        {METHODS.map((m) => (
          <button
            key={m.id}
            onClick={() => setMethod(m.id)}
            className="w-full text-left p-5 rounded-lg border transition-all duration-200 hover:scale-[1.01] flex items-start gap-4"
            style={{
              borderColor: 'var(--border-primary, #333)',
              backgroundColor: 'var(--bg-tertiary, #1a1a24)',
            }}
          >
            <span className="text-2xl mt-0.5">{m.icon}</span>
            <div>
              <div
                className="font-semibold"
                style={{ color: 'var(--text-primary, #fff)' }}
              >
                {m.title}
              </div>
              <div
                className="text-sm mt-0.5"
                style={{ color: 'var(--text-tertiary, #666)' }}
              >
                {m.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack}
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <div /> {/* Spacer */}
      </div>
    </div>
  );
}
