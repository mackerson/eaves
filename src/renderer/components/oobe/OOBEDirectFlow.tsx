import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ProviderConfig, AgentConfig } from './OOBEWizard';
import { parseAgentJson, AgentConfigPreview } from './oobe-utils';
import { useOobeStreamStore, ensureOobeStreamListener, runOobeGenerate } from './useOobeStreamStore';

const DIRECT_SYSTEM_PROMPT = `The user will describe the kind of AI agent they want. Based on their description, generate a complete agent configuration. Output ONLY a JSON block in this exact format — no other text:

\`\`\`json
{
  "name": "A creative, memorable name for the agent",
  "description": "A one-sentence description of the agent's purpose",
  "systemPrompt": "A detailed system prompt that defines the agent's personality, expertise, and behavior guidelines. Be thorough — this is the agent's core identity.",
  "temperature": 0.7
}
\`\`\`

Guidelines:
- Name should be creative and fitting (not just "Assistant" or "Helper")
- Description should be concise but informative
- System prompt should be detailed (2-4 paragraphs) and establish personality, expertise, communication style, and any specific behaviors
- Temperature: 0.3-0.5 for analytical/precise tasks, 0.6-0.8 for general use, 0.8-1.0 for creative tasks`;

interface OOBEDirectFlowProps {
  providerConfig: ProviderConfig;
  onComplete: (config: AgentConfig) => void;
  onBack: () => void;
}

export function OOBEDirectFlow({ providerConfig, onComplete, onBack }: OOBEDirectFlowProps) {
  const [instructions, setInstructions] = useState('');
  const [parsedConfig, setParsedConfig] = useState<AgentConfig | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const streaming = useOobeStreamStore(s => s.streaming);
  const completedContent = useOobeStreamStore(s => s.completedContent);
  const error = useOobeStreamStore(s => s.error);
  const reset = useOobeStreamStore(s => s.reset);

  useEffect(() => {
    ensureOobeStreamListener();
    return () => reset();
  }, []);

  // When stream completes, parse the config
  useEffect(() => {
    if (completedContent === null) return;
    const config = parseAgentJson(completedContent);
    if (config) {
      setParsedConfig(config);
    } else {
      setParseError('Could not parse agent configuration from response. Try again with different instructions.');
    }
    useOobeStreamStore.setState({ completedContent: null });
  }, [completedContent]);

  const handleGenerate = useCallback(() => {
    if (!instructions.trim()) return;
    setParseError(null);
    runOobeGenerate({
      provider: providerConfig.provider,
      model: providerConfig.model,
      apiKey: providerConfig.apiKey,
      messages: [{ role: 'user', content: instructions.trim() }],
      systemPrompt: DIRECT_SYSTEM_PROMPT,
    });
  }, [instructions, providerConfig]);

  if (parsedConfig) {
    return (
      <AgentConfigPreview
        config={parsedConfig}
        onConfirm={onComplete}
        onBack={() => {
          setParsedConfig(null);
        }}
        title="Here's your custom agent"
      />
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary, #fff)' }}>
          Describe Your Agent
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary, #999)' }}>
          Tell the AI what kind of agent you want. Be as specific or vague as you like.
        </p>
      </div>

      <div className="space-y-2">
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder='e.g., "A coding assistant that specializes in TypeScript and React, with a concise and professional tone" or "A creative writing partner who helps with worldbuilding and character development"'
          rows={4}
          disabled={streaming}
          autoFocus
          className="resize-none"
        />
      </div>

      {streaming && (
        <div
          className="rounded-lg p-4 flex items-center gap-3"
          style={{
            backgroundColor: 'var(--bg-tertiary, #1a1a24)',
            color: 'var(--text-secondary, #aaa)',
          }}
        >
          <span className="inline-flex gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" style={{ animationDelay: '0.15s' }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" style={{ animationDelay: '0.3s' }} />
          </span>
          <span className="text-sm">Crafting your agent...</span>
        </div>
      )}

      {(error || parseError) && (
        <p className="text-sm" style={{ color: 'var(--status-error, #ef4444)' }}>
          {error || parseError}
        </p>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack}
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <Button
          onClick={handleGenerate}
          disabled={!instructions.trim() || streaming}
          size="lg"
          style={instructions.trim() && !streaming ? {
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          } : { opacity: 0.4 }}
        >
          {streaming ? 'Generating...' : 'Generate Agent'}
        </Button>
      </div>
    </div>
  );
}
