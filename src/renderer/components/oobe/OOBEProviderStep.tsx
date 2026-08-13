import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderConfig } from './OOBEWizard';
import { PROVIDERS, ProviderId, getProvider } from '@shared/providers';

interface OOBEProviderStepProps {
  onNext: (config: ProviderConfig) => void;
  onBack: () => void;
  defaultApiKeys?: Partial<Record<ProviderId, string | null>>;
}

export function OOBEProviderStep({ onNext, onBack, defaultApiKeys }: OOBEProviderStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [validated, setValidated] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const providerOption = selectedProvider ? getProvider(selectedProvider) : undefined;

  const handleValidate = async () => {
    if (!selectedProvider) return;
    setValidating(true);
    setValidationError(null);

    const keyValue = providerOption?.needsKey ? apiKey : (apiKey || providerOption?.keyPlaceholder || '');

    try {
      const result = await window.electron.validateApiKey({
        provider: selectedProvider,
        apiKey: keyValue,
      });

      if (result.valid) {
        setModels(result.models || []);
        setValidated(true);
        // Auto-select first model
        if (result.models && result.models.length > 0) {
          setSelectedModel(result.models[0]);
        }
      } else {
        setValidationError(result.error || 'Validation failed');
      }
    } catch (err: any) {
      setValidationError(err.message || 'Connection failed');
    } finally {
      setValidating(false);
    }
  };

  const handleProviderSelect = (provider: ProviderId) => {
    setSelectedProvider(provider);
    setApiKey(defaultApiKeys?.[provider] ?? '');
    setValidated(false);
    setValidationError(null);
    setModels([]);
    setSelectedModel('');
  };

  const handleNext = () => {
    if (!selectedProvider || !selectedModel) return;
    const keyValue = providerOption?.needsKey ? apiKey : (apiKey || providerOption?.keyPlaceholder || '');
    onNext({
      provider: selectedProvider,
      apiKey: keyValue,
      model: selectedModel,
      availableModels: models,
    });
  };

  return (
    <div className="p-8 space-y-6">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="text-2xl font-bold"
              style={{ color: 'var(--text-primary, #fff)' }}
            >
              Connect an AI Provider
            </h2>
            <p
              className="text-sm"
              style={{ color: 'var(--text-secondary, #999)' }}
            >
              Choose how your agents will think. You can add more providers later in Settings.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className="text-xs whitespace-nowrap underline underline-offset-4 hover:opacity-80 transition-opacity shrink-0"
            style={{ color: 'var(--accent-primary, #667eea)' }}
          >
            {showHelp ? 'Hide help' : 'I\u2019m not sure — recommend one'}
          </button>
        </div>
      </div>

      {showHelp && (
        <div
          className="rounded-lg border p-4 text-sm space-y-3"
          style={{
            backgroundColor: 'rgba(102, 126, 234, 0.05)',
            borderColor: 'var(--border-primary, #333)',
            color: 'var(--text-secondary, #aaa)',
          }}
        >
          <div>
            <p className="font-semibold mb-1" style={{ color: 'var(--text-primary, #fff)' }}>
              What&apos;s a provider?
            </p>
            <p>
              A provider is the company (or local server) that runs the AI model your agent talks to. Enclave itself never sees your conversations — messages go straight from your machine to whichever provider you pick.
            </p>
          </div>

          <div>
            <p className="font-semibold mb-2" style={{ color: 'var(--text-primary, #fff)' }}>
              Which should I pick?
            </p>
            <ul className="space-y-2">
              <li>
                <span style={{ color: 'var(--text-primary, #fff)' }}>Want the best out-of-box experience?</span> <b>Anthropic (Claude)</b>. Get an API key at{' '}
                <a
                  href="https://console.anthropic.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-primary, #667eea)' }}
                  className="underline underline-offset-2"
                >
                  console.anthropic.com
                </a>. Pay-as-you-go; most conversations cost fractions of a cent.
              </li>
              <li>
                <span style={{ color: 'var(--text-primary, #fff)' }}>Already pay for ChatGPT?</span> <b>OpenAI</b>. Note: the ChatGPT subscription doesn&apos;t include API access — you need a separate key at{' '}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-primary, #667eea)' }}
                  className="underline underline-offset-2"
                >
                  platform.openai.com
                </a>.
              </li>
              <li>
                <span style={{ color: 'var(--text-primary, #fff)' }}>Want it free and fully private?</span> <b>Ollama</b>. Install{' '}
                <a
                  href="https://ollama.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-primary, #667eea)' }}
                  className="underline underline-offset-2"
                >
                  ollama.com
                </a>{' '}
                and run a model like Llama 3 locally. Slower than cloud models but your data never leaves your machine.
              </li>
              <li>
                <span style={{ color: 'var(--text-primary, #fff)' }}>Prefer Google&apos;s Gemini?</span> <b>Google</b>. Grab a key at{' '}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-primary, #667eea)' }}
                  className="underline underline-offset-2"
                >
                  aistudio.google.com
                </a>. Generous free tier.
              </li>
            </ul>
          </div>

          <p className="text-xs" style={{ color: 'var(--text-tertiary, #666)' }}>
            Not sure? Start with Anthropic — you can always add more providers later in Settings.
          </p>
        </div>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-2 gap-3">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleProviderSelect(p.id)}
            className="text-left p-4 rounded-lg border transition-all duration-200 hover:scale-[1.02]"
            style={{
              borderColor: selectedProvider === p.id ? 'var(--accent-primary, #667eea)' : 'var(--border-primary, #333)',
              backgroundColor: selectedProvider === p.id ? 'rgba(102, 126, 234, 0.08)' : 'var(--bg-tertiary, #1a1a24)',
            }}
          >
            <div className="text-2xl mb-2">{p.icon}</div>
            <div
              className="font-semibold text-sm"
              style={{ color: 'var(--text-primary, #fff)' }}
            >
              {p.label}
            </div>
            <div
              className="text-xs mt-1"
              style={{ color: 'var(--text-tertiary, #666)' }}
            >
              {p.description}
            </div>
          </button>
        ))}
      </div>

      {/* API key input */}
      {selectedProvider && (
        <div className="space-y-3">
          <div className="space-y-2">
            <label
              className="block text-sm font-medium"
              style={{ color: 'var(--text-secondary, #aaa)' }}
              htmlFor="oobe-apikey"
            >
              {providerOption ? providerOption.keyLabel + (providerOption.needsKey ? '' : ' (optional)') : ''}
            </label>
            <div className="flex gap-2">
              <Input
                id="oobe-apikey"
                type={providerOption?.needsKey ? 'password' : 'text'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setValidated(false);
                  setValidationError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleValidate()}
                placeholder={providerOption?.keyPlaceholder}
                className="flex-1"
              />
              <Button
                onClick={handleValidate}
                disabled={validating || (providerOption?.needsKey && !apiKey.trim())}
                variant="outline"
                style={{
                  borderColor: validated ? 'var(--status-success, #22c55e)' : 'var(--accent-primary, #667eea)',
                  color: validated ? 'var(--status-success, #22c55e)' : 'var(--accent-primary, #667eea)',
                }}
              >
                {validating ? 'Testing...' : validated ? 'Connected' : 'Test'}
              </Button>
            </div>
          </div>

          {validationError && (
            <p className="text-sm" style={{ color: 'var(--status-error, #ef4444)' }}>
              {validationError}
            </p>
          )}

          {/* Model selector */}
          {validated && models.length > 0 && (
            <div className="space-y-2">
              <label
                className="block text-sm font-medium"
                style={{ color: 'var(--text-secondary, #aaa)' }}
                htmlFor="oobe-model"
              >
                Model
              </label>
              <select
                id="oobe-model"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3 py-2 rounded-md border text-sm"
                style={{
                  backgroundColor: 'var(--bg-tertiary, #1a1a24)',
                  borderColor: 'var(--border-primary, #333)',
                  color: 'var(--text-primary, #fff)',
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack}
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <Button
          onClick={handleNext}
          disabled={!validated || !selectedModel}
          size="lg"
          style={validated && selectedModel ? {
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          } : { opacity: 0.4 }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
