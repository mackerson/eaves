import { ThemeSelector } from '@/components/ThemeSelector';
import { BackgroundSettings } from '@/components/BackgroundSettings';
import { FontSettings } from '@/components/settings/FontSettings';

export function AppearanceSection() {
  return (
    <div className="space-y-6">
      <ThemeSelector />
      <div className="pt-4 border-t border-border">
        <FontSettings />
      </div>
      <div className="pt-4 border-t border-border">
        <BackgroundSettings />
      </div>
    </div>
  );
}
