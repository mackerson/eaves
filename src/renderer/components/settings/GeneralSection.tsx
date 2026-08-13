import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSettingsStore, useUIPreferencesStore } from '@/stores';
import { useAutoSavedText } from './useAutoSavedText';

export function GeneralSection() {
  const userName = useSettingsStore((s) => s.settings.userName);
  const userAvatar = useSettingsStore((s) => s.settings.userAvatar);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const name = useAutoSavedText(userName, (v) => updateSettings({ userName: v }));

  const messageLayout = useUIPreferencesStore((s) => s.messageLayout);
  const setMessageLayout = useUIPreferencesStore((s) => s.setMessageLayout);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="user-name">Your Name</Label>
        <p className="text-sm text-muted-foreground">
          Displayed in channels and messages alongside your avatar.
        </p>
        <Input
          id="user-name"
          type="text"
          value={name.local}
          onChange={(e) => name.setLocal(e.target.value)}
          onBlur={name.commit}
          placeholder="Enter your name"
        />
      </div>

      <div className="space-y-2">
        <Label>Your Avatar</Label>
        <p className="text-sm text-muted-foreground">
          Optional profile image shown in the user menu.
        </p>
        <div className="flex items-center gap-3">
          {userAvatar ? (
            <img
              src={`avatar://${userAvatar}`}
              alt="Your avatar"
              className="w-16 h-16 rounded-full object-cover border border-border"
            />
          ) : (
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-muted text-xl font-bold border border-border">
              {(userName || 'U')[0]?.toUpperCase()}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const result = await window.electron.pickAvatar();
                if (!result.canceled && result.filename) {
                  updateSettings({ userAvatar: result.filename });
                }
              }}
            >
              {userAvatar ? 'Change' : 'Upload'}
            </Button>
            {userAvatar && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateSettings({ userAvatar: '' })}
                className="text-muted-foreground"
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Message layout</Label>
        <p className="text-sm text-muted-foreground">
          How sender names appear in chats. This preference is saved on this
          device.
        </p>
        <div className="flex gap-2">
          <Button
            variant={messageLayout === 'inline' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMessageLayout('inline')}
          >
            Inline — name beside message
          </Button>
          <Button
            variant={messageLayout === 'stacked' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMessageLayout('stacked')}
          >
            Stacked — name above message
          </Button>
        </div>
      </div>
    </div>
  );
}
