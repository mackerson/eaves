import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';

// ContentBlocksBuilder pulls in the logger, which resolves an Electron userData
// path at import — stub Electron so the module loads outside an Electron runtime.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { ContentBlocksBuilder } from './ContentBlocksBuilder';

describe('ContentBlocksBuilder.addSystemNote', () => {
  it('flushes buffered text, then appends the note as a system block', () => {
    const b = new ContentBlocksBuilder();
    b.handleEvent('Here is the answer');
    b.addSystemNote('⚠️ cut off at the output-token limit');

    const blocks = b.getContentBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', content: 'Here is the answer' });
    expect(blocks[1]).toMatchObject({ type: 'system', content: '⚠️ cut off at the output-token limit' });
  });

  it('appends a system block even when there is no preceding text', () => {
    const b = new ContentBlocksBuilder();
    b.addSystemNote('note');
    const blocks = b.getContentBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'system', content: 'note' });
  });
});
