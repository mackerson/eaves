import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// logger constructs eagerly via electron's app API, unavailable in tests.
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { JavaScriptExecutor } from './JavaScriptExecutor';
import type { ExecutorOptions } from '../../types/code-execution';

// Real-spawn test: agent-generated code must not be able to read secrets out of
// the app environment. We seed fake secret + benign vars, run JS that tries to
// read them in the child process, and assert the secrets are gone.
describe('code executor env scrubbing', () => {
  beforeAll(() => {
    process.env.ENCLAVE_TEST_OPENAI_API_KEY = 'sk-should-be-stripped';
    process.env.ENCLAVE_TEST_GH_TOKEN = 'ghp-should-be-stripped';
    process.env.ENCLAVE_TEST_DB_PASSWORD = 'pw-should-be-stripped';
    process.env.ENCLAVE_TEST_BENIGN = 'keep-me';
  });
  afterAll(() => {
    delete process.env.ENCLAVE_TEST_OPENAI_API_KEY;
    delete process.env.ENCLAVE_TEST_GH_TOKEN;
    delete process.env.ENCLAVE_TEST_DB_PASSWORD;
    delete process.env.ENCLAVE_TEST_BENIGN;
  });

  it('strips secret-bearing vars but preserves benign env in the child', async () => {
    const exec = new JavaScriptExecutor();
    const code = `
      console.log('RESULT:' + JSON.stringify({
        apiKey: process.env.ENCLAVE_TEST_OPENAI_API_KEY ?? null,
        token: process.env.ENCLAVE_TEST_GH_TOKEN ?? null,
        password: process.env.ENCLAVE_TEST_DB_PASSWORD ?? null,
        benign: process.env.ENCLAVE_TEST_BENIGN ?? null,
      }));
    `;
    const result = await exec.executeCode(code, { timeout: 15000 } as ExecutorOptions);
    expect(result.success).toBe(true);

    const line = result.stdout.split('\n').map(s => s.trim()).find(s => s.startsWith('RESULT:'));
    expect(line, `no RESULT line in stdout: ${result.stdout}`).toBeDefined();
    const parsed = JSON.parse(line!.slice('RESULT:'.length));

    expect(parsed.apiKey).toBeNull();
    expect(parsed.token).toBeNull();
    expect(parsed.password).toBeNull();
    expect(parsed.benign).toBe('keep-me');
  }, 20000);
});
