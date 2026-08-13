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

interface OOBEManualFlowProps {
  onComplete: (config: AgentConfig) => void;
  onBack: () => void;
}

export function OOBEManualFlow({ onComplete, onBack }: OOBEManualFlowProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [color, setColor] = useState('#667eea');

  const isValid = name.trim() && description.trim();

  const handleCreate = () => {
    if (!isValid) return;
    onComplete({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      temperature,
      color,
    });
  };

  return (
    <div className="p-8 space-y-5">
      <div className="space-y-1">
        <h2
          className="text-2xl font-bold"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          Manual Agent Setup
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--text-secondary, #999)' }}
        >
          Configure your agent&apos;s identity and behavior
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
              Name *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Atlas, Sage, Pixel"
              autoFocus
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
                  onClick={() => setColor(c)}
                  className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor: color === c ? '#fff' : 'transparent',
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
            Description *
          </label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A helpful AI assistant for coding and technical questions"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
            System Prompt <span style={{ color: 'var(--text-tertiary, #555)' }}>(optional)</span>
          </label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful assistant that specializes in..."
            rows={4}
            className="resize-none text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary, #aaa)' }}>
            Temperature: {temperature.toFixed(1)}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full accent-[var(--accent-primary)]"
          />
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary, #555)' }}>
            <span>Precise</span>
            <span>Creative</span>
          </div>
        </div>
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack}
          style={{ color: 'var(--text-secondary, #999)' }}>
          Back
        </Button>
        <Button
          onClick={handleCreate}
          disabled={!isValid}
          size="lg"
          style={isValid ? {
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
