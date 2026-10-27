import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, distFiles, guard, slimSnapshot, STREAM_FILES } from './app.ts';
import { parseConfig } from './config.ts';
import { demoCollector } from './demo.ts';
import { Monitor, SNAPSHOT_OUTPUT_CHARS } from './monitor.ts';
import { Runner } from './runner.ts';

const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', testCommand: 'npm test' }] }, '/base');
const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
const runner = new Runner({ timeoutSec: 1, logDir: null, exec });
const monitor = new Monitor({ config, collector: demoCollector(), runs: runner.get });
const server = createApp({ config, monitor, runner }).listen(0, '127.0.0.1');
let base = '';

beforeAll(async () => {
  await monitor.tick();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

describe('ending a session', () => {
  // 두 프로젝트(s, t)가 한 tmux 세션 s 를 본다
  async function setup(killSession: (sess: { exists: boolean; created: string }) => Promise<string | null>) {
    const sess = { exists: true, created: 'A' };
    const cfg = parseConfig({ host: '127.0.0.1', projects: [{ name: 's', repoPath: '/repo/s', tmuxSession: 's' }, { name: 't', repoPath: '/repo/t', tmuxSession: 's' }] }, '/base');
    const raw = () => ({ configured: true, exists: sess.exists, createdAt: sess.created, attached: false, lastActivityAt: null, output: [], panes: [], waitingPrompt: null, attachCommand: 'x' });
    const m = new Monitor({ config: cfg, collector: { ...demoCollector(), tmux: async () => new Map([['s', raw()], ['t', raw()]]) }, runs: runner.get });
    const app = createApp({ config: cfg, monitor: m, runner, terminal: { killSession: () => killSession(sess) } as never }).listen(0, '127.0.0.1');
    await Promise.all([m.tick(), new Promise((r) => app.once('listening', r))]);
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/projects/s`;
    const states = () => m.snapshot.projects.map((p) => p.status.state);
    return { sess, m, url, states, close: () => app.close() };
  }

  it('marks every project on the session off before killing it, undoes that if the kill fails, and marks a session closed elsewhere', async () => {
    let fail: string | null = null;
    const offAtKill: string[][] = [];
    const offIds = () => Object.keys(t.m.exportState().off ?? {});
    const t = await setup(async (sess) => {
      offAtKill.push(offIds());
      if (fail) return fail;
      sess.exists = false;
      return null;
    });
    try {
      fail = 'tmux kill-session 실패';
      expect((await fetch(`${t.url}/session`, { method: 'DELETE' })).status).toBe(400);
      expect(offIds()).toEqual([]);
      fail = null;
      expect((await fetch(`${t.url}/session`, { method: 'DELETE' })).status).toBe(200);
      expect(offAtKill).toEqual([['s', 't'], ['s', 't']]);
      expect(t.states()).toEqual(['off', 'off']);
      // 한 번 더 눌러 실패해도(이미 없는 세션) 꺼 둔 것을 되돌리지 않는다
      fail = "can't find session: s";
      expect((await fetch(`${t.url}/session`, { method: 'DELETE' })).status).toBe(400);
      expect(t.states()).toEqual(['off', 'off']);
      fail = null;

      // 다시 켰다가 터미널에서 끈 세션: 오류로 뜬 것을 꺼 둠으로 돌린다. 돌고 있는 세션은 이렇게 끄지 않는다
      t.sess.exists = true;
      t.sess.created = 'B';
      await t.m.tick();
      t.sess.exists = false;
      await t.m.tick();
      expect(t.states()).toEqual(['error', 'error']);
      expect((await fetch(`${t.url}/off`, { method: 'POST' })).status).toBe(200);
      expect(t.states()).toEqual(['off', 'off']);
      // 다음 tick 전에 다시 켜도 풀린다 (이미 꺼진 것을 알고 있다). 그 뒤에 저절로 꺼지면 오류다
      t.sess.exists = true;
      await t.m.tick();
      expect(offIds()).toEqual([]);
      expect((await fetch(`${t.url}/off`, { method: 'POST' })).status).toBe(409);
      t.sess.exists = false;
      await t.m.tick();
      expect(t.states()).toEqual(['error', 'error']);
    } finally {
      t.close();
    }
  });

  it('two screens ending the same session at once: a slow failure does not undo the other one\'s success', async () => {
    let calls = 0;
    const t = await setup(async (sess) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 100));
        return 'tmux kill-session 실패';
      }
      sess.exists = false;
      return null;
    });
    try {
      const codes = await Promise.all([fetch(`${t.url}/session`, { method: 'DELETE' }), fetch(`${t.url}/session`, { method: 'DELETE' })].map(async (r) => (await r).status));
      expect(codes.sort()).toEqual([200, 400]);
      expect(t.states()).toEqual(['off', 'off']);
    } finally {
      t.close();
    }
  });
});

describe('API', () => {
  it('serves the snapshot', async () => {
    const s = await (await fetch(`${base}/api/snapshot`)).json();
    expect(s.projects).toHaveLength(1);
  });

  it('the live stream drops pane copies and Git lists; one project is served in full', async () => {
    const full = monitor.snapshot.projects[0]!;
    const slim = slimSnapshot(monitor.snapshot).projects[0]!;
    expect(slim.tmux.panes.every((x) => x.lines.length === 0)).toBe(true);
    if (full.since) expect(slim.since).toMatchObject({ commits: [], files: [], partial: true, additions: full.since.additions });
    expect(monitor.snapshot.projects[0]).toBe(full); // 원본은 그대로
    const one = await (await fetch(`${base}/api/projects/${full.id}`)).json();
    expect(one.since?.partial).toBeUndefined();
    expect((await fetch(`${base}/api/projects/nope`)).status).toBe(404);
  });

  it('the live stream cuts long changed-file lists, keeps the real count and drops the Git fingerprint', () => {
    const p = monitor.snapshot.projects[0]!;
    const many = Array.from({ length: STREAM_FILES + 1 }, (_, i) => ({ path: `f${i}`, status: '??' }));
    const big = slimSnapshot({ ...monitor.snapshot, projects: [{ ...p, git: { ...p.git, changedFiles: many, fingerprint: 'x' } }] }).projects[0]!.git;
    expect(big).toMatchObject({ cut: { total: STREAM_FILES + 1 }, fingerprint: '' });
    expect(big.changedFiles).toHaveLength(STREAM_FILES);
    expect(slimSnapshot(monitor.snapshot).projects[0]!.git.cut).toBeUndefined();
    // 잘린 뒤쪽 파일만 바뀌어도 전체 목록의 지문이 바뀐다 (그때 화면이 전체를 다시 받는다)
    const later = many.map((f, i) => (i === STREAM_FILES ? { ...f, status: 'A ' } : f));
    expect(slimSnapshot({ ...monitor.snapshot, projects: [{ ...p, git: { ...p.git, changedFiles: later } }] }).projects[0]!.git.cut!.key).not.toBe(big.cut!.key);
  });

  it('gzips the snapshot, a project and the live stream for clients that accept it', async () => {
    for (const url of ['/api/snapshot', '/api/projects/app']) {
      const r = await fetch(`${base}${url}`, { headers: { 'Accept-Encoding': 'gzip' } });
      expect(r.headers.get('content-encoding')).toBe('gzip');
      expect(await r.json()).toBeTruthy();
      expect((await fetch(`${base}${url}`, { headers: { 'Accept-Encoding': 'identity' } })).headers.get('content-encoding')).toBeNull();
    }
    // 스트림은 스냅샷마다 비워 보내므로 압축해도 첫 스냅샷이 바로 온다
    const stop = new AbortController();
    const r = await fetch(`${base}/api/events`, { headers: { 'Accept-Encoding': 'gzip' }, signal: stop.signal });
    expect(r.headers.get('content-encoding')).toBe('gzip');
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes('\n\n')) text += (await reader.read()).value ?? '';
    expect(JSON.parse(text.slice('data: '.length)).projects).toHaveLength(1);
    stop.abort();
  });

  it('serves built assets gzipped and cached for good, and revalidates index.html', async () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'nightshift-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log(1);'.repeat(100));
    const web = express().use(distFiles(dist)).listen(0, '127.0.0.1');
    await new Promise((ok) => web.once('listening', ok));
    try {
      const at = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
      const js = await fetch(`${at}/assets/index-abc.js`, { headers: { 'Accept-Encoding': 'gzip' } });
      expect(js.headers.get('content-encoding')).toBe('gzip');
      expect(js.headers.get('content-type')).toMatch(/javascript/);
      expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await js.text()).toBe('console.log(1);'.repeat(100));
      expect((await fetch(`${at}/index.html`)).headers.get('cache-control')).toBe('public, max-age=0');
      expect((await fetch(`${at}/assets/nope.js`, { headers: { 'Accept-Encoding': 'gzip' } })).status).toBe(404);
    } finally {
      web.close();
      rmSync(dist, { recursive: true });
    }
  });

  it('runs only registered commands and ignores the request body', async () => {
    const post = (p: string, init: RequestInit = {}) => fetch(`${base}/api/projects/${p}`, { method: 'POST', ...init });
    expect((await post('nope/run/test')).status).toBe(404);
    expect((await post('app/run/deploy')).status).toBe(400);
    expect((await post('app/run/build')).status).toBe(400); // 등록된 build 명령 없음
    const res = await post('app/run/test', { body: JSON.stringify({ command: 'rm -rf /' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(202);
    expect(exec).toHaveBeenCalledExactlyOnceWith('npm test', '/repo/app', 1000, expect.any(AbortSignal));
    expect((await fetch(`${base}/api/projects/app/run/build`, { method: 'DELETE' })).status).toBe(409);
    expect((await fetch(`${base}/api/projects/app/run/deploy`, { method: 'DELETE' })).status).toBe(400);
  });

  it('sends only the tail of long run output in the snapshot and the full output on request', async () => {
    const stdout = `${'x'.repeat(100_000)}END`;
    runner.seed('app', { kind: 'build', command: 'npm run build', running: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 1, timedOut: false, canceled: false, durationMs: 1, stdout, stderr: 'short' });
    monitor.publish();
    const s = await (await fetch(`${base}/api/snapshot`)).json();
    const build = s.projects[0].runs.build;
    expect(build).toMatchObject({ truncated: true, stderr: 'short', exitCode: 1 });
    expect(build.stdout).toHaveLength(SNAPSHOT_OUTPUT_CHARS);
    expect(build.stdout.endsWith('END')).toBe(true);
    expect(s.projects[0].status.state).toBe('error'); // 판정은 잘리지 않은 결과로 한다
    const full = await (await fetch(`${base}/api/projects/app/run/build`)).json();
    expect(full.stdout).toBe(stdout);
    expect(full.truncated).toBeUndefined();
    expect((await fetch(`${base}/api/projects/nope/run/build`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/app/run/deploy`)).status).toBe(400);
  });

  it('rejects cross-origin writes but allows same-origin', async () => {
    const cross = await fetch(`${base}/api/projects/app/run/test`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    // 같은 호스트의 다른 포트(다른 개발 서버)도 다른 출처다
    const otherPort = await fetch(`${base}/api/projects/app/run/test`, { method: 'POST', headers: { Origin: base.replace(/:\d+$/, ':8443') } });
    expect(otherPort.status).toBe(403);
    const same = await fetch(`${base}/api/nope`, { headers: { Origin: base } });
    expect(same.status).toBe(404);
  });

  it('rejects non-loopback Host headers, also when bound to ::1', () => {
    for (const host of ['127.0.0.1', '::1']) {
      const status = vi.fn(() => ({ json: vi.fn() }));
      const next = vi.fn();
      const g = guard({ host }) as unknown as (req: object, res: object, next: () => void) => void;
      g({ method: 'GET', headers: { host: 'evil.example:4477' } }, { status }, next);
      expect(status).toHaveBeenCalledWith(403);
      g({ method: 'GET', headers: { host: 'localhost:4477' } }, { status }, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('on a loopback bind takes the *.ts.net name tailscale serve relays, without allowedHosts', () => {
    const status = vi.fn(() => ({ json: vi.fn() }));
    const next = vi.fn();
    const g = guard({ host: '127.0.0.1' }) as unknown as (req: object, res: object, next: () => void) => void;
    const name = 'training.tail1234.ts.net';
    g({ method: 'GET', headers: { host: name } }, { status }, next);
    // 변경 요청은 그 이름의 https 출처에서만: 다른 tailnet 의 Funnel 페이지나 다른 포트는 막는다
    g({ method: 'POST', headers: { host: name, origin: `https://${name}` } }, { status }, next);
    g({ method: 'POST', headers: { host: `${name}:8443`, origin: `https://${name}:8443` } }, { status }, next);
    expect(next).toHaveBeenCalledTimes(3);
    for (const origin of ['https://evil.tail9999.ts.net', `https://${name}:8443`, `http://${name}`]) {
      status.mockClear();
      g({ method: 'POST', headers: { host: name, origin } }, { status }, next);
      expect(status).toHaveBeenCalledWith(403);
    }
    // 기기 이름을 바꾼 뒤 allowedHosts 에 남은 옛 이름은 새 이름으로의 변경 요청을 못 보낸다
    status.mockClear();
    const renamed = guard({ host: '127.0.0.1', allowedHosts: ['old.tail1234.ts.net'] }) as unknown as (req: object, res: object, next: () => void) => void;
    renamed({ method: 'POST', headers: { host: name, origin: 'https://old.tail1234.ts.net' } }, { status }, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('on a Tailscale bind accepts its own address, MagicDNS names and allowedHosts only', () => {
    const status = vi.fn(() => ({ json: vi.fn() }));
    const next = vi.fn();
    const g = guard({ host: '100.101.102.103', allowedHosts: ['proxy.example'] }) as unknown as (req: object, res: object, next: () => void) => void;
    for (const host of ['100.101.102.103:4477', 'my-mac.tail1234.ts.net', 'my-mac:4477', 'proxy.example', 'localhost:4477']) g({ method: 'GET', headers: { host } }, { status }, next);
    expect(next).toHaveBeenCalledTimes(5);
    g({ method: 'GET', headers: { host: 'evil.example:4477' } }, { status }, next);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('sends a test push through the injected sender, and refuses without one', async () => {
    const testPush = vi.fn<() => Promise<string | null>>(async () => null);
    const withPush = createApp({ config, monitor, runner, testPush }).listen(0, '127.0.0.1');
    await new Promise((resolve) => withPush.once('listening', resolve));
    const url = `http://127.0.0.1:${(withPush.address() as AddressInfo).port}/api/notify/test`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(200);
    testPush.mockResolvedValueOnce('ntfy 서버가 429 로 응답했습니다');
    const failed = await fetch(url, { method: 'POST' });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: 'ntfy 서버가 429 로 응답했습니다' });
    withPush.close();
    // 보내는 수단이 없으면(demo) 거부
    expect((await fetch(`${base}/api/notify/test`, { method: 'POST' })).status).toBe(403);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '없는 API 입니다' });
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});
