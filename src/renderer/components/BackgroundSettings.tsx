import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { BackgroundSettings as BackgroundSettingsType, BackgroundType } from '@/types';

const GRADIENT_PRESETS = [
  { name: 'Sunset', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  { name: 'Ocean', value: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0ea5e9 100%)' },
  { name: 'Forest', value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { name: 'Midnight', value: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a3e 50%, #2d1b69 100%)' },
  { name: 'Aurora', value: 'linear-gradient(135deg, #00c6ff 0%, #0072ff 50%, #7c3aed 100%)' },
  { name: 'Ember', value: 'linear-gradient(135deg, #1a0a0a 0%, #4a1c1c 50%, #dc2626 100%)' },
  { name: 'Mesh', value: 'radial-gradient(at 40% 20%, #667eea 0px, transparent 50%), radial-gradient(at 80% 0%, #764ba2 0px, transparent 50%), radial-gradient(at 0% 50%, #1e3a5f 0px, transparent 50%), #0f172a' },
  { name: 'Noir', value: 'linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%)' },
];

/**
 * BackgroundSettings component for configuring app background
 * Supports local files, URLs, and CSS gradients with opacity/blur controls
 */
export function BackgroundSettings() {
  const background = useSettingsStore((state) => state.settings.background);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const [urlInput, setUrlInput] = useState(background?.type === 'url' ? background.value : '');
  const [customGradient, setCustomGradient] = useState('');

  const currentType: BackgroundType = background?.type || 'none';
  const currentOpacity = background?.opacity ?? 0.3;
  const currentBlur = background?.blur ?? 0;

  const updateBackground = (updates: Partial<BackgroundSettingsType>) => {
    const newBackground: BackgroundSettingsType = {
      type: background?.type || 'none',
      value: background?.value || '',
      opacity: background?.opacity ?? 0.3,
      blur: background?.blur ?? 0,
      ...updates,
    };
    updateSettings({ background: newBackground });
  };

  const setBackgroundType = (type: BackgroundType) => {
    if (type === 'none') {
      updateSettings({ background: { type: 'none', value: '', opacity: 0.3, blur: 0 } });
    } else {
      updateBackground({ type });
    }
  };

  const handlePickLocalFile = async () => {
    const result = await window.electron.pickBackgroundImage();
    if (!result.canceled && result.path) {
      updateBackground({ type: 'local', value: result.path });
    }
  };

  const handleSetUrl = () => {
    if (urlInput.trim()) {
      updateBackground({ type: 'url', value: urlInput.trim() });
    }
  };

  const handleSelectGradient = (gradient: string) => {
    updateBackground({ type: 'gradient', value: gradient });
  };

  const handleSetCustomGradient = () => {
    if (customGradient.trim()) {
      updateBackground({ type: 'gradient', value: customGradient.trim() });
    }
  };

  return (
    <div className="space-y-4">
      <Label className="text-base font-medium">Background</Label>

      {/* Type Selection */}
      <div className="flex flex-wrap gap-2">
        {(['none', 'local', 'url', 'gradient'] as BackgroundType[]).map((type) => (
          <Button
            key={type}
            variant="outline"
            size="sm"
            onClick={() => setBackgroundType(type)}
            style={currentType === type ? { borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' } : {}}
          >
            {type === 'none' ? 'None' : type === 'local' ? 'Local File' : type === 'url' ? 'URL' : 'Gradient'}
          </Button>
        ))}
      </div>

      {/* Type-specific controls */}
      {currentType === 'local' && (
        <div className="space-y-2">
          <Button variant="outline" onClick={handlePickLocalFile}>
            Choose Image File
          </Button>
          {background?.value && (
            <p className="text-xs text-muted-foreground truncate">
              {background.value.split('/').pop()}
            </p>
          )}
        </div>
      )}

      {currentType === 'url' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/image.jpg"
              className="flex-1"
            />
            <Button variant="outline" onClick={handleSetUrl}>
              Set
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Images are cached locally for offline use
          </p>
        </div>
      )}

      {currentType === 'gradient' && (
        <div className="space-y-3">
          <Label className="text-sm">Presets</Label>
          <div className="grid grid-cols-4 gap-2">
            {GRADIENT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => handleSelectGradient(preset.value)}
                className={`h-12 rounded-md border-2 transition-all ${
                  background?.value === preset.value
                    ? 'border-accent-primary ring-2 ring-accent-primary/30'
                    : 'border-border hover:border-accent-primary/50'
                }`}
                style={{ background: preset.value }}
                title={preset.name}
              />
            ))}
          </div>

          <div className="space-y-2 pt-2">
            <Label className="text-sm">Custom CSS Gradient</Label>
            <div className="flex gap-2">
              <Input
                value={customGradient}
                onChange={(e) => setCustomGradient(e.target.value)}
                placeholder="linear-gradient(135deg, #000 0%, #333 100%)"
                className="flex-1 font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={handleSetCustomGradient}>
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Opacity and Blur controls - show for all types except 'none' */}
      {currentType !== 'none' && (
        <div className="space-y-4 pt-4 border-t border-border">
          {/* Opacity */}
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm">Opacity</Label>
              <span className="text-xs text-muted-foreground">{Math.round(currentOpacity * 100)}%</span>
            </div>
            <Slider
              value={[currentOpacity * 100]}
              onValueChange={([val]) => updateBackground({ opacity: val / 100 })}
              min={0}
              max={100}
              step={5}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Higher opacity shows more of the background
            </p>
          </div>

          {/* Blur */}
          <div className="space-y-2">
            <div className="flex justify-between">
              <Label className="text-sm">Blur</Label>
              <span className="text-xs text-muted-foreground">{currentBlur}px</span>
            </div>
            <Slider
              value={[currentBlur]}
              onValueChange={([val]) => updateBackground({ blur: val })}
              min={0}
              max={20}
              step={1}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Preview indicator */}
      {currentType !== 'none' && background?.value && (
        <div className="pt-2">
          <p className="text-xs text-muted-foreground">
            Background changes are applied immediately
          </p>
        </div>
      )}
    </div>
  );
}
