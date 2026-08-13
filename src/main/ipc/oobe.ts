import { ipcMain, BrowserWindow, app } from 'electron';
import { streamText } from 'ai';
import { getSettingsRepository } from '../repositories';
import { logger } from '../services/logger';
import { ValidateApiKeySchema, OOBEGenerateSchema } from '../../shared/validation';
import { validateIPC, ipcResult } from '../utils/ipcValidation';
import { fetchModelsForProvider } from '../utils/fetchModels';
import { getProviderAdapter } from '../services/providers';
import { friendlyAIErrorMessage, summarizeProviderError } from '../utils/aiErrors';

export function registerOOBEHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle('validate-api-key', ipcResult('validate-api-key', async (_event, params) => {
    const validation = validateIPC(ValidateApiKeySchema, params, 'validate-api-key');
    if (!validation.success) return validation;
    const { provider, apiKey } = validation.data;

    try {
      // All providers support model listing via their public endpoints — a
      // successful list implicitly validates the key/endpoint.
      const result = await fetchModelsForProvider(provider, { apiKey });
      return { valid: result.success, models: result.models, error: result.error };
    } catch (error: any) {
      logger.error('API key validation failed', { provider, error: error.message });
      return { valid: false, error: error.message || 'Connection failed' };
    }
  }));

  ipcMain.handle('oobe-generate', ipcResult('oobe-generate', async (_event, params) => {
    // The renderer's only signal that a generation ended is an `oobe-stream`
    // event of type `done` or `error` — the IPC return value drives nothing.
    // So every exit from this handler has to emit one, including the two
    // pre-flight bailouts below; without that the wizard sits on "Preparing
    // your interview" with a disabled input and no retry button, forever.
    const mainWindow = getMainWindow();
    const fail = (error: string) => {
      mainWindow?.webContents.send('oobe-stream', { type: 'error', error });
      return { success: false, error };
    };

    const validation = validateIPC(OOBEGenerateSchema, params, 'oobe-generate');
    if (!validation.success) return fail(validation.error);
    const { provider, model: modelId, apiKey, messages, systemPrompt } = validation.data;

    if (!mainWindow) {
      // Nothing to notify — the renderer that asked is already gone. The
      // envelope is all that's left, and call sites check it.
      return { success: false, error: 'No main window' };
    }

    try {
      // Construct the provider from passed params (not settings) — OOBE runs
      // before the user has committed keys.
      const adapter = getProviderAdapter(provider);
      if (!adapter) {
        return fail(`Unknown provider: ${provider}`);
      }
      const languageModel = adapter.createLanguageModel(modelId, { apiKey });

      logger.info('OOBE generate: starting streamText', { provider, model: modelId, messageCount: messages.length });

      const result = streamText({
        model: languageModel,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        maxOutputTokens: 2000,
      });

      let fullContent = '';
      let chunkCount = 0;
      let streamError: string | null = null;
      let finishReason: string | undefined;

      // fullStream (not textStream) surfaces error parts and finish metadata
      // so failures don't silently hang the UI on "Preparing interview".
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          chunkCount++;
          fullContent += part.text;
          mainWindow.webContents.send('oobe-stream', { type: 'text', content: part.text });
        } else if (part.type === 'error') {
          const err = (part as { error?: { message?: string } }).error;
          // JSON.stringify(err) was the fallback here, which put the SDK's
          // whole request — prompt, messages, tool schemas — into a string
          // shown to the user during setup.
          streamError = friendlyAIErrorMessage(err, provider);
          logger.error('OOBE generate: stream error part', {
            provider, model: modelId, ...summarizeProviderError(err),
          });
        } else if (part.type === 'finish-step' || part.type === 'finish') {
          const p = part as { finishReason?: string; usage?: unknown };
          finishReason = p.finishReason;
          logger.info('OOBE generate: stream finish', { finishReason, usage: p.usage, chunkCount });
        }
      }

      if (streamError) {
        mainWindow.webContents.send('oobe-stream', { type: 'error', error: streamError });
        return { success: false, error: streamError };
      }

      if (chunkCount === 0) {
        const msg = `Model returned no text (finish reason: ${finishReason || 'unknown'})`;
        logger.error('OOBE generate: empty response', { provider, model: modelId, finishReason });
        mainWindow.webContents.send('oobe-stream', { type: 'error', error: msg });
        return { success: false, error: msg };
      }

      logger.info('OOBE generate: stream complete', { chunkCount, contentLength: fullContent.length, finishReason });
      mainWindow.webContents.send('oobe-stream', { type: 'done' });
      return { success: true, content: fullContent };
    } catch (error: any) {
      logger.error('OOBE generate failed', { error: error.message, stack: error.stack });
      mainWindow.webContents.send('oobe-stream', { type: 'error', error: error.message });
      return { success: false, error: error.message };
    }
  }));

  // Dev-only: surface .env defaults so QA doesn't have to retype the API key on
   // every OOBE pass. In packaged builds this returns nothing regardless of env.
  ipcMain.handle('oobe-get-defaults', ipcResult('oobe-get-defaults', async () => {
    if (app.isPackaged) {
      return { userName: null, apiKeys: {} };
    }
    return {
      userName: process.env.USER_NAME || null,
      apiKeys: {
        anthropic: process.env.ANTHROPIC_API_KEY || null,
        openai: process.env.OPENAI_API_KEY || null,
        google: process.env.GOOGLE_API_KEY || null,
        openrouter: process.env.OPENROUTER_API_KEY || null,
        ollama: process.env.OLLAMA_API_KEY || null,
        lmstudio: process.env.LMSTUDIO_API_KEY || null,
      },
    };
  }));

  ipcMain.handle('complete-oobe', ipcResult('complete-oobe', async () => {
    const settingsRepo = getSettingsRepository();
    settingsRepo.update({ oobeCompleted: true });
    logger.info('OOBE completed');
    return { success: true };
  }));
}
