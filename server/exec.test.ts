import { describe, expect, it } from 'vitest';
import type { Bin } from './exec.ts';
import { run, runConfigured, runQueued } from './exec.ts';

describe('run', () => {
  it('refuses binaries outside the allowlist', async () => {
    expect(await run('rm' as Bin, ['-rf', '/'])).toMatchObject({ code: null, stderr: '허용되지 않은 명령: rm' });
  });
});

describe('run', () => {
  it('gives the child a UTF-8 locale when the environment has none', async () => {
    const saved = process.env.LANG;
    delete process.env.LANG;
    try {
      const r = await run('git', ['-c', 'alias.env=!env', 'env']);
      expect(r.stdout).toContain('LANG=en_US.UTF-8');
    } finally {
      if (saved !== undefined) process.env.LANG = saved;
    }
  });
});

describe('runQueued', () => {
  it('runs a few at a time and never holds up an unqueued command', async () => {
    const t = performance.now();
    const all = Promise.all(Array.from({ length: 8 }, () => runQueued('git', ['-c', 'alias.nap=!sleep 0.3', 'nap'])));
    const quick = performance.now();
    expect((await run('git', ['--version'])).code).toBe(0);
    expect(performance.now() - quick).toBeLessThan(250);
    expect((await all).every((r) => r.code === 0)).toBe(true);
    // 4개씩 두 번
    expect(performance.now() - t).toBeGreaterThanOrEqual(600);
  });
});

describe('runConfigured', () => {
  const cwd = process.cwd();

  it('keeps stdout and stderr separate and reports the exit code', async () => {
    expect(await runConfigured('echo out; echo err >&2; exit 3', cwd, 5000)).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const r = await runConfigured('sleep 30 & sleep 30', cwd, 200);
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills the process group when aborted', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    const r = await runConfigured('sleep 30 & sleep 30', cwd, 60_000, ac.signal);
    expect(r).toMatchObject({ code: null, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not spawn when the working directory is missing', async () => {
    expect(await runConfigured('echo hi', '/definitely/not/here', 1000)).toMatchObject({ code: null, stdout: '' });
  });
});
