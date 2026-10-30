import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, guard, isPrivateBind, isTailscaleAddress } from './app.ts';
import { loadConfig, parseConfig } from './config.ts';
import { applyConfigUpdate, readConfigView } from './configEdit.ts';
import { run } from './exec.ts';
import type { ParsedInput } from './input.ts';
import type { TermEvent } from '../shared/types.ts';
import { ENTER_DELAY_MS, logInput, parseInput, sendInput } from './input.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { Runner } from './runner.ts';
import { clampSize, newSession, resizeWindow } from './tmux.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(ok());
});

describe('parseInput', () => {
  it('accepts text or one allowlisted key', () => {
    expect(parseInput({ pane: '%3', text: 'hello', enter: true })).toEqual({ pane: '%3', text: 'hello', enter: true });
    expect(parseInput({ pane: '%3', text: '-rf; $(x)' })).toEqual({ pane: '%3', text: '-rf; $(x)', enter: false });
    expect(parseInput({ pane: '%3', key: 'C-c' })).toEqual({ pane: '%3', key: 'C-c' });
    expect(parseInput({ pane: '%3', key: 'PPage' })).toEqual({ pane: '%3', key: 'PPage' });
    expect(parseInput({ pane: '%3', key: 'BSpace', count: 7 })).toEqual({ pane: '%3', key: 'BSpace', count: 7 });
    expect(parseInput({ pane: '%3', key: 'BSpace', count: 1 })).toEqual({ pane: '%3', key: 'BSpace' });
    expect(parseInput({ pane: '%3', text: 'x', now: true })).toEqual({ pane: '%3', text: 'x', enter: false, now: true });
    expect(parseInput({ pane: '%3', text: 'x', now: 'yes' })).toEqual({ pane: '%3', text: 'x', enter: false });
  });

  it('rejects everything else', () => {
    for (const body of [null, 'x', {}, { pane: 'agent:0.0', text: 'x' }, { pane: '%3' }, { pane: '%3', text: 'x', key: 'Enter' }, { pane: '%3', key: 'F1' }, { pane: '%3', key: 'Enter; kill-server' }, { pane: '%3', text: '' }, { pane: '%3', text: 5 }, { pane: '%3', text: 'a\0b' }, { pane: '%3', text: 'x'.repeat(20001) }, { pane: '%3', key: 'BSpace', count: 0 }, { pane: '%3', key: 'BSpace', count: 101 }, { pane: '%3', key: 'BSpace', count: 1.5 }, { pane: '%3', key: 'BSpace', count: '3' }]) {
      expect(typeof parseInput(body)).toBe('string');
    }
  });
});

describe('sendInput', () => {
  it('sends text literally, then Enter after a pause when asked', async () => {
    const t0 = Date.now();
    expect(await sendInput({ pane: '%3', text: '-l Enter; rm -rf ~', enter: true })).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(ENTER_DELAY_MS - 5);
    expect(mockRun.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['tmux', ['send-keys', '-t', '%3', '-l', '--', '-l Enter; rm -rf ~']],
      ['tmux', ['send-keys', '-t', '%3', 'Enter']],
    ]);
  });

  it("sends text, then Claude Code's send-now chord (Ctrl+X Ctrl+S) after the same pause", async () => {
    const t0 = Date.now();
    expect(await sendInput({ pane: '%3', text: 'also add tests', enter: false, now: true })).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(ENTER_DELAY_MS - 5);
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '%3', '-l', '--', 'also add tests'], ['send-keys', '-t', '%3', 'C-x', 'C-s']]);
  });

  it('sends a key, and text without Enter', async () => {
    await sendInput({ pane: '%3', key: 'BTab' });
    await sendInput({ pane: '%3', text: 'y', enter: false });
    await sendInput({ pane: '%3', key: 'BSpace', count: 3 });
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([['send-keys', '-t', '%3', 'BTab'], ['send-keys', '-t', '%3', '-l', '--', 'y'], ['send-keys', '-t', '%3', 'BSpace', 'BSpace', 'BSpace']]);
  });

  it("escapes a trailing ';' which tmux would otherwise eat as a command separator", async () => {
    await sendInput({ pane: '%3', text: 'ls -la;', enter: false });
    expect(mockRun.mock.calls[0]![1].at(-1)).toBe('ls -la\\;');
    await sendInput({ pane: '%3', text: 'a\nb;', enter: false });
    expect(mockRun.mock.calls[1]![1].at(-1)).toBe('a\nb\\;');
  });

  it('pastes multi-line text through a tmux buffer', async () => {
    await sendInput({ pane: '%3', text: 'a\nb', enter: false });
    const buffer = mockRun.mock.calls[0]![1][2];
    expect(buffer).toMatch(/^nightshift-\d+-\d+$/);
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([
      ['set-buffer', '-b', buffer, '--', 'a\nb'],
      ['paste-buffer', '-p', '-d', '-b', buffer, '-t', '%3'],
    ]);
    await sendInput({ pane: '%3', text: 'c\nd', enter: false });
    expect(mockRun.mock.calls[2]![1][2]).not.toBe(buffer);
  });

  it('reports tmux failures and does not press Enter after a failed text', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find pane: %3\n", timedOut: false });
    expect(await sendInput({ pane: '%3', text: 'x', enter: true })).toBe("can't find pane: %3");
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});

