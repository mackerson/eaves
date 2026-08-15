import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EavesGlyph } from '@/components/ui/EavesGlyph';

interface OOBEWelcomeStepProps {
  onNext: (userName: string) => void;
  onSkip?: (userName: string) => void;
  defaultUserName?: string | null;
}

export function OOBEWelcomeStep({ onNext, onSkip, defaultUserName }: OOBEWelcomeStepProps) {
  const [name, setName] = useState(defaultUserName ?? '');
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wizard fetches defaults asynchronously; apply it once if the user hasn't typed yet.
  const userTouched = useRef(false);
  useEffect(() => {
    if (!userTouched.current && defaultUserName && !name) {
      setName(defaultUserName);
    }
  }, [defaultUserName, name]);

  return (
    <div className="p-8 space-y-8">
      <div className="text-center space-y-3">
        <div className="mb-4">
          <EavesGlyph className="w-16 h-16 mx-auto" style={{ color: 'var(--text-primary, #fff)' }} />
        </div>
        <h1
          className="text-3xl font-bold tracking-tight"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          Welcome to Eaves
        </h1>
        <p
          className="text-base leading-relaxed max-w-md mx-auto"
          style={{ color: 'var(--text-secondary, #999)' }}
        >
          Your local-first workspace for AI conversations, agents, and persistent memory.
          Let&apos;s get you set up.
        </p>
      </div>

      <div className="max-w-sm mx-auto space-y-3">
        <label
          className="block text-sm font-medium"
          style={{ color: 'var(--text-secondary, #aaa)' }}
          htmlFor="oobe-username"
        >
          What should we call you?
        </label>
        <Input
          id="oobe-username"
          type="text"
          value={name}
          onChange={(e) => {
            userTouched.current = true;
            setName(e.target.value);
          }}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onNext(name.trim())}
          placeholder="Your name"
          autoFocus
          // UserNameSchema caps at 50. Without this the field silently accepts
          // a longer name, then the whole step-1 settings patch — API key
          // included — fails validation as one object.
          maxLength={50}
          className="text-center text-lg"
        />
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button
          onClick={() => onNext(name.trim())}
          disabled={!name.trim() || skipping}
          size="lg"
          className="px-8"
          style={name.trim() && !skipping ? {
            backgroundColor: 'var(--accent-primary, #667eea)',
            color: '#fff',
          } : {
            opacity: 0.4,
          }}
        >
          Get Started
        </Button>
        {onSkip && (
          <button
            type="button"
            onClick={async () => {
              if (!name.trim() || skipping) return;
              setSkipping(true);
              setError(null);
              try {
                await onSkip(name.trim());
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Setup failed — please try again.');
                setSkipping(false);
              }
            }}
            disabled={!name.trim() || skipping}
            className="text-xs underline underline-offset-4 disabled:opacity-40 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-tertiary, #666)' }}
          >
            {skipping ? 'Skipping…' : 'Skip setup — I\u2019ll configure in Settings'}
          </button>
        )}
        {error && (
          <p className="text-sm text-center" style={{ color: 'var(--status-error, #ef4444)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
