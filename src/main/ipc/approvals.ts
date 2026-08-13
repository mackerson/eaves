import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../services/logger';
import { ipcResult, validateIPC } from '../utils/ipcValidation';
import { getPendingApprovalRegistry } from '../services/PendingApprovalRegistry';
import { resumeAfterApproval, resumeAfterApprovals } from '../services/approvalResume';
import { RespondToApprovalsSchema, GrantToolApprovalSchema, EntityIdSchema } from '../../shared/validation';
import { getUserRepository, getToolApprovalGrantRepository } from '../repositories';
import type { ToolSessionState } from '../services/discoveryTools';

/**
 * Approval IPC surface.
 *
 * The renderer reads pending approvals via `approval:list-pending` and
 * resolves them via `approval:respond`. The latter triggers a re-stream
 * with an appended `tool-approval-response` model message — the SDK
 * either runs `execute` (approved) or emits `tool-output-denied` (denied),
 * then continues the model into a fresh assistant message.
 */

export function registerApprovalHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle('approval:list-pending', ipcResult('approval:list-pending', async (_event, { context, contextId }: { context?: 'chat' | 'channel'; contextId?: string }) => {
    const registry = getPendingApprovalRegistry();
    const all = context && contextId ? registry.listForContext(context, contextId) : registry.listAll();
    return { success: true, approvals: all };
  }));

  ipcMain.handle('approval:respond', ipcResult('approval:respond', async (
    _event,
    { approvalId, approved, reason, context, contextId, agentId, messageId }: {
      approvalId: string;
      approved: boolean;
      reason?: string;
      // Optional fallback fields used when registry has been wiped (app restart)
      // but the renderer still has the pending contentBlock and knows where it lives.
      context?: 'chat' | 'channel';
      contextId?: string;
      agentId?: string;
      messageId?: string;
    },
  ) => {
    if (!approvalId || typeof approvalId !== 'string') {
      return { success: false, error: 'approvalId required' };
    }

    const registry = getPendingApprovalRegistry();
    const entry = registry.resolve(approvalId);

    const fallbackContext = !entry && context && contextId && agentId && messageId
      ? { context, contextId, agentId, messageId }
      : undefined;

    if (!entry && !fallbackContext) {
      return { success: false, error: 'Approval not found and no fallback context provided' };
    }

    const userRepo = getUserRepository();
    const currentUser = userRepo.getCurrent();
    const decidedBy = currentUser?.id ?? 'unknown';

    logger.info('[approval:respond]', { approvalId, approved, decidedBy, hadEntry: !!entry });

    const result = await resumeAfterApproval({
      approvalId,
      decision: { approved, reason, decidedBy },
      registryEntry: entry,
      fallbackContext,
      getMainWindow,
      toolStates: new Map<string, ToolSessionState>(),
    });

    return result;
  }));

  /**
   * Decide several approvals from one turn together, resuming once.
   *
   * The point is not only fewer clicks: one resume means the approved tools
   * run together and their results land next to the calls that made them.
   * Deciding them one at a time is what left parallel approvals answered
   * non-adjacently and wedged a conversation in beta.
   */
  ipcMain.handle('approval:respond-batch', ipcResult('approval:respond-batch', async (_event, params: unknown) => {
    const validation = validateIPC(RespondToApprovalsSchema, params, 'approval:respond-batch');
    if (!validation.success) return validation;
    const { decisions, context, contextId, agentId, messageId } = validation.data;

    const registry = getPendingApprovalRegistry();
    const userRepo = getUserRepository();
    const decidedBy = userRepo.getCurrent()?.id ?? 'unknown';

    const fallbackContext = context && contextId && agentId && messageId
      ? { context, contextId, agentId, messageId }
      : undefined;

    logger.info('[approval:respond-batch]', {
      count: decisions.length,
      approved: decisions.filter(d => d.approved).length,
      decidedBy,
    });

    return resumeAfterApprovals({
      decisions: decisions.map(d => ({
        approvalId: d.approvalId,
        decision: { approved: d.approved, reason: d.reason, decidedBy },
        registryEntry: registry.resolve(d.approvalId),
      })),
      fallbackContext,
      getMainWindow,
      toolStates: new Map<string, ToolSessionState>(),
    });
  }));

  // --- Per-conversation approval waivers -------------------------------------
  // A grant says "don't ask me about this tool here". It never widens what a
  // tool can do, and never applies where nobody is watching.

  ipcMain.handle('approval:grants:list', ipcResult('approval:grants:list', async (_event, containerId: string) => {
    const validation = validateIPC(EntityIdSchema, containerId, 'approval:grants:list');
    if (!validation.success) return validation;
    return { success: true, grants: getToolApprovalGrantRepository().list(validation.data) };
  }));

  ipcMain.handle('approval:grants:grant', ipcResult('approval:grants:grant', async (_event, params: unknown) => {
    const validation = validateIPC(GrantToolApprovalSchema, params, 'approval:grants:grant');
    if (!validation.success) return validation;
    const grantedBy = getUserRepository().getCurrent()?.id;
    const grant = getToolApprovalGrantRepository().grant({ ...validation.data, grantedBy });
    logger.info('[approval:grants] granted', {
      containerId: grant.containerId, agentId: grant.agentId, toolName: grant.toolName,
    });
    return { success: true, grant };
  }));

  ipcMain.handle('approval:grants:revoke', ipcResult('approval:grants:revoke', async (_event, grantId: string) => {
    const validation = validateIPC(EntityIdSchema, grantId, 'approval:grants:revoke');
    if (!validation.success) return validation;
    const revoked = getToolApprovalGrantRepository().revoke(validation.data);
    return revoked ? { success: true } : { success: false, error: 'Grant not found' };
  }));
}