describe('logInput', () => {
  it('appends one JSON line per input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-input-'));
    const file = path.join(dir, 'nested/input.log');
    await logInput(file, 'app', { pane: '%3', text: 'hi', enter: true });
    await logInput(file, 'app', { pane: '%3', key: 'C-c' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toMatchObject([{ project: 'app', pane: '%3', text: 'hi', enter: true }, { project: 'app', pane: '%3', key: 'C-c' }]);
    await rm(dir, { recursive: true });
  });

  it('writes concurrent inputs one after another without losing any while rotating', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-input-'));
    const file = path.join(dir, 'input.log');
    // 한 줄이 약 90바이트: 두 줄이 쌓이면 한 번만 돌린다
    await logInput(file, 'app', { pane: '%3', text: 'first', enter: false }, 150);
    await Promise.all(['a', 'b', 'c'].map((t) => logInput(file, 'app', { pane: '%3', text: t, enter: false }, 150)));
    const all = (await readFile(file, 'utf8')) + (await readFile(`${file}.1`, 'utf8').catch(() => ''));
    expect(['"a"', '"b"', '"c"'].every((t) => all.includes(t))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it('moves a full log aside to .1 before writing more', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-input-'));
    const file = path.join(dir, 'input.log');
    await logInput(file, 'app', { pane: '%3', text: 'old', enter: false }, 10);
    await logInput(file, 'app', { pane: '%3', text: 'new', enter: false }, 10); // 이미 10바이트를 넘었다
    expect(await readFile(`${file}.1`, 'utf8')).toContain('"old"');
    expect(await readFile(file, 'utf8')).not.toContain('"old"');
    expect(await readFile(file, 'utf8')).toContain('"new"');
    await rm(dir, { recursive: true });
  });
});

