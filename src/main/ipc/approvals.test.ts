import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ipcMain } from 'electron';

const {
  registry,
  resumeAfterApproval,
  resumeAfterApprovals,
  userRepo,
  grantRepo,
} = vi.hoisted(() => ({
  registry: {
    listAll: vi.fn(),
    listForContext: vi.fn(),
    resolve: vi.fn(),
  },
  resumeAfterApproval: vi.fn(),
  resumeAfterApprovals: vi.fn(),
  userRepo: { getCurrent: vi.fn() },
  grantRepo: {
    list: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock('../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/PendingApprovalRegistry', () => ({
  getPendingApprovalRegistry: () => registry,
}));

vi.mock('../services/approvalResume', () => ({
  resumeAfterApproval,
  resumeAfterApprovals,
}));

vi.mock('../repositories', () => ({
  getUserRepository: () => userRepo,
  getToolApprovalGrantRepository: () => grantRepo,
}));

import { registerApprovalHandlers } from './approvals';

describe('approval IPC handlers', () => {
  let handlers: Map<string, Function>;
  const getMainWindow = vi.fn(() => null);

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as Mock).mockImplementation((ch: string, fn: Function) => {
      handlers.set(ch, fn);
    });
    userRepo.getCurrent.mockReturnValue({ id: 'user-1' });
    registerApprovalHandlers(getMainWindow);
  });

  const call = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({}, payload);
  };

  describe('approval:list-pending', () => {
    it('lists all or filters by context', async () => {
      registry.listAll.mockReturnValue([{ approvalId: 'a' }]);
      registry.listForContext.mockReturnValue([{ approvalId: 'b' }]);

      expect(await call('approval:list-pending', {})).toEqual({
        success: true,
        approvals: [{ approvalId: 'a' }],
      });
      expect(await call('approval:list-pending', { context: 'chat', contextId: 'c1' })).toEqual({
        success: true,
        approvals: [{ approvalId: 'b' }],
      });
      expect(registry.listForContext).toHaveBeenCalledWith('chat', 'c1');
    });
  });

  describe('approval:respond', () => {
    it('rejects missing approvalId', async () => {
      expect(await call('approval:respond', { approved: true })).toEqual({
        success: false,
        error: 'approvalId required',
      });
    });

    it('rejects when registry miss and no fallback context', async () => {
      registry.resolve.mockReturnValue(null);
      expect(
        await call('approval:respond', { approvalId: 'ap-1', approved: true }),
      ).toEqual({
        success: false,
        error: 'Approval not found and no fallback context provided',
      });
    });

    it('resumes with registry entry', async () => {
      const entry = { approvalId: 'ap-1', context: 'chat', contextId: 'c1' };
      registry.resolve.mockReturnValue(entry);
      resumeAfterApproval.mockResolvedValue({ success: true });

      const result = await call('approval:respond', {
        approvalId: 'ap-1',
        approved: false,
        reason: 'nope',
      });

      expect(result).toEqual({ success: true });
      expect(resumeAfterApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: 'ap-1',
          decision: { approved: false, reason: 'nope', decidedBy: 'user-1' },
          registryEntry: entry,
          fallbackContext: undefined,
        }),
      );
    });

    it('uses fallback context when registry entry is gone', async () => {
      registry.resolve.mockReturnValue(null);
      resumeAfterApproval.mockResolvedValue({ success: true });
      userRepo.getCurrent.mockReturnValue(null);

      await call('approval:respond', {
        approvalId: 'ap-1',
        approved: true,
        context: 'channel',
        contextId: 'ch-1',
        agentId: 'a1',
        messageId: 'm1',
      });

      expect(resumeAfterApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: { approved: true, reason: undefined, decidedBy: 'unknown' },
          fallbackContext: {
            context: 'channel',
            contextId: 'ch-1',
            agentId: 'a1',
            messageId: 'm1',
          },
        }),
      );
    });
  });

  describe('approval:respond-batch', () => {
    it('validates payload with Zod', async () => {
      const bad = await call('approval:respond-batch', { decisions: [] });
      expect(bad.success).toBe(false);
    });

    it('maps decisions and resumes once', async () => {
      registry.resolve.mockReturnValue({ approvalId: 'ap-1' });
      resumeAfterApprovals.mockResolvedValue({ success: true });

      const result = await call('approval:respond-batch', {
        decisions: [
          { approvalId: 'ap-1', approved: true },
          { approvalId: 'ap-2', approved: false, reason: 'deny' },
        ],
        context: 'chat',
        contextId: 'c1',
        agentId: 'a1',
        messageId: 'm1',
      });

      expect(result).toEqual({ success: true });
      expect(resumeAfterApprovals).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [
            expect.objectContaining({
              approvalId: 'ap-1',
              decision: expect.objectContaining({ approved: true, decidedBy: 'user-1' }),
            }),
            expect.objectContaining({
              approvalId: 'ap-2',
              decision: expect.objectContaining({ approved: false, reason: 'deny' }),
            }),
          ],
          fallbackContext: {
            context: 'chat',
            contextId: 'c1',
            agentId: 'a1',
            messageId: 'm1',
          },
        }),
      );
    });
  });

  describe('approval:grants:*', () => {
    it('lists grants for a container', async () => {
      grantRepo.list.mockReturnValue([{ id: 'g1' }]);
      expect(await call('approval:grants:list', 'ch-1')).toEqual({
        success: true,
        grants: [{ id: 'g1' }],
      });
      expect(grantRepo.list).toHaveBeenCalledWith('ch-1');
    });

    it('rejects invalid container id', async () => {
      const result = await call('approval:grants:list', '');
      expect(result.success).toBe(false);
    });

    it('grants with current user as grantedBy', async () => {
      grantRepo.grant.mockReturnValue({
        id: 'g1',
        containerId: 'ch-1',
        agentId: 'a1',
        toolName: 'bash',
      });
      const result = await call('approval:grants:grant', {
        containerId: 'ch-1',
        agentId: 'a1',
        toolName: 'bash',
      });
      expect(result.success).toBe(true);
      expect(grantRepo.grant).toHaveBeenCalledWith({
        containerId: 'ch-1',
        agentId: 'a1',
        toolName: 'bash',
        grantedBy: 'user-1',
      });
    });

    it('revoke returns not-found when missing', async () => {
      grantRepo.revoke.mockReturnValue(false);
      expect(await call('approval:grants:revoke', 'g-missing')).toEqual({
        success: false,
        error: 'Grant not found',
      });
      grantRepo.revoke.mockReturnValue(true);
      expect(await call('approval:grants:revoke', 'g1')).toEqual({ success: true });
    });
  });
});
