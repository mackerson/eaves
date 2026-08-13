import { ipcMain } from 'electron';
import { getProjectRepository, getSettingsRepository } from '../repositories';
import { NoteColor, NoteAIMetadata } from '../types';
import { streamAIResponse } from '../services/ai';
import { emitAgentSpend, trackUsage, createStreamMetrics } from '../services/streamEventRouter';
import { resolveSystemAgent } from '../services/systemAgent';
import { loadAppState } from '../services/appStateLoader';
import { logger } from '../services/logger';
import {
  CreateNoteSchema,
  UpdateNoteSchema,
  ListNotesOptionsSchema,
  ReorderItemsSchema,
  CreateLabelSchema,
  EntityIdSchema,
} from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';

export function registerNoteHandlers() {
  ipcMain.handle('add-note', ipcResult('add-note', async (_event, noteData) => {
    const validation = validateIPC(CreateNoteSchema, noteData, 'add-note');
    if (!validation.success) return validation;

    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const currentState = settingsRepo.getCurrentState();
    if (!currentState.projectId) {
      return { success: false, error: 'No active project' };
    }

    return projectRepo.createNote(currentState.projectId, noteData);
  }));

  ipcMain.handle('update-note', ipcResult('update-note', async (_event, { noteId, updates }: { noteId: string; updates: any }) => {
    const idValidation = validateIPC(EntityIdSchema, noteId, 'update-note noteId');
    if (!idValidation.success) return idValidation;
    const updatesValidation = validateIPC(UpdateNoteSchema, updates, 'update-note updates');
    if (!updatesValidation.success) return updatesValidation;

    const projectRepo = getProjectRepository();
    const note = projectRepo.updateNote(idValidation.data, updates);
    if (!note) {
      return { success: false, error: 'Note not found' };
    }
    return note;
  }));

  ipcMain.handle('toggle-note-pin', ipcResult('toggle-note-pin', async (_event, noteId: string) => {
    const validation = validateIPC(EntityIdSchema, noteId, 'toggle-note-pin');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    const note = projectRepo.toggleNotePin(validation.data);
    if (!note) {
      return { success: false, error: 'Note not found' };
    }
    return note;
  }));

  ipcMain.handle('delete-note', ipcResult('delete-note', async (_event, noteId: string) => {
    const validation = validateIPC(EntityIdSchema, noteId, 'delete-note');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    projectRepo.deleteNote(validation.data);
    return { success: true };
  }));

  ipcMain.handle('list-notes', ipcResult('list-notes', async (_event, options = {}) => {
    const validation = validateIPC(ListNotesOptionsSchema, options, 'list-notes');
    if (!validation.success) return validation;
    const validOptions = validation.data;

    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const currentState = settingsRepo.getCurrentState();
    const targetProjectId = validOptions.projectId || currentState.projectId;

    if (!targetProjectId) {
      return { success: false, error: 'No project specified' };
    }

    const project = projectRepo.getById(targetProjectId);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    let notes = project.notes;

    if (validOptions.searchQuery) {
      const query = validOptions.searchQuery.toLowerCase();
      notes = notes.filter(note =>
        note.content.toLowerCase().includes(query) ||
        note.title?.toLowerCase().includes(query)
      );
    }

    if (validOptions.labelFilter) {
      notes = notes.filter(note =>
        note.labels.includes(validOptions.labelFilter!)
      );
    }

    if (validOptions.colorFilter) {
      notes = notes.filter(note => note.color === validOptions.colorFilter);
    }

    return notes;
  }));

  ipcMain.handle('get-note-labels', ipcResult('get-note-labels', async (_event, projectId?: string) => {
    if (projectId) {
      const validation = validateIPC(EntityIdSchema, projectId, 'get-note-labels');
      if (!validation.success) return validation;
    }

    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const currentState = settingsRepo.getCurrentState();
    const targetProjectId = projectId || currentState.projectId;

    if (!targetProjectId) {
      return { success: false, error: 'No project specified' };
    }

    return projectRepo.getLabelsByProjectId(targetProjectId);
  }));

  ipcMain.handle('create-note-label', ipcResult('create-note-label', async (_event, { name, color }: { name: string; color?: string }) => {
    const validation = validateIPC(CreateLabelSchema, { name, color }, 'create-note-label');
    if (!validation.success) return validation;
    const validData = validation.data;

    const settingsRepo = getSettingsRepository();
    const projectRepo = getProjectRepository();

    const currentState = settingsRepo.getCurrentState();
    if (!currentState.projectId) {
      return { success: false, error: 'No active project' };
    }

    return projectRepo.createLabel(currentState.projectId, validData.name, validData.color);
  }));

  ipcMain.handle('delete-note-label', ipcResult('delete-note-label', async (_event, labelId: string) => {
    const validation = validateIPC(EntityIdSchema, labelId, 'delete-note-label');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    projectRepo.deleteLabel(validation.data);
    return { success: true };
  }));

  ipcMain.handle('generate-note-metadata', ipcResult('generate-note-metadata', async (_event, noteId: string) => {
    const validation = validateIPC(EntityIdSchema, noteId, 'generate-note-metadata');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();

    const note = projectRepo.getNoteById(validation.data);
    if (!note) {
      return { success: false, error: 'Note not found' };
    }

    // Note metadata is housekeeping, not a conversation, so it resolves the
    // user's pinned system agent (falling back to defaultAgentId, then
    // first-available) instead of borrowing whichever agent the UI has
    // selected — there may be none selected at all when this runs.
    const agent = resolveSystemAgent();
    if (!agent) {
      return { success: false, error: 'No agent available for metadata generation' };
    }

    const memory = loadAppState();

    const generationPrompt = `Analyze the following note and generate metadata about it.

Note content:
${note.content}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "summary": "A 1-2 sentence summary of the note",
  "topics": ["topic1", "topic2", "topic3"],
  "type": "idea"
}

Rules:
- summary: 1-2 sentences max
- topics: 3-5 single words or short phrases
- type: must be one of: "idea", "todo", "reference", "meeting-notes", "journal"`;

    const aiMessages = [{ role: 'user' as const, content: generationPrompt }];

    let fullResponse = '';
    // Note metadata generation runs without a human watching this call.
    const noteMetrics = createStreamMetrics();
    for await (const event of streamAIResponse(
      agent, memory, aiMessages,
      undefined, undefined, undefined, undefined, undefined,
      { nonInteractive: true, contextLabel: 'note-metadata' },
    )) {
      if (typeof event === 'string') {
        fullResponse += event;
      } else {
        trackUsage(event, noteMetrics);
      }
    }
    emitAgentSpend(agent, noteMetrics, { kind: 'note-metadata' });

    const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return { success: false, error: 'Failed to parse AI response as JSON' };
      }
      const metadata: NoteAIMetadata = {
        summary: parsed.summary,
        topics: parsed.topics,
        type: parsed.type,
        generatedAt: Date.now(),
      };

      const updatedNote = projectRepo.updateNote(validation.data, { aiMetadata: metadata });

      return { success: true, metadata, note: updatedNote };
    }

    return { success: false, error: 'Failed to parse AI response' };
  }));

  ipcMain.handle('reorder-notes', ipcResult('reorder-notes', async (_event, orders: { id: string; sortOrder: number }[]) => {
    const validation = validateIPC(ReorderItemsSchema, orders, 'reorder-notes');
    if (!validation.success) return validation;

    const projectRepo = getProjectRepository();
    const success = projectRepo.reorderNotes(validation.data);
    return { success };
  }));
}