describe('terminal API', () => {
  let attached = false;
  let gone = false; // pane 이 tmux 에서 사라졌다
  const pane = (id: string) => ({ id, window: 0, windowName: 'w', index: 0, command: 'zsh', active: true, lines: [`snapshot ${id}`] });
  const collector: Collector = {
    git: async () => ({ ok: true, branch: 'main', head: 'h', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h' }),
    since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
    tmux: async (projects) => new Map(projects.map((p, i) => [p.id, { configured: true, exists: true, createdAt: null, attached, lastActivityAt: null, output: [], panes: gone ? [] : [pane(`%${i + 1}`)], waitingPrompt: null, attachCommand: null }])),
    logErrors: async () => NO_LOG,
  };
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function start(opts: { host?: string; demo?: boolean } = {}) {
    const config = parseConfig({ host: opts.host, projects: [{ name: 'open', repoPath: '/r/open', tmuxSession: 'a', allowInput: true }, { name: 'closed', repoPath: '/r/closed', tmuxSession: 'b' }] }, '/base');
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    const monitor = new Monitor({ config, collector, runs: runner.get });
    await monitor.tick();
    const sinks: ((e: TermEvent) => void)[] = [];
    const terminal = { send: vi.fn<(input: ParsedInput) => Promise<string | null>>(async () => null), sendRaw: vi.fn<(paneId: string, bytes: Uint8Array) => Promise<string | null>>(async () => null), stream: vi.fn((_s: string, _p: string, sink: (e: TermEvent) => void) => { sinks.push(sink); sink({ type: 'init', cols: 80, rows: 24, alt: false, data: 'aGk=' }); return () => {}; }), log: vi.fn(), createSession: vi.fn<(name: string, repoPath: string, size: unknown, agent?: string) => Promise<string | null>>(async () => null), killSession: vi.fn<(name: string) => Promise<string | null>>(async () => null), newWindow: vi.fn(async () => ({ pane: '%9' })), killPane: vi.fn<(paneId: string) => Promise<string | null>>(async () => null), cloneRepo: vi.fn(async () => null), resize: vi.fn<(paneId: string, size: { cols: number; rows: number }) => Promise<string | null>>(async () => null), saveUpload: vi.fn(async (id: string, ext: string) => `/up/${id}.${ext}`) };
    const server = createApp({ config, monitor, runner, ...(opts.demo ? {} : { terminal }) }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
    const post = (id: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/${id}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { base, post, terminal, sinks };
  }

  it('sends input only to an allowed project and its own panes, and logs it', async () => {
    const { post, terminal } = await start();
    expect((await post('open', { pane: '%1', text: 'continue', enter: true })).status).toBe(200);
    expect(terminal.send).toHaveBeenCalledExactlyOnceWith({ pane: '%1', text: 'continue', enter: true });
    expect(terminal.log).toHaveBeenCalledExactlyOnceWith('open', { pane: '%1', text: 'continue', enter: true });

    expect((await post('closed', { pane: '%2', text: 'x' })).status).toBe(403); // allowInput 꺼짐
    expect((await post('open', { pane: '%2', text: 'x' })).status).toBe(404); // 남의 pane
    expect((await post('open', { pane: '%99', key: 'Enter' })).status).toBe(404);
    expect((await post('nope', { pane: '%1', text: 'x' })).status).toBe(404);
    expect((await post('open', { pane: '%1', key: 'F12' })).status).toBe(400);
    expect((await post('open', { pane: '%1', text: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${(await start()).base}/open/input`, { method: 'POST', body: '{"pane":"%1","text":"x"}' })).status).toBe(400); // JSON 이 아닌 본문
    expect(terminal.send).toHaveBeenCalledTimes(1);
  });

  it('raw terminal bytes follow the input rules; mouse-only reports are sent but not logged', async () => {
    const { base, terminal } = await start();
    const raw = (id: string, body: unknown) => fetch(`${base}/${id}/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    expect((await raw('open', { pane: '%1', data: b64('\x1b[A') })).status).toBe(200);
    expect(Buffer.from(terminal.sendRaw.mock.calls[0]![1]).toString()).toBe('\x1b[A');
    expect(terminal.log).toHaveBeenCalledExactlyOnceWith('open', { pane: '%1', text: '\x1b[A', enter: false });
    expect((await raw('open', { pane: '%1', data: b64('\x1b[<64;10;5M') })).status).toBe(200);
    expect(terminal.sendRaw).toHaveBeenCalledTimes(2);
    expect(terminal.log).toHaveBeenCalledTimes(1);

    expect((await raw('closed', { pane: '%2', data: b64('x') })).status).toBe(403);
    expect((await raw('open', { pane: '%2', data: b64('x') })).status).toBe(404);
    expect((await raw('open', { pane: '%1', data: '' })).status).toBe(400);
    expect((await raw('open', { pane: '%1', data: 'not base64!' })).status).toBe(400);
    expect((await raw('open', { pane: '%1', data: b64('x'.repeat(4097)) })).status).toBe(400);
    expect(terminal.sendRaw).toHaveBeenCalledTimes(2);
  });

  it('streams a pane of the project as SSE, read-only projects included, and 404s for other panes', async () => {
    const { base, terminal } = await start();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/closed/term/%252`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
    expect(first).toBe('data: {"type":"init","cols":80,"rows":24,"alt":false,"data":"aGk="}\n\n');
    expect(terminal.stream).toHaveBeenCalledWith('b', '%2', expect.any(Function));
    ctrl.abort();
    expect((await fetch(`${base}/open/term/%252`)).status).toBe(404);
  });

  it('opens another shell window under the input rules and returns its pane', async () => {
    const { base, terminal } = await start();
    const open = (id: string, body: unknown = {}) => fetch(`${base}/${id}/windows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await open('open');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pane: '%9' });
    expect(terminal.newWindow).toHaveBeenCalledExactlyOnceWith('a', '/r/open', undefined);
    expect((await open('open', { agent: 'codex' })).status).toBe(200);
    expect(terminal.newWindow).toHaveBeenLastCalledWith('a', '/r/open', 'codex');
    for (const agent of ['rm -rf ~', 'constructor', '__proto__', 5]) expect((await open('open', { agent })).status).toBe(400); // 정해진 에이전트만 (상속 이름도 거부)
    expect((await open('closed')).status).toBe(403); // allowInput 꺼짐
    expect((await open('nope')).status).toBe(404);
    expect(terminal.newWindow).toHaveBeenCalledTimes(2);
  });

  it('closes a pane of the project, input allowed or not', async () => {
    const { base, terminal } = await start();
    const close = (id: string, pane: string) => fetch(`${base}/${id}/panes/${encodeURIComponent(pane)}`, { method: 'DELETE' });
    expect((await close('open', '%1')).status).toBe(200);
    expect(terminal.killPane).toHaveBeenCalledExactlyOnceWith('%1');
    expect((await close('open', '%2')).status).toBe(404); // 남의 pane
    expect((await close('closed', '%2')).status).toBe(200); // 입력이 꺼진 프로젝트도 닫을 수 있다 (글자를 보내지 않는다)
    expect(terminal.killPane).toHaveBeenLastCalledWith('%2');
  });

  it('streams several panes of the project over one SSE, each event tagged with its pane', async () => {
    const { base, terminal } = await start();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/open/terms?panes=%251`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(new TextDecoder().decode((await res.body!.getReader().read()).value)).toBe('data: {"type":"init","cols":80,"rows":24,"alt":false,"data":"aGk=","pane":"%1"}\n\n');
    expect(terminal.stream).toHaveBeenCalledWith('a', '%1', expect.any(Function));
    ctrl.abort();
    expect((await fetch(`${base}/open/terms?panes=%251,%252`)).status).toBe(404); // 남의 pane 이 섞임
    expect((await fetch(`${base}/open/terms`)).status).toBe(404);
  });

  it('file saves follow the input rules; unknown projects are 404', async () => {
    const { base } = await start();
    const put = (id: string, headers: Record<string, string> = {}) => fetch(`${base}/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ path: 'a', content: 'x', version: 'v' }) });
    expect((await put('closed')).status).toBe(403); // allowInput 꺼짐
    expect((await put('open', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await put('nope')).status).toBe(404);
    const fs = (id: string) => fetch(`${base}/${id}/fs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', path: 'a' }) });
    expect((await fs('closed')).status).toBe(403); // 파일 다루기도 입력과 같은 조건
    expect((await fetch(`${base}/nope/files`)).status).toBe(404);
  });

  it('serves repository images with their type and a sandboxing CSP, to read-only projects too', async () => {
    const { base } = await start();
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-raw-'));
    await writeFile(path.join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    // git 흉내: 저장소 맨 위는 dir, 아는 파일은 a.svg 하나
    mockRun.mockImplementation(async (_bin, args) => ok(args.includes('rev-parse') ? `${dir}\n` : args.includes('--deleted') || args.includes('--ignored') ? '' : 'a.svg\0'));
    const res = await fetch(`${base}/closed/raw?path=a.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('<svg');
    expect((await fetch(`${base}/closed/raw?path=b.svg`)).status).toBe(404);
    await rm(dir, { recursive: true });
  });

  it('stores an uploaded image under the same rules as input and returns its path', async () => {
    const { base, terminal } = await start();
    const upload = (id: string, body: unknown) => fetch(`${base}/${id}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const png = { type: 'image/png', data: Buffer.from('png!').toString('base64') };
    const ok = await upload('open', png);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: '/up/open.png' });
    expect(terminal.saveUpload).toHaveBeenCalledExactlyOnceWith('open', 'png', Buffer.from('png!'));
    expect((await upload('open', { type: 'text/plain', data: 'aGk=' })).status).toBe(400);
    expect((await upload('closed', png)).status).toBe(403);
    expect((await upload('nope', png)).status).toBe(404);
  });

  it('fits an unattached session to the viewer, but never one with a terminal attached', async () => {
    const { base, terminal } = await start();
    const fit = (id: string, paneId: string, body: unknown) => fetch(`${base}/${id}/panes/${encodeURIComponent(paneId)}/fit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await fit('open', '%1', { cols: 96, rows: 30 })).status).toBe(200);
    expect(terminal.resize).toHaveBeenCalledExactlyOnceWith('%1', { cols: 96, rows: 30 });
    expect((await fit('closed', '%2', { cols: 96, rows: 30 })).status).toBe(200); // 입력이 꺼진 프로젝트도 크기는 맞춘다 (글자를 보내지 않는다)
    expect((await fit('open', '%2', { cols: 96, rows: 30 })).status).toBe(404); // 남의 pane
    // 맞추는 사이 pane 이 닫혔으면 할 일이 없을 뿐이다. 아직 있는데 실패하면 오류
    terminal.resize.mockResolvedValueOnce('no such pane');
    expect((await fit('open', '%1', { cols: 90, rows: 30 })).status).toBe(500);
    terminal.resize.mockImplementationOnce(async () => {
      gone = true;
      return "can't find pane: %1";
    });
    expect((await fit('open', '%1', { cols: 90, rows: 30 })).status).toBe(200);
    gone = false;
    attached = true;
    const again = await start();
    const res = await fetch(`${again.base}/open/panes/%251/fit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cols":96,"rows":30}' });
    expect(res.status).toBe(409);
    expect(again.terminal.resize).not.toHaveBeenCalled();
    attached = false;
  });

  it('surfaces tmux failures', async () => {
    const { post, terminal } = await start();
    terminal.send.mockResolvedValueOnce("can't find pane");
    const res = await post('open', { pane: '%1', key: 'Enter' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "can't find pane" });
  });

  it('refuses input when exposed beyond loopback/Tailscale, and in demo mode', async () => {
    for (const host of ['0.0.0.0', '192.168.0.10']) {
      const exposed = await start({ host });
      expect((await exposed.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
      expect(exposed.terminal.send).not.toHaveBeenCalled();
    }
    // Tailscale 주소 바인딩은 tailnet 안에서만 닿으므로 허용
    const tailnet = await start({ host: '100.101.102.103' });
    expect((await tailnet.post('open', { pane: '%1', text: 'x' })).status).toBe(200);

    const demo = await start({ demo: true });
    expect((await demo.post('open', { pane: '%1', text: 'x' })).status).toBe(403);
  });
});

describe('newSession', () => {
  it('creates a detached shell session in the directory, without any command', async () => {
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find session", timedOut: false }).mockResolvedValueOnce(ok());
    expect(await newSession('agent', '/repo/app')).toBeNull();
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([
      ['has-session', '-t', '=agent'],
      ['new-session', '-d', '-s', 'agent', '-c', '/repo/app', '-x', '120', '-y', '40'],
    ]);
  });

  it('uses the requested size, clamped to a sane range', async () => {
    expect(clampSize(96, 30)).toEqual({ cols: 96, rows: 30 });
    expect(clampSize('abc', undefined)).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(5, 5000)).toEqual({ cols: 40, rows: 100 });
    expect(clampSize(-3, 0)).toEqual({ cols: 120, rows: 40 });
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce(ok());
    await newSession('agent', '/repo/app', { cols: 96, rows: 30 });
    expect(mockRun.mock.calls[1]![1].slice(-4)).toEqual(['-x', '96', '-y', '30']);
    const before = mockRun.mock.calls.length;
    await resizeWindow('%7', { cols: 88, rows: 30 });
    expect(mockRun.mock.calls[before]![1]).toEqual(['resize-window', '-t', '%7', '-x', '88', '-y', '30']);
  });

  it('leaves an existing session alone and reports failures', async () => {
    expect(await newSession('agent', '/repo/app')).toBeNull(); // has-session 성공
    expect(mockRun).toHaveBeenCalledTimes(1);
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '', timedOut: false }).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'duplicate session: agent\n', timedOut: false });
    expect(await newSession('agent', '/repo/app')).toBe('duplicate session: agent');
  });
});

describe('session API', () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  let dir = '';
  beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-session-'))));
  afterAll(() => rm(dir, { recursive: true }));

  async function start(opts: { host?: string; demo?: boolean } = {}) {
    const file = path.join(dir, `c-${servers.length}.json`);
    await writeFile(file, JSON.stringify({ host: opts.host, projects: [{ name: 'Old', repoPath: '/r/old', tmuxSession: 'old', testCommand: 'npm test' }, { name: 'NoSession', repoPath: '/r/none' }] }));
    const { config } = loadConfig(file, '/base');
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    const collector: Collector = {
      git: async () => ({ ok: true, branch: 'main', head: 'h', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h' }),
      since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
      tmux: async () => new Map(),
      logErrors: async () => NO_LOG,
    };
    const monitor = new Monitor({ config, collector, runs: runner.get });
    await monitor.tick();
    const createSession = vi.fn<(name: string, repoPath: string, size?: unknown, agent?: string) => Promise<string | null>>(async (name) => (name === 'bad name' ? '세션 이름이 올바르지 않습니다' : null));
    const cloneRepo = vi.fn<(url: string, repoPath: string) => Promise<string | null>>(async (url) => (url.includes('nope') ? 'repository not found' : null));
    const terminal = { send: vi.fn(async () => null), sendRaw: vi.fn(async () => null), stream: vi.fn(() => () => {}), log: vi.fn(), createSession, killSession: vi.fn(async () => null), newWindow: vi.fn(async () => ({ pane: '%9' })), killPane: vi.fn(async () => null), cloneRepo, resize: vi.fn(async () => null), saveUpload: vi.fn(async () => '/up/x.png') };
    const configEditor = {
      view: () => readConfigView(file, '/base'),
      update: async (body: unknown) => {
        applyConfigUpdate(file, '/base', body);
        await monitor.setConfig(loadConfig(file, '/base').config, collector);
        return readConfigView(file, '/base');
      },
    };
    const server = createApp({ config, monitor, runner, configEditor, ...(opts.demo ? {} : { terminal }) }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = async (p: string, body?: unknown, method = 'POST') => {
      const res = await fetch(`${base}${p}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      return [res.status, await res.json()] as const;
    };
    return { post, createSession, cloneRepo, monitor, file };
  }

  it('creates a session and registers it as a project in one step', async () => {
    const { post, createSession, monitor, file } = await start();
    expect(await post('/sessions', { name: 'New Agent', repoPath: '~/code/new', tmuxSession: 'new-agent', allowInput: true, testCommand: 'id' })).toEqual([200, { id: 'new-agent' }]);
    expect(createSession).toHaveBeenCalledExactlyOnceWith('new-agent', '~/code/new', { cols: 120, rows: 40 }, undefined);
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['old', 'nosession', 'new-agent']);
    const added = loadConfig(file, '/base').config.projects[2]!;
    expect(added).toMatchObject({ name: 'New Agent', tmuxSession: 'new-agent', allowInput: true, testCommand: null });
    // 기존 프로젝트의 명령은 그대로
    expect(loadConfig(file, '/base').config.projects[0]!.testCommand).toBe('npm test');
  });

  it('ends a session whether or not input is allowed', async () => {
    const { post } = await start();
    expect((await post('/projects/nope/session', undefined, 'DELETE'))[0]).toBe(404);
    expect(await post('/projects/old/session', undefined, 'DELETE')).toEqual([200, { ok: true }]); // 입력이 꺼진 프로젝트
  });

  it('starts only a known agent in the new session', async () => {
    const { post, createSession } = await start();
    expect((await post('/sessions', { name: 'A', repoPath: '/r', tmuxSession: 'a1', agent: 'rm -rf /' }))[0]).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
    expect((await post('/sessions', { name: 'A', repoPath: '/r', tmuxSession: 'a1', agent: 'claude' }))[0]).toBe(200);
    expect(createSession).toHaveBeenCalledWith('a1', '/r', { cols: 120, rows: 40 }, 'claude');
  });

  it('a session name alone is enough: the name becomes the project name, the folder is home', async () => {
    const { post, createSession, file } = await start();
    expect(await post('/sessions', { tmuxSession: 'quick', agent: 'claude' })).toEqual([200, { id: 'quick' }]);
    expect(createSession).toHaveBeenCalledWith('quick', '~', { cols: 120, rows: 40 }, 'claude');
    expect(loadConfig(file, '/base').config.projects.at(-1)).toMatchObject({ name: 'quick', tmuxSession: 'quick' });
  });

  it('rejects incomplete, duplicate and invalid requests without registering anything', async () => {
    const { post, createSession, file } = await start();
    expect((await post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: '' }))[0]).toBe(400);
    expect((await post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 'old' }))[0]).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
    expect(await post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 'bad name' })).toEqual([400, { error: '세션 이름이 올바르지 않습니다' }]);
    expect(loadConfig(file, '/base').config.projects).toHaveLength(2);
  });

  it('clones first when a git url is given, and registers nothing if the clone fails', async () => {
    const { post, createSession, cloneRepo, file } = await start();
    expect(await post('/sessions', { name: 'Cl', repoPath: '~/code/cl', tmuxSession: 'cl', gitUrl: 'git@github.com:me/cl.git' })).toEqual([200, { id: 'cl' }]);
    expect(cloneRepo).toHaveBeenCalledExactlyOnceWith('git@github.com:me/cl.git', '~/code/cl');
    expect(createSession).toHaveBeenCalledOnce();
    expect(cloneRepo.mock.invocationCallOrder[0]!).toBeLessThan(createSession.mock.invocationCallOrder[0]!);

    expect((await post('/sessions', { name: 'X', repoPath: '/r/x', tmuxSession: 'x', gitUrl: '/local/path' }))[0]).toBe(400);
    expect((await post('/sessions', { name: 'X', repoPath: '/r/x', tmuxSession: 'x', gitUrl: 'ext::sh -c id' }))[0]).toBe(400);
    expect(await post('/sessions', { name: 'X', repoPath: '/r/x', tmuxSession: 'x', gitUrl: 'https://github.com/me/nope' })).toEqual([400, { error: 'git clone 실패: repository not found' }]);
    expect(createSession).toHaveBeenCalledOnce();
    expect(loadConfig(file, '/base').config.projects.map((p) => p.tmuxSession)).toEqual(['old', null, 'cl']);
  });

  it('hides an unregistered session via config and refuses registered ones', async () => {
    const { post, file } = await start();
    expect(await post('/sessions/scratch/hide')).toEqual([200, { ok: true }]);
    expect(loadConfig(file, '/base').config.hiddenSessions).toEqual(['scratch']);
    await post('/sessions/scratch/hide'); // 중복 추가 없음
    expect(loadConfig(file, '/base').config.hiddenSessions).toEqual(['scratch']);
    expect((await post('/sessions/old/hide'))[0]).toBe(409);
    expect((await post('/sessions/bad%20name/hide'))[0]).toBe(400);
    // DELETE 는 숨김을 되돌린다
    expect(await post('/sessions/scratch/hide', undefined, 'DELETE')).toEqual([200, { ok: true }]);
    expect(loadConfig(file, '/base').config.hiddenSessions).toEqual([]);
  });

  it('deletes a project from the config (its tmux session is left alone)', async () => {
    const { post, file, monitor } = await start();
    expect((await post('/projects/nope', undefined, 'DELETE'))[0]).toBe(404);
    expect(await post('/projects/old', undefined, 'DELETE')).toEqual([200, { ok: true }]);
    expect(loadConfig(file, '/base').config.projects.map((p) => p.id)).toEqual(['nosession']);
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['nosession']);
  });

  it('restarts the session of a registered project', async () => {
    const { post, createSession } = await start();
    expect(await post('/projects/old/session')).toEqual([200, { ok: true }]);
    expect(createSession).toHaveBeenCalledExactlyOnceWith('old', '/r/old', { cols: 120, rows: 40 }, undefined);
    // 보는 화면 크기를 보내면 그 크기로 (범위를 벗어나면 잘라서)
    await post('/projects/old/session', { cols: 96, rows: 5000 });
    expect(createSession).toHaveBeenLastCalledWith('old', '/r/old', { cols: 96, rows: 100 }, undefined);
    expect((await post('/projects/nosession/session'))[0]).toBe(400);
    expect((await post('/projects/nope/session'))[0]).toBe(404);
    await post('/projects/old/session', { agent: 'codex' });
    expect(createSession).toHaveBeenLastCalledWith('old', '/r/old', { cols: 120, rows: 40 }, 'codex');
    expect((await post('/projects/old/session', { agent: 'bash' }))[0]).toBe(400);
  });

  it('refuses in demo mode and when exposed beyond loopback/Tailscale', async () => {
    const demo = await start({ demo: true });
    expect((await demo.post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 's' }))[0]).toBe(403);
    expect((await demo.post('/projects/old/session'))[0]).toBe(403);
    const exposed = await start({ host: '0.0.0.0' });
    expect((await exposed.post('/sessions', { name: 'x', repoPath: '/r', tmuxSession: 's' }))[0]).toBe(403);
    expect((await exposed.post('/projects/old/session'))[0]).toBe(403);
    expect(exposed.createSession).not.toHaveBeenCalled();
  });
});

