import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { UpdateBanner } from './UpdateBanner';
import { useSettingsStore } from '@/stores';

function mockUpdater(initial: { status: string; info?: { version?: string }; error?: string }) {
  const listeners: Array<(s: any) => void> = [];
  (window.electron as any).updaterGetState = vi.fn().mockResolvedValue(initial);
  (window.electron as any).onUpdaterState = vi.fn((cb: (s: any) => void) => {
    listeners.push(cb);
    return () => { /* no-op cleanup */ };
  });
  (window.electron as any).updaterQuitAndInstall = vi.fn();
  return { emit: (s: any) => listeners.forEach((cb) => cb(s)) };
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { userName: 'User', apiKeys: {}, updateMode: 'auto' } as any,
      settingsHydrated: true,
    });
    (window.electron as any).updaterDownload = vi.fn().mockResolvedValue({ success: true });
  });

  it('offers Download while an update is available', async () => {
    mockUpdater({ status: 'available', info: { version: '0.3.14' } });
    render(<UpdateBanner />);

    expect(await screen.findByRole('button', { name: /download/i })).toBeTruthy();
  });

  // The bug: updaterDownload's result was discarded and the banner only
  // rendered for available|downloading|downloaded, so a failed download made it
  // unmount. The user clicks Download, the banner disappears, and nothing says
  // anything went wrong — which reads as "the update installed".
  it('stays up and explains itself when the download call fails', async () => {
    mockUpdater({ status: 'available', info: { version: '0.3.14' } });
    (window.electron as any).updaterDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'No artifact for linux-x64',
    });
    render(<UpdateBanner />);

    const btn = await screen.findByRole('button', { name: /download/i });
    await act(async () => { fireEvent.click(btn); });

    expect(await screen.findByText('Update failed')).toBeTruthy();
    expect(screen.getByText('No artifact for linux-x64')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  // electron-updater's own `error` event drives status:'error', which was not
  // in the render whitelist either.
  it('shows an error pushed by the updater state event', async () => {
    const { emit } = mockUpdater({ status: 'available', info: { version: '0.3.14' } });
    render(<UpdateBanner />);
    await screen.findByRole('button', { name: /download/i });

    await act(async () => { emit({ status: 'error', error: 'ENOTFOUND github.com' }); });

    expect(await screen.findByText('ENOTFOUND github.com')).toBeTruthy();
  });

  it('clears a stale failure once a download actually starts', async () => {
    const { emit } = mockUpdater({ status: 'available', info: { version: '0.3.14' } });
    (window.electron as any).updaterDownload = vi.fn().mockResolvedValue({
      success: false,
      error: 'transient',
    });
    render(<UpdateBanner />);
    const btn = await screen.findByRole('button', { name: /download/i });
    await act(async () => { fireEvent.click(btn); });
    await screen.findByText('Update failed');

    await act(async () => { emit({ status: 'downloading', progress: { percent: 12 } }); });

    await waitFor(() => expect(screen.queryByText('Update failed')).toBeNull());
    expect(screen.getByText(/downloading update/i)).toBeTruthy();
  });

  // External mode means the system package manager owns updates; an error we
  // can do nothing about is still not worth nagging over.
  it('stays silent in external update mode', async () => {
    useSettingsStore.setState({
      settings: { userName: 'User', apiKeys: {}, updateMode: 'external' } as any,
      settingsHydrated: true,
    });
    mockUpdater({ status: 'error', error: 'boom' });
    const { container } = render(<UpdateBanner />);

    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
