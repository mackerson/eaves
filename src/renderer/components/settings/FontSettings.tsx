import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSettingsStore, useToastStore } from '@/stores';
import { FontPreference } from '@/types';
import { useAutoSavedText } from './useAutoSavedText';

const FONT_OPTIONS: Array<{ value: FontPreference; label: string }> = [
  { value: 'default', label: 'System default' },
  { value: 'open-dyslexic', label: 'OpenDyslexic' },
  { value: 'custom', label: 'Custom' },
];

const SIZE_OPTIONS = [
  { value: 0.9, label: '90%' },
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.2, label: '120%' },
  { value: 1.3, label: '130%' },
];

const SPACING_OPTIONS = [
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Relaxed' },
  { value: 1.3, label: 'Loose' },
];

export function FontSettings() {
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily ?? 'default');
  const customFontFamily = useSettingsStore((s) => s.settings.customFontFamily);
  const fontScale = useSettingsStore((s) => s.settings.fontScale ?? 1);
  const lineSpacing = useSettingsStore((s) => s.settings.lineSpacing ?? 1);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);

  const customName = useAutoSavedText(customFontFamily, (v) =>
    updateSettings({ customFontFamily: v }),
  );

  const save = (updates: Parameters<typeof updateSettings>[0]) => {
    updateSettings(updates).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>Reading font</Label>
        <p className="text-sm text-muted-foreground">
          Applies across the whole app, on top of any theme. OpenDyslexic is a
          dyslexia-friendly font bundled with Eaves; Custom uses any font
          installed on your system (e.g. Dyslexie, Atkinson Hyperlegible).
        </p>
        <div className="flex gap-2">
          {FONT_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={fontFamily === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => save({ fontFamily: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        {fontFamily === 'custom' && (
          <Input
            id="custom-font-family"
            type="text"
            value={customName.local}
            onChange={(e) => customName.setLocal(e.target.value)}
            onBlur={customName.commit}
            placeholder="Font name as installed on this system, e.g. Dyslexie"
          />
        )}
      </div>

      <div className="space-y-2">
        <Label>Text size</Label>
        <div className="flex gap-2">
          {SIZE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={fontScale === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => save({ fontScale: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Line spacing</Label>
        <div className="flex gap-2">
          {SPACING_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={lineSpacing === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => save({ lineSpacing: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border p-3">
        <p
          className="text-text-primary"
          style={{
            fontSize: 'var(--font-size-base)',
            lineHeight: 'var(--line-height-normal)',
          }}
        >
          Preview: The quick brown fox jumps over the lazy dog — 1234567890.
        </p>
      </div>
    </div>
  );
}
