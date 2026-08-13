import { describe, it, expect } from 'vitest';
import { friendlyAIErrorMessage, summarizeProviderError } from './aiErrors';

/** Mirror the AI SDK's RetryError → APICallError → AggregateError shape. */
function makeConnectionRefusedError(url: string) {
  const aggregate = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
  const apiCallError = Object.assign(new Error('Cannot connect to API: '), {
    name: 'AI_APICallError',
    cause: aggregate,
    url,
    isRetryable: true,
  });
  return Object.assign(new Error('Failed after 3 attempts. Last error: Cannot connect to API: '), {
    name: 'AI_RetryError',
    reason: 'maxRetriesExceeded',
    errors: [apiCallError, apiCallError, apiCallError],
    lastError: apiCallError,
  });
}

describe('friendlyAIErrorMessage', () => {
  it('maps LM Studio connection refused to an actionable message with the endpoint', () => {
    const error = makeConnectionRefusedError('http://localhost:1234/v1/chat/completions');
    expect(friendlyAIErrorMessage(error, 'lmstudio')).toBe(
      'Cannot reach the model server at http://localhost:1234. Make sure LM Studio is running and the server is started.'
    );
  });

  it('uses the Ollama hint for the ollama provider', () => {
    const error = makeConnectionRefusedError('http://localhost:11434/v1/chat/completions');
    expect(friendlyAIErrorMessage(error, 'ollama')).toBe(
      'Cannot reach the model server at http://localhost:11434. Make sure Ollama is running.'
    );
  });

  it('falls back to a generic hint for unknown providers', () => {
    const error = makeConnectionRefusedError('http://192.168.1.10:8080/v1/chat/completions');
    expect(friendlyAIErrorMessage(error)).toBe(
      'Cannot reach the model server at http://192.168.1.10:8080. Check that the model server is running and reachable.'
    );
  });

  it('detects a bare fetch failure without a URL', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
    });
    expect(friendlyAIErrorMessage(error, 'lmstudio')).toBe(
      'Cannot reach the model server. Make sure LM Studio is running and the server is started.'
    );
  });

  it('names the endpoint the caller dialled when the error carries none', () => {
    // Model listing hits the endpoint directly, so a bare fetch failure has no
    // URL — but the caller knows which server it asked, and "the model server"
    // is unhelpful precisely when several are configured.
    const error = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
    });
    expect(friendlyAIErrorMessage(error, 'ollama', 'http://localhost:11434')).toBe(
      'Cannot reach the model server at http://localhost:11434. Make sure Ollama is running.'
    );
  });

  it('prefers the endpoint the error itself reports over the caller-supplied one', () => {
    const error = makeConnectionRefusedError('http://localhost:1234/v1/chat/completions');
    expect(friendlyAIErrorMessage(error, 'lmstudio', 'http://wrong:9999')).toContain('http://localhost:1234');
  });

  it('does not tell you to start a cloud provider’s server', () => {
    const error = makeConnectionRefusedError('https://api.anthropic.com/v1/messages');
    expect(friendlyAIErrorMessage(error, 'anthropic')).toBe(
      'Cannot reach the model server at https://api.anthropic.com. Check your internet connection.'
    );
  });

  it('passes non-connection errors through unchanged', () => {
    expect(friendlyAIErrorMessage(new Error('Invalid API key'))).toBe('Invalid API key');
  });

  it('handles non-Error values', () => {
    expect(friendlyAIErrorMessage(undefined)).toBe('Unknown error occurred');
    expect(friendlyAIErrorMessage('boom')).toBe('Unknown error occurred');
  });

  it('does not recurse forever on circular cause chains', () => {
    const a: any = new Error('circular');
    a.cause = a;
    expect(friendlyAIErrorMessage(a)).toBe('circular');
  });
});

/**
 * The AI SDK's APICallError carries `requestBodyValues` — the entire outgoing
 * request. Logging the error object wrote the system prompt (core memory
 * included), every message, and every tool schema to a plaintext file, once per
 * retry attempt. Logs are what people attach to bug reports.
 */
describe('summarizeProviderError', () => {
  /** A RetryError shaped like the real thing, payload and all. */
  function retryErrorWithPayload() {
    const apiCallError = Object.assign(new Error('Cannot connect to API: '), {
      name: 'AI_APICallError',
      cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      url: 'http://localhost:11434/v1/chat/completions',
      requestBodyValues: {
        model: 'llama3',
        messages: [
          { role: 'system', content: '### human\nThe user is Robin, works at ACME.' },
          { role: 'user', content: 'what did I tell you about the merger?' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      },
    });
    return Object.assign(new Error('Failed after 3 attempts. Last error: Cannot connect to API: '), {
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      errors: [apiCallError, apiCallError, apiCallError],
      lastError: apiCallError,
    });
  }

  it('keeps the diagnostic fields', () => {
    expect(summarizeProviderError(retryErrorWithPayload())).toMatchObject({
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      attempts: 3,
      url: 'http://localhost:11434/v1/chat/completions',
      code: 'ECONNREFUSED',
    });
  });

  it('carries no part of the request — prompt, messages or tools', () => {
    const serialized = JSON.stringify(summarizeProviderError(retryErrorWithPayload()));

    expect(serialized).not.toContain('requestBodyValues');
    expect(serialized).not.toContain('Robin');
    expect(serialized).not.toContain('merger');
    expect(serialized).not.toContain('read_file');
  });

  it('stays small enough to read', () => {
    // The unsummarized entry for this same failure ran to 22 KB.
    expect(JSON.stringify(summarizeProviderError(retryErrorWithPayload()), null, 2).length).toBeLessThan(600);
  });

  it('keeps the provider’s own error body, which names the real cause', () => {
    const error = Object.assign(new Error('Not Found'), {
      name: 'AI_APICallError',
      statusCode: 404,
      url: 'https://api.example.com/v1/chat',
      responseBody: '{"error":"model \'nope\' not found"}',
    });

    expect(summarizeProviderError(error)).toMatchObject({
      status: 404,
      responseBody: '{"error":"model \'nope\' not found"}',
    });
  });

  it('caps an unbounded response body', () => {
    const error = Object.assign(new Error('boom'), {
      statusCode: 500,
      responseBody: 'x'.repeat(10_000),
    });

    const summary = summarizeProviderError(error);
    expect(summary.responseBody!.length).toBeLessThan(600);
    expect(summary.responseBody).toContain('[truncated]');
  });

  it('handles non-object values', () => {
    expect(summarizeProviderError('boom')).toEqual({ message: 'boom' });
    expect(summarizeProviderError(undefined)).toEqual({ message: 'Unknown error' });
  });
});