describe('network guards', () => {
  it('recognizes Tailscale addresses', () => {
    expect(['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1'].map(isTailscaleAddress)).toEqual([true, true, true, true]);
    expect(['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.0.10', '0.0.0.0', '1100.64.0.1'].map(isTailscaleAddress)).toEqual([false, false, false, false, false, false]);
    expect(['127.0.0.1', 'localhost', '::1', '100.64.0.1'].map(isPrivateBind)).toEqual([true, true, true, true]);
    expect(['0.0.0.0', '192.168.0.10', '::'].map(isPrivateBind)).toEqual([false, false, false]);
  });

  it('accepts allowedHosts as Host and Origin on a loopback bind, nothing else', () => {
    const g = guard({ host: '127.0.0.1', allowedHosts: ['mac.tailnet.ts.net'] }) as unknown as (req: object, res: object, next: () => void) => void;
    const check = (method: string, headers: Record<string, string>) => {
      let code = 200;
      const status = (c: number) => {
        code = c;
        return { json: () => {} };
      };
      g({ method, headers, socket: { localPort: 4477 } }, { status }, () => {});
      return code;
    };
    expect(check('GET', { host: 'MAC.tailnet.ts.net' })).toBe(200);
    expect(check('GET', { host: 'evil.example' })).toBe(403);
    expect(check('POST', { host: 'mac.tailnet.ts.net', origin: 'https://mac.tailnet.ts.net' })).toBe(200);
    // 프록시가 Host 를 localhost 로 바꿔 보내도 Origin 이 허용 목록에 있으면 통과
    expect(check('POST', { host: '127.0.0.1:4477', origin: 'https://mac.tailnet.ts.net' })).toBe(200);
    expect(check('POST', { host: 'mac.tailnet.ts.net', origin: 'https://evil.example' })).toBe(403);
    expect(check('POST', { host: '127.0.0.1:4477', origin: 'null' })).toBe(403);
  });

  it('accepts writes only from the exact origin the server is reached at', () => {
    const g = guard({ host: '100.101.102.103', allowedHosts: ['mac.tailnet.ts.net'] }) as unknown as (req: object, res: object, next: () => void) => void;
    const check = (host: string, origin: string) => {
      let code = 200;
      g({ method: 'POST', headers: { host, origin }, socket: { localPort: 4477 } }, { status: (c: number) => ((code = c), { json: () => {} }) }, () => {});
      return code;
    };
    expect(check('100.101.102.103:4477', 'http://100.101.102.103:4477')).toBe(200);
    expect(check('my-mac:4477', 'http://my-mac:4477')).toBe(200);
    expect(check('mac.tailnet.ts.net', 'https://mac.tailnet.ts.net')).toBe(200);
    // 같은 기기의 다른 포트·다른 scheme 에서 띄운 페이지는 거부
    expect(check('100.101.102.103:4477', 'http://100.101.102.103:8443')).toBe(403);
    expect(check('my-mac:4477', 'http://my-mac:8443')).toBe(403);
    expect(check('mac.tailnet.ts.net', 'https://mac.tailnet.ts.net:8443')).toBe(403);
    expect(check('mac.tailnet.ts.net', 'http://mac.tailnet.ts.net')).toBe(403);
    expect(check('mac.tailnet.ts.net:8443', 'http://mac.tailnet.ts.net:8443')).toBe(403); // Host 를 그 포트로 꾸며도 받은 포트와 다르다
  });
});
