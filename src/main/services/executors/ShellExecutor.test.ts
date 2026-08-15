import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real fs is required (the executor writes/deletes on disk); only mock Electron
// so the logger can resolve a userData path outside an Electron runtime.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { ShellExecutor } from './ShellExecutor';
import { ExecutorOptions } from '../../types/code-execution';

const baseOptions = (workingDirectory: string): ExecutorOptions => ({
  timeout: 15000,
  maxMemory: 256,
  workingDirectory,
  env: {},
  allowNetwork: false,
});

// Exposes the protected cleanup() so the temp-root guard can be tested directly.
class ProbeExecutor extends ShellExecutor {
  cleanupPath(dir: string) {
    return this.cleanup(dir);
  }
}

describe('ShellExecutor filesystem safety', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eaves-proj-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  });

  it('runs in the working directory without deleting it or leaving script debris', async () => {
    const sentinel = path.join(projectDir, 'keep.txt');
    await fs.writeFile(sentinel, 'important');

    const executor = new ShellExecutor();
    const result = await executor.executeCode(
      'mkdir -p sub && echo hi > sub/created.txt && echo done',
      baseOptions(projectDir)
    );

    expect(result.success).toBe(true);
    // The user's directory and its pre-existing contents survive the run.
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    // Work done in the cwd (the project dir) persists — it isn't cleaned up.
    expect(existsSync(path.join(projectDir, 'sub', 'created.txt'))).toBe(true);
    // The generated script never lands in the user's directory.
    expect(existsSync(path.join(projectDir, 'script.sh'))).toBe(false);
  });

  it('caps runaway stdout instead of buffering it unbounded', async () => {
    const executor = new ShellExecutor();
    const result = await executor.executeCode(
      'yes X | head -c 5000000',
      baseOptions('')
    );
    expect(result.stdout.length).toBeLessThan(1_100_000);
    expect(result.stdout).toContain('output truncated');
  });

  it('caps runaway stderr too', async () => {
    const executor = new ShellExecutor();
    const result = await executor.executeCode(
      'yes X | head -c 5000000 1>&2',
      baseOptions('')
    );
    expect(result.stderr.length).toBeLessThan(1_100_000);
    expect(result.stderr).toContain('output truncated');
  });

  it('kills a process that exceeds its timeout and reports 124', async () => {
    const executor = new ShellExecutor();
    const result = await executor.executeCode('sleep 10', {
      ...baseOptions(''),
      timeout: 800,
    });
    expect(result.exitCode).toBe(124);
    expect(result.error).toMatch(/timeout/i);
  });

  it('cleanup refuses to delete a path outside the OS temp root', async () => {
    // A stand-in for "the user's project directory" living outside tmp.
    const outside = path.join(os.homedir(), `.eaves-cleanup-guard-${Date.now()}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'important');
    try {
      await new ProbeExecutor().cleanupPath(outside);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });
});
