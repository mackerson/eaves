import { ThemeToggle } from '../ThemeToggle';
import { useSettingsStore, useUIStore } from '@/stores';
import './UserMenu.css';

/**
 * Identity affordance in the menu bar.
 *
 * This used to be a dropdown holding User Preferences and Quit — two
 * commands that had no business hiding behind an avatar. Both now live where
 * the platform puts them (the app menu on macOS, File elsewhere), which
 * leaves the avatar with exactly one honest job: showing who you are and
 * getting you to the settings that change it.
 *
 * Eaves is local and single-user — there is no account, session or
 * workspace behind this, so it does not pretend to be a dropdown.
 */
export function UserMenu() {
  const { settings } = useSettingsStore();
  const setView = useUIStore((s) => s.setView);
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab);

  const userName = settings.userName || 'User';

  const openProfile = () => {
    setPendingSettingsTab('general');
    setView('settings');
  };

  return (
    <div className="user-menu">
      {/* Mirrors View ▸ Appearance rather than being the only way to change theme. */}
      <ThemeToggle />
      <button
        className="user-menu-button"
        onClick={openProfile}
        aria-label={`${userName} — open profile settings`}
        title="Profile settings"
      >
        {settings.userAvatar ? (
          <img
            className="user-avatar user-avatar-image"
            src={`avatar://${settings.userAvatar}`}
            alt=""
          />
        ) : (
          <div className="user-avatar">{userName.charAt(0).toUpperCase()}</div>
        )}
        <span className="user-name">{userName}</span>
      </button>
    </div>
  );
}
