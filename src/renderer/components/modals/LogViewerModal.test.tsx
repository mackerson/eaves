import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LogViewerModal } from './LogViewerModal';

const file = (name: string, modified: number, size = 2048) => ({
  path: `/logs/${name}`,
  name,
  size,
  modified,
});

let getLogFiles: ReturnType<typeof vi.fn>;
let readLogFile: ReturnType<typeof vi.fn>;
let openLogDir: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getLogFiles = vi.fn().mockResolvedValue([]);
  readLogFile = vi.fn().mockResolvedValue({ success: true, content: '', size: 0, truncated: false });
  openLogDir = vi.fn().mockResolvedValue(undefined);
  (window as any).electron = { getLogFiles, readLogFile, openLogDir };
});

describe('LogViewerModal', () => {
  it('does not touch the log IPC while closed', () => {
    render(<LogViewerModal open={false} onOpenChange={() => {}} />);
    expect(getLogFiles).not.toHaveBeenCalled();
  });

  it('lists log files newest first and auto-selects the newest', async () => {
    getLogFiles.mockResolvedValue([
      file('eaves-2026-08-04.log', 4),
      file('eaves-2026-08-06.log', 6),
      file('eaves-2026-08-05.log', 5),
    ]);
    readLogFile.mockResolvedValue({ success: true, content: 'hello', size: 5, truncated: false });

    render(<LogViewerModal open onOpenChange={() => {}} />);

    await waitFor(() => expect(readLogFile).toHaveBeenCalledWith('/logs/eaves-2026-08-06.log'));
    const names = Array.from(
      screen.getByTestId('log-file-list').querySelectorAll('button')
    ).map((b) => b.textContent);
    expect(names[0]).toContain('eaves-2026-08-06.log');
    expect(names[2]).toContain('eaves-2026-08-04.log');
  });

  it('shows a truncation notice, the full size, and the elided amount when truncated', async () => {
    getLogFiles.mockResolvedValue([file('eaves-2026-08-06.log', 6, 3 * 1024 * 1024)]);
    readLogFile.mockResolvedValue({
      success: true,
      content: 'tail lines',
      size: 3 * 1024 * 1024,
      truncated: true,
    });

    render(<LogViewerModal open onOpenChange={() => {}} />);

    const notice = await screen.findByTestId('log-truncation-notice');
    expect(notice.textContent).toContain('last 1.0 MB');
    expect(notice.textContent).toContain('3.0 MB file');
    // 3MB file minus the 1MB tail — the user is told what they cannot see.
    expect(notice.textContent).toContain('2.0 MB of earlier entries are not shown');
  });

  it('does not claim truncation for a complete file', async () => {
    getLogFiles.mockResolvedValue([file('eaves-2026-08-06.log', 6, 512)]);
    readLogFile.mockResolvedValue({ success: true, content: 'all of it', size: 512, truncated: false });

    render(<LogViewerModal open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('log-content').textContent).toContain('all of it'));
    expect(screen.queryByTestId('log-truncation-notice')).toBeNull();
    expect(screen.getByText(/Complete file/)).toBeTruthy();
  });

  it('reports the empty-list case', async () => {
    render(<LogViewerModal open onOpenChange={() => {}} />);
    expect(await screen.findByText('No log files found.')).toBeTruthy();
    expect(readLogFile).not.toHaveBeenCalled();
  });

  it('surfaces a failed read envelope instead of blank content', async () => {
    getLogFiles.mockResolvedValue([file('eaves-2026-08-06.log', 6)]);
    readLogFile.mockResolvedValue({ success: false, error: 'Invalid log file path' });

    render(<LogViewerModal open onOpenChange={() => {}} />);

    expect(await screen.findByText('Invalid log file path')).toBeTruthy();
  });

  // get-log-files is ipcResult-wrapped, so a main-process throw arrives as an
  // error envelope where the declared type promises an array.
  it('surfaces a failed list envelope', async () => {
    getLogFiles.mockResolvedValue({ success: false, error: 'ENOENT: no log dir' });

    render(<LogViewerModal open onOpenChange={() => {}} />);

    expect(await screen.findByText('ENOENT: no log dir')).toBeTruthy();
  });

  it('switches files on selection', async () => {
    getLogFiles.mockResolvedValue([
      file('eaves-2026-08-06.log', 6),
      file('eaves-2026-08-05.log', 5),
    ]);
    readLogFile.mockResolvedValue({ success: true, content: 'x', size: 1, truncated: false });

    render(<LogViewerModal open onOpenChange={() => {}} />);
    await waitFor(() => expect(readLogFile).toHaveBeenCalledWith('/logs/eaves-2026-08-06.log'));

    fireEvent.click(screen.getByText('eaves-2026-08-05.log'));
    await waitFor(() => expect(readLogFile).toHaveBeenCalledWith('/logs/eaves-2026-08-05.log'));
  });

  it('opens the log directory through the existing IPC', async () => {
    render(<LogViewerModal open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByText('Open Log Directory'));
    expect(openLogDir).toHaveBeenCalled();
  });
});
