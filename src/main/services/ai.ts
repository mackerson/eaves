import { streamText, stepCountIs, LanguageModel, Tool, type JSONValue } from 'ai';
import { Agent, AppState, ToolCall } from '../types';
import { logger } from './logger';
import { getProviderAdapter } from './providers';
import { friendlyAIErrorMessage, isConnectionError, summarizeProviderError } from '../utils/aiErrors';
import { stripApprovalRequiredTools } from './toolGating';
import { withToolCacheBreakpoint, withMessageCacheBreakpoint, supportsSystemCacheBreakpoint, CACHE_BREAKPOINT_PROVIDER_OPTIONS } from './promptCache';

// Type definitions for AI service
interface MessageMetadata {
  displayName?: string;
  senderType?: string;
  color?: string;
  [key: string]: unknown;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
  metadata?: MessageMetadata;
  toolCalls?: ToolCall[];
}

export function getAIProvider(agent: Agent, memory: AppState): LanguageModel {
  const adapter = getProviderAdapter(agent.provider);
  if (!adapter) {
    throw new Error(`Unknown provider: ${agent.provider}`);
  }
  const credential = memory.settings.apiKeys[agent.provider];
  logger.debug(`Creating ${agent.provider} provider`, {
    model: agent.model,
    hasCredential: !!credential,
  });
  return adapter.createLanguageModel(agent.model, { apiKey: credential });
}

