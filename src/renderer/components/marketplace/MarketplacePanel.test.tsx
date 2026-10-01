/**
 * @vitest-environment happy-dom
 *
 * The Marketplace panel: browse/search over the curated registry, with the
 * states that earn their pixels — permission chips before install, an Update
 * button when the installed version is behind, and offline that looks like
 * offline instead of an empty store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MarketplacePanel } from './MarketplacePanel';

type Listing = Awaited<ReturnType<typeof window.electron.getPluginRegistry>>;

const PLUGINS: Listing['plugins'] = [
  {
    id: 'com.eaves.webview',
    name: 'WebView Browser',
    description: 'Embedded web browser for Eaves.',
    author: 'mackerson',
    homepage: 'https://example.invalid/webview',
    tier: 'official',
    latest: '2.0.1',
    permissions: ['ui:views:register', 'storage:write'],
    release: { tag: 'v2.0.1', asset: 'w.tgz', url: 'https://example.invalid/w.tgz', sha256: 'a'.repeat(64) },
  },
  {
    id: 'com.eaves.openmemory',
    name: 'OpenMemory',
    description: 'Semantic memory system.',
    author: 'mackerson',
    homepage: 'https://example.invalid/openmemory',
    tier: 'official',
    latest: '1.2.0',
    category: 'memory',
    permissions: ['network:http'],
    release: { tag: 'v1.2.0', asset: 'o.tgz', url: 'https://example.invalid/o.tgz', sha256: 'b'.repeat(64) },
  },
];

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    plugins: PLUGINS,
    installed: {},
    status: { source: 'network', updated: '2026-09-30', fetchedAt: Date.now() },
    ...overrides,
  };
}

let electron: { getPluginRegistry: ReturnType<typeof vi.fn>; installPlugin: ReturnType<typeof vi.fn>; uninstallPlugin: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  electron = {
    getPluginRegistry: vi.fn().mockResolvedValue(listing()),
    installPlugin: vi.fn().mockResolvedValue({ success: true }),
    uninstallPlugin: vi.fn().mockResolvedValue({ success: true }),
  };
  (window as never as { electron: unknown }).electron = electron;
});

describe('MarketplacePanel', () => {
  it('lists registry plugins with their permission chips visible before install', async () => {
    render(<MarketplacePanel />);

    expect(await screen.findByText('WebView Browser')).toBeTruthy();
    expect(screen.getByText('OpenMemory')).toBeTruthy();
    // Chips are the browse-time permission disclosure: plain-English labels on
    // the card, not just a count hidden behind the consent dialog.
    expect(screen.getByText('Store its own data')).toBeTruthy();
    expect(screen.getByText('Make network requests')).toBeTruthy();
  });

  it('filters by name, description, and category', async () => {
    render(<MarketplacePanel />);
    await screen.findByText('WebView Browser');

    const search = screen.getByPlaceholderText(/Search by name/);

    fireEvent.change(search, { target: { value: 'browser' } });
    expect(screen.getByText('WebView Browser')).toBeTruthy();
    expect(screen.queryByText('OpenMemory')).toBeNull();

    // `category` is matched when the registry carries it.
    fireEvent.change(search, { target: { value: 'memory' } });
    expect(screen.getByText('OpenMemory')).toBeTruthy();
    expect(screen.queryByText('WebView Browser')).toBeNull();

    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText(/No plugins match your search/)).toBeTruthy();
  });

  it('installs through the one verified pipeline and refreshes the listing', async () => {
    const onInstalledChange = vi.fn();
    render(<MarketplacePanel onInstalledChange={onInstalledChange} />);
    await screen.findByText('WebView Browser');

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]);

    await waitFor(() => expect(electron.installPlugin).toHaveBeenCalledWith('com.eaves.webview'));
    await waitFor(() => expect(onInstalledChange).toHaveBeenCalled());
    // Renderer hands over an id, never a URL.
    expect(electron.installPlugin.mock.calls[0]).toEqual(['com.eaves.webview']);
  });

  it('shows Installed for an up-to-date plugin and Update for a stale one', async () => {
    electron.getPluginRegistry.mockResolvedValue(listing({
      installed: { 'com.eaves.webview': '2.0.1', 'com.eaves.openmemory': '1.0.0' },
    }));
    render(<MarketplacePanel />);
    await screen.findByText('WebView Browser');

    expect(screen.getByRole('button', { name: /Installed/ })).toBeTruthy();
    const update = screen.getByRole('button', { name: 'Update to v1.2.0' });
    fireEvent.click(update);
    await waitFor(() => expect(electron.installPlugin).toHaveBeenCalledWith('com.eaves.openmemory'));
  });

  it('shows the stale-cache banner when the registry came from disk, and Retry forces a refetch', async () => {
    electron.getPluginRegistry.mockResolvedValue(listing({
      status: { source: 'cache', updated: '2026-09-01', fetchedAt: null },
    }));
    render(<MarketplacePanel />);
    await screen.findByText('WebView Browser');

    // Cached is still browsable — the banner says how stale, it doesn't hide the list.
    expect(screen.getByText(/showing the last copy from 2026-09-01/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(electron.getPluginRegistry).toHaveBeenLastCalledWith(true));
  });

  it('renders an explicit outage state, not an empty store, when nothing is available', async () => {
    electron.getPluginRegistry.mockResolvedValue(listing({
      plugins: [],
      status: { source: 'none', updated: '', fetchedAt: null },
    }));
    render(<MarketplacePanel />);

    expect(await screen.findByText(/registry is unreachable/)).toBeTruthy();
    expect(screen.queryByText(/No plugins available yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(electron.getPluginRegistry).toHaveBeenLastCalledWith(true));
  });
});
