import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AgentConfig } from './OOBEWizard';

const AGENT_COLORS = [
  '#667eea', '#764ba2', '#f093fb', '#4facfe',
  '#00f2fe', '#43e97b', '#fa709a', '#fee140',
  '#a18cd1', '#fbc2eb', '#ff9a9e', '#fad0c4',
  '#6a11cb', '#2575fc', '#eb3349', '#f45c43',
];

/**
 * Parse agent config JSON from an AI response.
 * Looks for a fenced ```json ... ``` block.
 */
export function parseAgentJson(text: string): AgentConfig | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    if (!parsed.name || !parsed.description || !parsed.systemPrompt) return null;
    return {
      name: String(parsed.name),
      description: String(parsed.description),
      systemPrompt: String(parsed.systemPrompt),
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : 0.7,
      color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)],
    };
  } catch {
    return null;
  }
}

/**
 * Preview and edit an AI-generated agent config before confirming.
 */
interface AgentConfigPreviewProps {
  config: AgentConfig;
  onConfirm: (config: AgentConfig) => void;
  onBack: () => void;
  title: string;
}

export function AgentConfigPreview({ config, onConfirm, onBack, title }: AgentConfigPreviewProps) {
  const [editedConfig, setEditedConfig] = useState<AgentConfig>(config);

  return (
    <div className="p-8 space-y-5">
      <div className="space-y-1">
        <h2
          className="text-xl font-bold"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          {title}
        </h2>
        <p
          className="text-xs"
          style={{ color: 'var(--text-tertiary, #666)' }}
        >
          Review and tweak before creating
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
              Name
            </label>
            <Input
              value={editedConfig.name}
              onChange={(e) => setEditedConfig({ ...editedConfig, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
              Color
            </label>
            <div className="flex gap-1 flex-wrap" style={{ maxWidth: '140px' }}>
              {AGENT_COLORS.slice(0, 8).map((c) => (
                <button
                  key={c}
                  onClick={() => setEditedConfig({ ...editedConfig, color: c })}
                  className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor: editedConfig.color === c ? '#fff' : 'transparent',
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
            Description
          </label>
          <Input
            value={editedConfig.description}
            onChange={(e) => setEditedConfig({ ...editedConfig, description: e.target.value })}
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
            System Prompt
          </label>
          <Textarea
            value={editedConfig.systemPrompt}
            onChange={(e) => setEditedConfig({ ...editedConfig, systemPrompt: e.target.value })}
            rows={5}
            className="resize-none text-xs"
          />
        </div>

        {/* Temperature is set by the interview AI based on the use case
            and lives on the agent record. The slider has been removed from
            OOBE — first-time users don't need that lever, and some models
            (reasoning-class Claude, OpenAI o-series) reject it outright.
            Editable post-OOBE in the agent editor when the model supports it. */}
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack}
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <Button
          onClick={() => onConfirm(editedConfig)}
          disabled={!editedConfig.name.trim() || !editedConfig.description.trim()}
          size="lg"
          style={editedConfig.name.trim() && editedConfig.description.trim() ? {
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          } : { opacity: 0.4 }}
        >
          Create Agent
        </Button>
      </div>
    </div>
  );
}