export type StreamEvent =
  | string  // text chunks
  | { type: 'tool-call-start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-call-result'; toolName: string; result: unknown }
  | { type: 'tool-call-error'; toolName: string; error: Error | string }
  // Tool wants to run but its needsApproval predicate returned true. SDK
  // emits this instead of running execute and finishes the stream. Caller
  // persists pending state and waits for an approval response message
  // before re-streaming.
  | { type: 'tool-approval-request'; approvalId: string; toolCallId: string; toolName: string; input: unknown }
  // Resume turn: approval was denied — SDK emits this instead of tool-result.
  | { type: 'tool-output-denied'; toolCallId: string; toolName: string }
  | { type: 'error'; error: Error | string }
  | { type: 'step-start' }
  | { type: 'step-finish'; finishReason: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  // Terminal, authoritative token count for the whole turn. `step-finish`
  // reports ONE step, so a multi-step tool chain that consumed 10k + 15k +
  // 22k + 30k input tokens reports whichever step happened to land last —
  // and since each step resends the accumulated tool results, the steps a
  // consumer never sees are the expensive ones. The SDK sums them for us.
  | { type: 'usage-total'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  // Terminal event: SDK-shaped assistant + tool messages reflecting this
  // turn's calls/results, ready to be persisted and replayed verbatim on the
  // next turn. Source of truth for the model's view of history; ContentBlocks
  // remain the source of truth for the renderer.
  | { type: 'response-messages'; messages: unknown[] }
  // OpenRouter usage accounting: which upstream backend served this turn plus
  // real cost + cached-prompt-token count, from providerMetadata.openrouter.
  | { type: 'provider-metadata'; servedProvider?: string; cost?: number; cachedTokens?: number; cacheWriteTokens?: number };

export interface StreamAIOptions {
  /**
   * True when this stream runs without a human present (routines, shadow
   * agent flushes, workflow agent nodes, summarization passes). Tools that
   * declare `needsApproval` are stripped before streamText sees them — the
   * SDK would otherwise emit tool-approval-request events that nobody is
   * there to resolve, hanging the workflow. Defaults to false.
   */
  nonInteractive?: boolean;
  /** Caller name shown in the toolGating log when tools get stripped. */
  contextLabel?: string;
  /**
   * Dynamic active-tool gate. When provided, only the returned tool names are
   * exposed to the model on each step (the rest stay registered but unbilled).
   * Re-evaluated per step via prepareStep, so a tool the model enables mid-turn
   * becomes callable on the next step. Undefined exposes every registered tool.
   */
  activeTools?: () => string[];
  /**
   * Sticky-provider pinning (OpenRouter only). The upstream backend that served
   * the previous turn of this conversation. When set and the agent uses
   * OpenRouter, we ask OpenRouter to prefer this backend (order: [it],
   * allow_fallbacks: true) so the prompt cache stays warm across turns. Soft by
   * design — if the backend is unavailable OpenRouter still serves the request
   * (cold), and the next turn re-pins to whoever actually served.
   */
  preferredProvider?: string;
}

export async function* streamAIResponse(
  agent: Agent,
  memory: AppState,
  messages: AIMessage[],
  systemPrompt?: string,
  tools?: Record<string, Tool>,
  abortSignal?: AbortSignal,
  rawPrompt?: string,
  stoppingStrings?: string[],
  options?: StreamAIOptions,
): AsyncGenerator<StreamEvent, string, unknown> {
  logger.debug('streamAIResponse called', {
    messageCount: messages.length,
    hasSystemPrompt: !!systemPrompt,
    hasTools: !!tools,
    hasRawPrompt: !!rawPrompt,
    stoppingStringsCount: stoppingStrings?.length || 0,
    messagesWithNames: messages.filter(m => m.name).length
  });

  const model = getAIProvider(agent, memory);

  interface StreamConfig {
    model: LanguageModel;
    // Widened for the system-message cache breakpoint below — a system role
    // carrying providerOptions is not expressible as an AIMessage.
    messages: AIMessage[] | Array<AIMessage | { role: 'system'; content: string; providerOptions?: Record<string, Record<string, JSONValue>> }>;
    temperature?: number;
    topP?: number;
    stopWhen: ReturnType<typeof stepCountIs>;
    maxOutputTokens?: number;
    system?: string;
    tools?: Record<string, Tool>;
    abortSignal?: AbortSignal;
    maxRetries?: number;
    stopSequences?: string[];
    activeTools?: string[];
    prepareStep?: () => { activeTools: string[] };
    providerOptions?: { openrouter: { provider: { order: string[]; allow_fallbacks: boolean } } };
  }

  // Capability gate: omit sampling params the chosen model doesn't accept.
  // Otherwise the SDK forwards them and the provider strips them with an
  // AI SDK warning per request (Anthropic claude-opus-4-7 etc. reject
  // temperature; OpenAI o-series rejects temperature + topP + stop).
  const adapter = getProviderAdapter(agent.provider);
  const caps = adapter?.getCapabilities(agent.model);

  // If raw prompt is provided (for instruct templates), convert to single user message
  let finalMessages = messages;
  if (rawPrompt) {
    logger.info('Using raw prompt format (instruct template)', {
      promptLength: rawPrompt.length,
      provider: agent.provider
    });
    finalMessages = [{ role: 'user' as const, content: rawPrompt }];
  }

  // Cache the conversation prefix: mark the last message so the next turn
  // reuses everything before it (see promptCache.ts).
  const streamConfig: StreamConfig = {
    model,
    messages: withMessageCacheBreakpoint(finalMessages, agent.provider),
    // `stopWhen` drives the multi-step tool loop and defaults to
    // stepCountIs(1) — a single generation, no chance to act on a tool result.
    // Set it explicitly so the model can call a tool, see the result, and
    // continue (and so the discovery flow's enable→use works across steps).
    stopWhen: stepCountIs(agent.maxSteps || 10),
  };

  // Gate maxOutputTokens on the capability — a model that doesn't accept
  // max_tokens (some reasoning models) would otherwise be sent it unconditionally.
  // Default 4096 when unset — a smaller cap truncates real answers mid-sentence.
  if (caps?.maxOutputTokens !== false) {
    streamConfig.maxOutputTokens = agent.maxOutputTokens || 4096;
  }

  // caps falls back to optimistic-allow when the adapter doesn't know the
  // model — keeps unknown providers working at the cost of one warning per
  // mismatch (which we then learn from).
  if (caps?.temperature !== false) {
    streamConfig.temperature = agent.temperature;
  }
  if (typeof agent.topP === 'number' && caps?.topP !== false) {
    streamConfig.topP = agent.topP;
  }

  // Add system prompt (unless using raw prompt which includes it).
  //
  // Providers that drop tool-level cache_control (OpenRouter) take the
  // breakpoint here instead: tools render before system, so marking the end of
  // system caches the tool block too. That needs the prompt to travel as a
  // system *message* — the top-level `system` string has nowhere to carry
  // providerOptions.
  if (systemPrompt && !rawPrompt) {
    if (supportsSystemCacheBreakpoint(agent.provider)) {
      streamConfig.messages = [
        { role: 'system', content: systemPrompt, providerOptions: CACHE_BREAKPOINT_PROVIDER_OPTIONS },
        ...streamConfig.messages,
      ] as typeof streamConfig.messages;
    } else {
      streamConfig.system = systemPrompt;
    }
  }

  // Non-interactive contexts can't service approval prompts — strip tools
  // that need them before they reach the model.
  const effectiveTools = options?.nonInteractive
    ? stripApprovalRequiredTools(tools, options.contextLabel ?? `${agent.name}/${agent.model}`)
    : tools;

  if (effectiveTools && Object.keys(effectiveTools).length > 0) {
    // Dynamic active-tool gating: expose only the currently-enabled subset each
    // step (cheap), but keep every tool registered so the model can enable one
    // and use it within the same turn. prepareStep re-reads the gate per step.
    const getActive = options?.activeTools;
    const activeNames = getActive?.();

    // Cache the tool block where the provider takes an explicit breakpoint.
    // Tools render before system and messages, so one breakpoint on the last
    // tool covers the whole block (see promptCache.ts). It has to be the last
    // tool actually *sent* — the gate filters the block before serialization,
    // so a breakpoint on a gated-out tool would vanish silently.
    streamConfig.tools = withToolCacheBreakpoint(effectiveTools, agent.provider, activeNames);

    if (getActive) {
      streamConfig.activeTools = activeNames;
      streamConfig.prepareStep = () => ({ activeTools: getActive() });
    }
  }

  if (abortSignal) {
    streamConfig.abortSignal = abortSignal;
  }

  // Add stopping strings if provided AND the model accepts them. OpenAI
  // reasoning models (o-series) reject `stop`; the capability registry
  // tracks this per-provider.
  if (stoppingStrings && stoppingStrings.length > 0 && caps?.stopSequences !== false) {
    logger.info('Adding stopping strings', { count: stoppingStrings.length, strings: stoppingStrings });
    streamConfig.stopSequences = stoppingStrings;
  }

  // Sticky-provider pin (OpenRouter only): prefer the backend that served the
  // previous turn so the prompt cache stays warm across the conversation. Soft
  // by design — allow_fallbacks lets OpenRouter serve elsewhere (cold) if that
  // backend is down, and the next turn re-pins to whoever actually served.
  if (
    agent.provider === 'openrouter' &&
    options?.preferredProvider &&
    memory.settings.openrouterStickyProvider !== false
  ) {
    streamConfig.providerOptions = {
      openrouter: {
        provider: { order: [options.preferredProvider], allow_fallbacks: true },
      },
    };
    logger.info('OpenRouter sticky-provider pin', { preferredProvider: options.preferredProvider });
  }

  logger.debug('Calling streamText', {
    temperature: agent.temperature,
    messageCount: messages.length,
    hasSystem: !!streamConfig.system,
    messagesWithContext: messages.filter(m => m.name || m.metadata).length
  });
  logger.debug('Full streamConfig:', JSON.stringify({ ...streamConfig, model: 'MODEL_OBJECT' }, null, 2));

  try {
    const result = streamText(streamConfig);
    logger.debug('streamText result obtained, starting iteration');

    const chunks: string[] = [];
    let chunkCount = 0;

    // Track tool calls to match results
    interface StoredToolCall {
      name: string;
      args: Record<string, unknown>;
    }
    const toolCallMap = new Map<string, StoredToolCall>();

    // Use fullStream to handle both text and tool calls
    for await (const part of result.fullStream) {
      chunkCount++;
      logger.debug(`Received part ${chunkCount}:`, { type: part.type });

      // Check for empty response with unknown finish reason
      if (part.type === 'finish-step' && part.finishReason === 'other' && chunks.length === 0) {
        logger.error('Received empty response with unknown finish reason', {
          provider: agent.provider,
          model: agent.model,
          usage: part.usage,
        });
      }

      if (part.type === 'text-delta') {
        chunks.push(part.text);
        yield part.text;
      } else if (part.type === 'tool-call') {
        // `input` is the model's arguments; absent for a zero-arg call.
        const args = (part.input ?? {}) as Record<string, unknown>;
        logger.info('Tool call detected', { toolName: part.toolName, args });

        if (part.toolCallId) {
          toolCallMap.set(part.toolCallId, { name: part.toolName, args });
        }

        yield {
          type: 'tool-call-start',
          toolName: part.toolName,
          args,
        };
      } else if (part.type === 'tool-result') {
        // The result part carries no tool name — recover it from the call
        // recorded when the model requested it.
        const toolInfo = toolCallMap.get(part.toolCallId);
        logger.info('Tool result received', { toolName: toolInfo?.name || 'unknown', result: part.output });

        yield {
          type: 'tool-call-result',
          toolName: toolInfo?.name || 'unknown',
          result: part.output,
        };
      } else if (part.type === 'tool-approval-request') {
        // SDK signals the model wants to call a tool whose needsApproval
        // predicate returned true. We've already seen the matching tool-call
        // earlier in the stream, so we know toolName + input.
        const toolInfo = toolCallMap.get(part.toolCall.toolCallId);
        const toolName = toolInfo?.name ?? part.toolCall.toolName;
        const input = toolInfo?.args ?? (part.toolCall as { input?: unknown }).input ?? {};
        logger.info('Tool approval requested', {
          approvalId: part.approvalId, toolCallId: part.toolCall.toolCallId, toolName,
        });
        yield {
          type: 'tool-approval-request',
          approvalId: part.approvalId,
          toolCallId: part.toolCall.toolCallId,
          toolName,
          input,
        };
      } else if (part.type === 'tool-output-denied') {
        const toolInfo = toolCallMap.get(part.toolCallId);
        logger.info('Tool output denied', { toolCallId: part.toolCallId, toolName: toolInfo?.name });
        yield {
          type: 'tool-output-denied',
          toolCallId: part.toolCallId,
          toolName: toolInfo?.name ?? 'unknown',
        };
      } else if (part.type === 'error') {
        interface ErrorPart {
          error?: {
            type?: string;
            message?: string;
            [key: string]: unknown;
          };
        }
        const errorDetails = (part as ErrorPart).error;
        // Summarized, not dumped: the SDK's error carries requestBodyValues —
        // the whole outgoing request, prompt and tool schemas and all — once
        // per retry attempt.
        logger.error('Stream error received', {
          provider: agent.provider,
          model: agent.model,
          ...summarizeProviderError(errorDetails),
        });

        // Check if this error is related to a tool call or a general stream
        // error. Connection-level failures are never tool-specific, even when
        // a tool call happens to be in flight.
        const lastToolCall = Array.from(toolCallMap.values()).pop();
        if (lastToolCall && errorDetails?.type !== 'overloaded_error' && !isConnectionError(errorDetails)) {
          // Tool-specific error
          yield {
            type: 'tool-call-error',
            toolName: lastToolCall.name,
            error: errorDetails?.message || JSON.stringify(errorDetails),
          };
        } else {
          // General stream error (connection refused, overloaded, rate limit).
          // Normalize to something the user can act on — the raw SDK message
          // for a dead local server is just "Cannot connect to API: ".
          yield {
            type: 'error',
            error: errorDetails ? friendlyAIErrorMessage(errorDetails, agent.provider) : 'Unknown error occurred',
          };
        }
      } else if (part.type === 'start-step') {
        yield { type: 'step-start' };
      } else if (part.type === 'finish-step') {
        // Usage fields can be undefined for some providers — coerce to 0.
        const usage = {
          inputTokens: part.usage.inputTokens ?? 0,
          outputTokens: part.usage.outputTokens ?? 0,
          totalTokens: part.usage.totalTokens ?? 0,
        };
        logger.info('Step finished', { finishReason: part.finishReason, usage });
        yield { type: 'step-finish', finishReason: part.finishReason, usage };
      }
    }

    // Authoritative whole-turn usage, summed across steps by the SDK. Yielded
    // before response-messages so a consumer that stops early still gets it.
    // Best-effort: a provider that reports no usage must not fail the turn.
    try {
      const total = await result.totalUsage;
      yield {
        type: 'usage-total',
        usage: {
          inputTokens: total.inputTokens ?? 0,
          outputTokens: total.outputTokens ?? 0,
          totalTokens: total.totalTokens ?? 0,
        },
      };
    } catch (err) {
      logger.warn('Could not capture totalUsage from streamText result', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // After fullStream drains, capture the SDK's properly-shaped message
    // record (assistant w/ tool-call parts + tool-role results). Caller
    // persists this as the model-context source of truth for next turn.
    try {
      const response = await result.response;
      yield { type: 'response-messages', messages: response.messages as unknown[] };
    } catch (err) {
      logger.warn('Could not capture response.messages from streamText result', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // OpenRouter usage accounting: the served upstream backend + real cost +
    // cached-prompt-token count. The caller folds these into MessageMetrics —
    // servedProvider drives next-turn sticky pinning + the warm/cold badge.
    // Best-effort; absent for non-OpenRouter providers.
    try {
      const pm = await result.providerMetadata;
      const or = pm?.openrouter as
        | { provider?: string; usage?: { cost?: number; promptTokensDetails?: { cachedTokens?: number } } }
        | undefined;
      if (or?.provider || or?.usage) {
        yield {
          type: 'provider-metadata',
          servedProvider: or.provider,
          cost: or.usage?.cost,
          cachedTokens: or.usage?.promptTokensDetails?.cachedTokens,
        };
      }

      // Anthropic reports cache usage on its own metadata, under different
      // keys and separately from input_tokens — a cache read does NOT show up
      // as a smaller inputTokens. Without this the tool-cache breakpoint set
      // in promptCache.ts is unmeasurable: it either works or doesn't and
      // nothing in the app can tell the difference.
      const anth = pm?.anthropic as
        | { cacheCreationInputTokens?: number | null; usage?: { cache_read_input_tokens?: number | null } }
        | undefined;
      if (anth) {
        const read = anth.usage?.cache_read_input_tokens ?? 0;
        const created = anth.cacheCreationInputTokens ?? 0;
        if (read > 0 || created > 0) {
          yield { type: 'provider-metadata', cachedTokens: read, cacheWriteTokens: created };
        }
      }
    } catch (err) {
      logger.warn('Could not capture OpenRouter providerMetadata', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info(`Stream complete, total parts: ${chunkCount}, total length: ${chunks.join('').length}`);
    return chunks.join('');
  } catch (error) {
    logger.error('Error in streamAIResponse:', error);
    throw error;
  }
}
