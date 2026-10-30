// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { InputRequest, ProjectSnapshot, TmuxPane } from '../../shared/types.ts';

const { FakeTerminal } = vi.hoisted(() => {
  // xterm 은 jsdom 에서 그릴 수 없다. 받은 바이트·크기·입력 핸들러만 기록하는 가짜로 바꾼다
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];
    resizes: [number, number][] = [];
    resets = 0;
    disposed = false;
    private handlers: ((d: string) => void)[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.all.push(this);
    }
    open() {}
    buffer = { active: { type: 'normal' } };
    // 프로그램이 bracketed paste 를 켠 것처럼 (Claude Code)
    modes = { mouseTrackingMode: 'none', bracketedPasteMode: true };
    wheel: ((ev: WheelEvent) => boolean) | null = null;
    attachCustomWheelEventHandler(h: (ev: WheelEvent) => boolean) {
      this.wheel = h;
    }
    key: ((ev: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler(h: (ev: KeyboardEvent) => boolean) {
      this.key = h;
    }
    focus() {}
    textarea = document.createElement('textarea');
    /** 마우스로 고른 글 */
    selection = '';
    hasSelection() {
      return this.selection !== '';
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = '';
    }
    loadAddon() {}
    osc: Record<number, (data: string) => boolean> = {};
    parser = { registerOscHandler: (id: number, h: (data: string) => boolean) => void (this.osc[id] = h) };
    reset() {
      this.resets++;
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizes.push([cols, rows]);
    }
    write(data: Uint8Array) {
      this.writes.push(new TextDecoder().decode(data));
    }
    onData(h: (d: string) => void) {
      this.handlers.push(h);
      return { dispose: () => {} };
    }
    dispose() {
      this.disposed = true;
    }
    /** 사용자가 터미널에 친 것처럼 */
    type(d: string) {
      this.handlers.forEach((h) => h(d));
    }
  }
  return { FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent<string>);
  }
}

import { TerminalTab } from './ProjectDetail.tsx';

const NOW = '2026-10-04T03:00:00.000Z';
const b64 = (s: string) => btoa(s);

const pane = (id: string, index: number, active: boolean, lines: string[]): TmuxPane => ({ id, window: 0, windowName: 'zsh', index, command: 'zsh', active, lines });

function project(panes: TmuxPane[], allowInput = true): ProjectSnapshot {
  return {
    id: 'api',
    name: 'api-server',
    repoPath: '/repos/api',
    tmuxSession: 'api',
    testCommand: null,
    buildCommand: null,
    logFile: null,
    allowInput,
    git: { ok: true, branch: 'main', head: 'abcdef1234', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: '' },
    since: null,
    lastGitChangeAt: null,
    tmux: { configured: true, exists: true, createdAt: NOW, attached: false, lastActivityAt: NOW, lastOutputChangeAt: NOW, output: ['plain output'], panes, waitingPrompt: null, attachCommand: null },
    logErrors: [],
    status: { state: 'running', reasons: [] },
    runs: { test: null, build: null },
    history: { test: [], build: [] },
  };
}

const ONE = [pane('%12', 0, true, ['snap'])];
const TWO = [pane('%1', 0, true, ['one-snap']), pane('%2', 1, false, ['two-snap'])];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fetchMock = vi.fn<typeof fetch>();
function serve(input: () => Response = () => json(200, { ok: true })) {
  fetchMock.mockImplementation(async () => input());
}
const posts = () => fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && !String(url).endsWith('/fit')).map(([url, init]) => [String(url), JSON.parse(init?.body as string) as InputRequest & { data?: string }] as const);

const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const es = () => FakeEventSource.all.at(-1)!;
const xterm = () => FakeTerminal.all.at(-1)!;
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'pane 에 보낼 입력' });
const type = (value: string) => fireEvent.change(box(), { target: { value } });

async function renderTab(p: ProjectSnapshot) {
  const view = render(<TerminalTab project={p} now={NOW} />);
  await tick();
  return view;
}
/** 보는 컴퓨터의 OS (navigator.platform). 터미널을 만들 때 읽으므로 renderTab 전에 부른다. jsdom 의 기본값은 '' (맥이 아님) */
function platform(value: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, value });
}
/** 서버가 첫 화면을 보냈다 */
const init = (cols = 120, rows = 30, data = 'hello') =>
  act(() => {
    es().emit({ type: 'init', cols, rows, alt: false, data: b64(data) });
  });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  serve();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.all = [];
  FakeTerminal.all = [];
});
afterEach(() => {
  cleanup();
  delete (navigator as { platform?: string }).platform;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('streams the pane: init resets, resizes and writes the seed; out appends; resize follows; the ids are URL-encoded', async () => {
  await renderTab(project(ONE));
  expect(es().url).toBe('/api/projects/api/term/%2512');
  expect(screen.getByRole('status').textContent).toContain('연결 중');
  await init(120, 30);
  expect(xterm().resets).toBe(1);
  expect(xterm().resizes).toEqual([[120, 30]]);
  expect(xterm().writes).toEqual(['hello']);
  expect(screen.getByRole('status').textContent).toContain('실시간');

  act(() => es().emit({ type: 'out', data: b64(' more') }));
  expect(xterm().writes).toEqual(['hello', ' more']);
  act(() => es().emit({ type: 'resize', cols: 100, rows: 40 }));
  expect(xterm().resizes.at(-1)).toEqual([100, 40]);

  // 다시 연결되면 첫 화면이 다시 온다: 지우고 새로 그린다
  await init(100, 40, 'again');
  expect(xterm().resets).toBe(2);
  expect(xterm().writes.at(-1)).toBe('again');
});

test('shows the connection loss only when it lasts, a server error and the pane exit; error and exit close the stream', async () => {
  await renderTab(project(ONE));
  // 잠깐 끊겼다 다시 붙으면(첫 화면이 다시 온다) 끊김을 띄우지 않는다
  await init();
  act(() => es().onerror?.());
  await tick(4000);
  await init();
  await tick(2000);
  expect(screen.getByRole('status').textContent).toContain('실시간');
  // 다시 붙지 못한 채 5초가 지나면 띄운다
  act(() => es().onerror?.());
  await tick(4900);
  expect(screen.getByRole('status').textContent).toContain('실시간');
  await tick(200);
  expect(screen.getByRole('status').textContent).toContain('연결 끊김');
  act(() => es().emit({ type: 'error', message: "can't find session" }));
  expect(screen.getByRole('status').textContent).toContain("can't find session");
  expect(es().closed).toBe(true);

  cleanup();
  await renderTab(project(ONE));
  act(() => es().emit({ type: 'exit' }));
  expect(screen.getByRole('status').textContent).toContain('pane 종료');
  expect(es().closed).toBe(true);
});

test('keys typed into the terminal are posted as raw base64 bytes, one request at a time, and coalesced while one is in flight', async () => {
  let release: (() => void) | null = null;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = () => resolve(json(200, { ok: true })))));
  await renderTab(project(ONE));
  await init();
  act(() => xterm().type('a'));
  act(() => xterm().type('\x1b[A'));
  act(() => xterm().type('한'));
  await tick();
  expect(posts()).toEqual([['/api/projects/api/raw', { pane: '%12', data: b64('a') }]]);
  // 첫 요청이 끝나면 그동안 모인 것이 한 번에 간다
  await act(async () => release!());
  await tick();
  expect(posts()).toHaveLength(2);
  expect(posts()[1]![1].data).toBe(btoa('\x1b[A' + String.fromCharCode(...new TextEncoder().encode('한'))));
});

test('Shift+Enter in the terminal sends ESC+CR (a newline in Claude Code), plain Enter is left to xterm', async () => {
  fetchMock.mockResolvedValue(json(200, { ok: true }));
  await renderTab(project(ONE));
  await init();
  let handled = true;
  act(() => void (handled = xterm().key!(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))));
  await tick();
  expect(handled).toBe(false);
  expect(posts()).toEqual([['/api/projects/api/raw', { pane: '%12', data: b64('\x1b\r') }]]);
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
});

test('mac line-editing keys are sent like Terminal and iTerm do', async () => {
  platform('MacIntel');
  fetchMock.mockResolvedValue(json(200, { ok: true }));
  await renderTab(project(ONE));
  await init();
  const press = (init: KeyboardEventInit) => act(() => void xterm().key!(new KeyboardEvent('keydown', init)));
  press({ key: 'ArrowLeft', metaKey: true });
  await tick();
  press({ key: 'Backspace', altKey: true });
  await tick();
  press({ key: 'ArrowRight', altKey: true });
  await tick();
  expect(posts().map(([, body]) => atob(body.data!)).join('')).toBe('\x01\x1b\x7f\x1bf');
  // 그 밖의 키는 xterm 이 그대로 처리한다. 맥의 Ctrl+C 는 글을 골라 두었어도 중단(⌘C 가 복사), Ctrl+← 는 바꾸지 않는다
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))).toBe(true);
  xterm().selection = 'picked';
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(true);
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true }))).toBe(true);
});

test('on Windows/Linux, Ctrl+Shift+C copies instead of opening the inspector, Ctrl+C copies only a selection, and Ctrl+V is the browser paste', async () => {
  platform('Win32');
  const exec = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  let copied = '';
  exec.mockImplementation(() => {
    copied = (document.body.lastElementChild as HTMLTextAreaElement).value;
    return true;
  });
  await renderTab(project(ONE));
  await init();
  const press = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { cancelable: true, ...init });
    let handled = true;
    act(() => void (handled = xterm().key!(ev)));
    return { handled, prevented: ev.defaultPrevented };
  };
  // 고른 글이 없어도 크롬의 요소 검사로 넘기지 않는다
  expect(press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })).toEqual({ handled: false, prevented: true });
  expect(exec).not.toHaveBeenCalled();
  xterm().selection = 'npm test';
  expect(press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })).toEqual({ handled: false, prevented: true });
  expect(copied).toBe('npm test');
  expect(xterm().selection).toBe('');
  expect(screen.getByText('복사됨')).toBeTruthy();
  // Ctrl+C: 고른 글이 있으면 복사만, 없으면 xterm 이 ^C 를 보낸다 (한글 입력 중이라 key 가 'ㅊ' 여도)
  xterm().selection = 'error line';
  expect(press({ key: 'ㅊ', code: 'KeyC', ctrlKey: true })).toEqual({ handled: false, prevented: true });
  expect(copied).toBe('error line');
  expect(press({ key: 'c', code: 'KeyC', ctrlKey: true }).handled).toBe(true);
  // 복사를 못 했으면 고른 것을 남겨, 다시 누른 Ctrl+C 가 중단으로 가지 않는다
  exec.mockImplementation(() => false);
  xterm().selection = 'keep me';
  expect(press({ key: 'c', code: 'KeyC', ctrlKey: true })).toEqual({ handled: false, prevented: true });
  expect(xterm().selection).toBe('keep me');
  expect(screen.getByText('복사하지 못했습니다')).toBeTruthy();
  expect(press({ key: 'c', code: 'KeyC', ctrlKey: true }).handled).toBe(false);
  // https 에서도 키로 복사할 땐 결과를 바로 아는 쪽으로 쓴다 (navigator.clipboard 는 거절돼도 늦게 안다)
  const writeText = vi.fn(() => Promise.reject(new Error('denied')));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.stubGlobal('isSecureContext', true);
  try {
    expect(press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }).prevented).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(xterm().selection).toBe('keep me');
  } finally {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
  // Ctrl+V 는 xterm(^V) 대신 브라우저의 붙여넣기로 간다
  expect(press({ key: 'v', code: 'KeyV', ctrlKey: true })).toEqual({ handled: false, prevented: false });
  expect(press({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })).toEqual({ handled: false, prevented: false });
  await tick();
  expect(posts()).toEqual([]);
});

test('on Windows/Linux, Ctrl+Backspace deletes a word (^W) while Ctrl+←/→ stay as xterm sends them; the ⌘ keys are left alone', async () => {
  platform('Linux x86_64');
  fetchMock.mockResolvedValue(json(200, { ok: true }));
  await renderTab(project(ONE));
  await init();
  const press = (init: KeyboardEventInit) => act(() => void xterm().key!(new KeyboardEvent('keydown', init)));
  press({ key: 'Backspace', ctrlKey: true });
  await tick();
  press({ key: 'ArrowLeft', altKey: true });
  await tick();
  expect(posts().map(([, body]) => atob(body.data!)).join('')).toBe('\x17\x1bb');
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true }))).toBe(true);
  expect(xterm().key!(new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true }))).toBe(true);
});

/** IME 가 받은 Ctrl+글자 (keyCode 229, xterm 은 버린다) */
function imeKey(code: string, isComposing = true) {
  const ev = new KeyboardEvent('keydown', { key: 'Process', code, ctrlKey: true, isComposing });
  Object.defineProperty(ev, 'keyCode', { value: 229 });
  return ev;
}
/** 조합이 끝나 data 가 확정됐다 */
const compositionEnd = (data: string) => act(() => void xterm().textarea.dispatchEvent(new CompositionEvent('compositionend', { data })));
const sentText = () => posts().map(([, body]) => new TextDecoder().decode(Uint8Array.from(atob(body.data!), (c) => c.charCodeAt(0))));

test('a Ctrl+letter pressed while composing Korean (keyCode 229, dropped by xterm) goes right after xterm sends the composed text', async () => {
  await renderTab(project(ONE));
  await init();
  // 조합 중 Ctrl+X → 조합이 끝나면 xterm 이 확정된 글을 보내고(setTimeout 0, 여기선 그 자리에서 친다) 그 뒤에 ^X. 이어 누른 Ctrl+S 는 그다음
  let handled = true;
  act(() => void (handled = xterm().key!(imeKey('KeyX'))));
  expect(handled).toBe(false);
  await tick();
  expect(posts()).toEqual([]);
  compositionEnd('내');
  act(() => xterm().type('\x1b[<0;3;4M'));
  act(() => xterm().type('내'));
  await tick();
  act(() => xterm().type('\x13'));
  await tick(150);
  expect(sentText().join('')).toBe('\x1b[<0;3;4M내\x18\x13');
});

test('a Ctrl+letter with the IME on also waits when composition ended first, goes at once when nothing is composing, and keeps order across two keys', async () => {
  await renderTab(project(ONE));
  await init();
  // 조합 끝이 키보다 먼저 와도(isComposing 은 이미 false) xterm 이 아직 안 보낸 글 뒤에 간다. 윈도우 IME 처럼 다음 키도 229 면 그 뒤에
  compositionEnd('끝');
  act(() => void xterm().key!(imeKey('KeyX', false)));
  act(() => void xterm().key!(imeKey('KeyS', false)));
  act(() => xterm().type('끝'));
  await tick(150);
  expect(sentText().join('')).toBe('끝\x18\x13');
  // 조합 중이 아니면 바로
  act(() => void xterm().key!(imeKey('KeyD', false)));
  await tick();
  expect(sentText().at(-1)).toBe('\x04');
  // 조합이 끝나지 않으면 잠시 뒤 혼자, 그 전에 다른 키를 누르면 그 키 앞에
  act(() => void xterm().key!(imeKey('KeyU')));
  await tick(150);
  expect(sentText().at(-1)).toBe('\x15');
  act(() => void xterm().key!(imeKey('KeyW')));
  act(() => void xterm().key!(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' })));
  act(() => xterm().type('a'));
  await tick(150);
  expect(sentText().join('').endsWith('\x17a')).toBe(true);
});

test('a control key waiting for the composed text is dropped when sending that text fails', async () => {
  fetchMock.mockImplementation(async () => json(503, { error: 'down' }));
  await renderTab(project(ONE));
  await init();
  act(() => void xterm().key!(imeKey('KeyD')));
  compositionEnd('내');
  act(() => xterm().type('내'));
  await tick(150);
  // ^D 가 앞 글 없이 따로 가지 않는다
  expect(sentText()).toEqual(['내']);
  expect(screen.getByText(/입력을 보내지 못했습니다/)).toBeTruthy();
  // 조합이 끝나길 기다리는 동안 앞 입력이 실패해도 (잠시 뒤 혼자 보내지 않고) 버린다
  act(() => xterm().type('ls'));
  act(() => void xterm().key!(imeKey('KeyD')));
  await tick(150);
  expect(sentText()).toEqual(['내', 'ls']);
});

test('Ctrl+V on a Mac reads an image from this browser\'s clipboard, uploads it and pastes the path; without one it sends ^V; keys typed meanwhile follow', async () => {
  platform('MacIntel');
  let items = [{ types: ['text/plain', 'image/png'], getType: async (t: string) => new Blob(['png!'], { type: t }) }];
  let release = () => {};
  const read = () => new Promise<typeof items>((r) => (release = () => r(items)));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
  vi.stubGlobal('isSecureContext', true);
  fetchMock.mockImplementation(async (url) => json(200, String(url).endsWith('/upload') ? { path: '/up/api-1.png' } : { ok: true }));
  try {
    await renderTab(project(ONE));
    await init();
    // 한글 입력 중이라 key 가 'ㅍ' 여도 자판 위치로 안다
    const ctrlV = () => act(() => void xterm().key!(new KeyboardEvent('keydown', { key: 'ㅍ', code: 'KeyV', ctrlKey: true })));
    ctrlV();
    act(() => xterm().type('hi'));
    await tick();
    expect(posts()).toEqual([]); // 클립보드를 읽는 동안 친 키는 기다린다
    release();
    for (let i = 0; i < 20 && posts().length < 2; i++) await tick(10);
    expect(posts().map(([url, body]) => (url.endsWith('/raw') ? atob(body.data!) : url))).toEqual(['/api/projects/api/upload', '\x1b[200~/up/api-1.png \x1b[201~hi']);
    items = [];
    ctrlV();
    act(() => xterm().type('\r'));
    release();
    await tick();
    expect(atob(posts().at(-1)![1].data!)).toBe('\x16\r');
  } finally {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test('OSC 52 from the program copies to the clipboard and says so', async () => {
  const exec = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  await renderTab(project(ONE));
  await init();
  let copied = '';
  exec.mockImplementation(() => {
    copied = (document.body.lastElementChild as HTMLTextAreaElement).value;
    return true;
  });
  act(() => void xterm().osc[52]!(`c;${btoa(String.fromCharCode(...new TextEncoder().encode('복사할 글')))}`));
  expect(exec).toHaveBeenCalledWith('copy');
  expect(copied).toBe('복사할 글');
  expect(screen.getByText('복사됨')).toBeTruthy();
});

/** 터미널을 손가락으로 누르고 ms 동안 둔다. 움직이면 dx 만큼 옆으로 민다 */
async function press(ms: number, dx = 0) {
  const host = document.querySelector('.xterm-host')!;
  fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 50 }] });
  if (dx) fireEvent.touchMove(host, { touches: [{ clientX: 50 + dx, clientY: 50 }] });
  await tick(ms);
  fireEvent.touchEnd(host, { touches: [] });
}

test('a long press shows the terminal as plain text (wrapped rows joined, trailing blanks dropped) while the stream stays open; 터미널로 goes back', async () => {
  await renderTab(project(ONE));
  await init();
  // 꺾인 줄 끝의 진짜 빈칸은 남기고, 한글이 안 들어가 비워 둔 칸('' 인 칸 뒤에 두 칸 글자)만 뺀다
  const rows: [string, boolean][] = [['abc  ', false], ['def', true], ['second   ', false], ['abcd\0', false], ['한글', true], ['wxyz\0', false], ['F', true], ['', false]];
  const getLine = (i: number) => {
    const r = rows[i];
    const text = r?.[0] ?? '';
    const cell = (c: number) => ({ getWidth: () => (/[가-힣]/.test(text[c] ?? '') ? 2 : 1), getChars: () => (text[c] === '\0' ? '' : (text[c] ?? '')) });
    const str = (trim: boolean, start = 0, end = text.length) => text.slice(start, end).replace('\0', ' ')[trim ? 'trimEnd' : 'toString']();
    return r && { isWrapped: r[1], length: text.length, getCell: cell, translateToString: str };
  };
  xterm().buffer = { active: { type: 'normal', length: rows.length, getLine } } as never;
  // 짧게 누르거나 누른 채 움직이면(스크롤) 그대로다
  await press(300);
  await press(600, 20);
  expect(screen.queryByLabelText(/터미널 글/)).toBeNull();
  await press(600);
  expect(screen.getByLabelText(/터미널 글/).textContent).toBe('abc  def\nsecond\nabcd한글\nwxyz F');
  fireEvent.click(screen.getByRole('button', { name: '터미널로' }));
  expect(screen.queryByLabelText(/터미널 글/)).toBeNull();
  expect(FakeTerminal.all).toHaveLength(1);
  expect(es().closed).toBe(false);
});

test('picking text ends when another pane is chosen, so coming back shows the live terminal', async () => {
  await renderTab(project(TWO));
  await init();
  xterm().buffer = { active: { type: 'normal', length: 0, getLine: () => undefined } } as never;
  await press(600);
  expect(screen.getByLabelText(/터미널 글/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '0.1 zsh' }));
  await tick();
  fireEvent.click(screen.getByRole('button', { name: '0.0 zsh' }));
  await tick();
  expect(screen.queryByLabelText(/터미널 글/)).toBeNull();
});

test('a failed raw send drops what was queued behind it and says so', async () => {
  let fail: ((e: Error) => void) | null = null;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((_, reject) => (fail = reject)));
  await renderTab(project(ONE));
  await init();
  act(() => xterm().type('rm -rf build'));
  act(() => xterm().type('\r'));
  await tick();
  await act(async () => fail!(new Error('network')));
  await tick();
  expect(posts()).toHaveLength(1); // 뒤에 쌓인 Enter 는 보내지 않는다
  expect(screen.getByText(/입력을 보내지 못했습니다/)).toBeTruthy();
});

test('mouse moves without a button are not sent; wheel reports are', async () => {
  await renderTab(project(ONE));
  await init();
  act(() => xterm().type('\x1b[<35;10;5M\x1b[<35;11;5M'));
  await tick();
  expect(posts()).toHaveLength(0);
  act(() => xterm().type('\x1b[<35;12;5M\x1b[<64;12;5M'));
  await tick();
  expect(posts().map(([, body]) => atob(body.data!))).toEqual(['\x1b[<64;12;5M']);
});

test('wheel in a full-screen program without mouse support turns into PgUp/PgDn; with mouse support xterm handles it', async () => {
  await renderTab(project(ONE));
  await init();
  const t = xterm();
  const wheel = (deltaY: number) => t.wheel!(new WheelEvent('wheel', { deltaY, cancelable: true }));
  expect(wheel(-120)).toBe(true); // 일반 화면: xterm 의 스크롤백
  t.buffer.active.type = 'alternate';
  expect(wheel(-60)).toBe(false);
  expect(wheel(-60)).toBe(false);
  expect(wheel(240)).toBe(false);
  await tick();
  await tick();
  expect(posts().map(([, body]) => atob(body.data!)).join('')).toBe('\x1b[5~\x1b[6~\x1b[6~');
  t.modes.mouseTrackingMode = 'any';
  expect(wheel(-120)).toBe(true);
});

test('Codex without mouse support gets a wheel report per row at the pointer instead of PgUp/PgDn', async () => {
  const view = await renderTab(project([{ ...ONE[0]!, command: 'codex' }]));
  await init(120, 30);
  // 120x30 칸을 800x300px 에 그렸다: 한 줄 10px
  view.container.querySelector('.xterm-host')!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 300 }) as DOMRect;
  const t = xterm();
  t.buffer.active.type = 'alternate';
  const wheel = (deltaY: number) => t.wheel!(new WheelEvent('wheel', { deltaY, clientX: 405, clientY: 105, cancelable: true }));
  expect(wheel(-25)).toBe(false); // 두 줄 위로, 5px 남는다
  expect(wheel(15)).toBe(false); // 남은 것과 합쳐 한 줄 아래로
  await tick();
  await tick();
  expect(posts().map(([, body]) => atob(body.data!)).join('')).toBe('\x1b[<64;61;11M\x1b[<64;61;11M\x1b[<65;61;11M');
});

test('a read-only project gets a terminal without stdin, no input bar, and the config hint', async () => {
  await renderTab(project(ONE, false));
  expect(xterm().options.disableStdin).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText(/입력을 보내려면/).textContent).toBe('입력을 보내려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.');
  act(() => xterm().type('x'));
  await tick();
  expect(posts()).toHaveLength(0);
});

test('an unregistered session points to registering first, not to settings', async () => {
  await renderTab({ ...project(ONE, false), id: 'tmux:api' });
  expect(screen.getByText(/입력을 보내려면/).textContent).toMatch(/^입력을 보내려면 먼저 위의 "프로젝트로 등록"/);
});

test('no panes: the snapshot output is shown as text and nothing is streamed', async () => {
  await renderTab(project([]));
  expect(FakeEventSource.all).toHaveLength(0);
  expect(screen.getByLabelText('최근 터미널 출력').textContent).toBe('plain output');
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('switching the pane opens a new stream and disposes the old terminal', async () => {
  await renderTab(project(TWO));
  expect(es().url).toBe('/api/projects/api/term/%251');
  const first = xterm();
  fireEvent.click(screen.getByRole('button', { name: '0.1 zsh' }));
  await tick();
  expect(first.disposed).toBe(true);
  expect(es().url).toBe('/api/projects/api/term/%252');
  expect(FakeEventSource.all[0]!.closed).toBe(true);
});

test('the pane selection survives a new snapshot; when it disappears the view falls back but input stops until a pane is chosen again', async () => {
  const { rerender } = await renderTab(project([pane('%1', 0, false, []), pane('%2', 1, true, [])]));
  expect(es().url).toBe('/api/projects/api/term/%252');
  expect(screen.getByText(/^보낼 곳:/).textContent).toBe('보낼 곳: 0.1 zsh');
  fireEvent.click(screen.getByRole('button', { name: '0.0 zsh' }));
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%251');
  type('rm -rf build');
  rerender(<TerminalTab project={project([pane('%1', 0, false, []), pane('%2', 1, true, [])])} now={NOW} />);
  expect(es().url).toBe('/api/projects/api/term/%251');
  // 남은 pane 이 하나여도 다시 고를 수 있게 목록이 남는다
  rerender(<TerminalTab project={project([pane('%2', 1, true, [])])} now={NOW} />);
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%252');
  expect(screen.getByRole('alert').textContent).toContain('선택한 pane 이 사라졌습니다');
  expect(xterm().options.disableStdin).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(true);
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(posts()).toHaveLength(0);
  expect(box().value).toBe('rm -rf build');
  fireEvent.click(screen.getByRole('button', { name: '0 zsh' }));
  await tick();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([{ pane: '%2', text: 'rm -rf build', enter: true }]);
});

test('+ 새 터미널 opens a window and switches to it once the snapshot has it; read-only projects have no button', async () => {
  serve(() => json(200, { pane: '%13' }));
  const { rerender } = await renderTab(project(ONE));
  fireEvent.click(screen.getByRole('button', { name: '+ 새 터미널' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '셸만' }));
  await tick();
  expect(posts()).toEqual([['/api/projects/api/windows', {}]]);
  expect(screen.queryByRole('menu')).toBeNull();
  // 스냅샷에 들어오기 전에는 보던 pane 그대로 ("사라진 pane" 경고 없이)
  expect(es().url).toBe('/api/projects/api/term/%2512');
  rerender(<TerminalTab project={project([...ONE, pane('%13', 0, false, [])])} now={NOW} />);
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%2513');
  expect(screen.queryByRole('alert')).toBeNull();
  // 에이전트를 고르면 같이 보낸다. 바깥을 누르면 메뉴만 닫힌다
  fireEvent.click(screen.getByRole('button', { name: '+ 새 터미널' }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ 새 터미널' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
  await tick();
  expect(posts().at(-1)).toEqual(['/api/projects/api/windows', { agent: 'codex' }]);
  cleanup();
  await renderTab(project(ONE, false));
  expect(screen.queryByRole('button', { name: '+ 새 터미널' })).toBeNull();
});

test('✕ closes a terminal after asking; closing the one in view moves to another; a lone terminal has no ✕', async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  await renderTab(project(TWO));
  fireEvent.click(screen.getByRole('button', { name: '0.1 zsh' }));
  await tick();
  expect(es().url).toBe('/api/projects/api/term/%252');
  fireEvent.click(screen.getByRole('button', { name: '터미널 0.1 닫기' }));
  await tick();
  expect(confirm).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/api/panes/%252', { method: 'DELETE' });
  expect(es().url).toBe('/api/projects/api/term/%251');
  confirm.mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: '터미널 0.0 닫기' }));
  await tick();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  cleanup();
  await renderTab(project(ONE));
  expect(screen.queryByRole('button', { name: /닫기$/ })).toBeNull();
});

test('나란히 보기 streams every terminal side by side over one connection; the cell used last is the input target; off goes back to one', async () => {
  await renderTab(project(TWO));
  expect(screen.getByRole('button', { name: '나란히 보기' }).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: '나란히 보기' }));
  await tick();
  const open = () => FakeEventSource.all.filter((e) => !e.closed).map((e) => e.url);
  // 연결은 하나 (http/1.1 의 주소당 연결 수 제한). 이벤트는 pane 필드를 보고 그 칸으로 간다
  expect(open()).toEqual(['/api/projects/api/terms?panes=%251%2C%252']);
  act(() => es().emit({ type: 'init', cols: 80, rows: 24, alt: false, data: b64('second'), pane: '%2' }));
  const cells = FakeTerminal.all.filter((x) => !x.disposed);
  expect(cells.map((x) => x.writes.join(''))).toEqual(['', 'second']);
  fireEvent.pointerDown(document.querySelectorAll('.split-cell')[1]!);
  await tick();
  expect(screen.getByText(/^보낼 곳:/).textContent).toBe('보낼 곳: 0.1 zsh');
  fireEvent.click(screen.getByRole('button', { name: '나란히 보기' }));
  await tick();
  expect(open()).toEqual(['/api/projects/api/term/%252']);
  // 켠 상태는 이 브라우저에 기억한다: 다시 열면 나란히 보기로 시작
  fireEvent.click(screen.getByRole('button', { name: '나란히 보기' }));
  cleanup();
  await renderTab(project(TWO));
  expect(screen.getByRole('button', { name: '나란히 보기' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '나란히 보기' }));
  cleanup();
  await renderTab(project(ONE));
  expect(screen.queryByRole('button', { name: '나란히 보기' })).toBeNull();
});

test('the stream is closed and the terminal disposed on unmount', async () => {
  const { unmount } = await renderTab(project(ONE));
  unmount();
  expect(es().closed).toBe(true);
  expect(xterm().disposed).toBe(true);
});

test('a hidden page closes the terminal stream and a visible one opens it again', async () => {
  await renderTab(project(ONE));
  const first = es();
  const setVisibility = (v: string) => {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
  };
  setVisibility('hidden');
  expect(first.closed).toBe(true);
  setVisibility('visible');
  expect(es()).not.toBe(first);
  expect(es().closed).toBe(false);
});

test('after 5 idle minutes the stream rests and any activity reconnects it', async () => {
  await renderTab(project(ONE));
  const first = es();
  await tick(4 * 60_000);
  expect(first.closed).toBe(false);
  await tick(60_000);
  expect(first.closed).toBe(true);
  expect(screen.getByText(/자리를 비운 동안 연결을 쉬는 중/)).toBeTruthy();
  act(() => void window.dispatchEvent(new Event('pointermove')));
  expect(es()).not.toBe(first);
  expect(es().closed).toBe(false);
});

test('Enter sends the text with enter:true, clears the input and keeps focus', async () => {
  await renderTab(project(ONE));
  expect(screen.getByText(/^입력은 선택한 pane 에 그대로 전달됩니다/)).toBeTruthy();
  type('npm test');
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(box().value).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(true);
  await tick();
  expect(posts()).toEqual([['/api/projects/api/input', { pane: '%12', text: 'npm test', enter: true }]]);
  expect(document.activeElement).toBe(box());
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(false);
});

test('Shift+Enter inserts a newline instead of sending', async () => {
  await renderTab(project(ONE));
  type('line');
  const notPrevented = fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
  expect(notPrevented).toBe(true);
  await tick();
  expect(posts()).toHaveLength(0);
});

test('Enter during IME composition does not send', async () => {
  await renderTab(project(ONE));
  type('한글');
  fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
  await tick();
  expect(posts()).toHaveLength(0);
  expect(box().value).toBe('한글');
});

test('pasting an image uploads it and puts the saved path into the input', async () => {
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/upload')) {
      const body = JSON.parse(init.body as string) as { type: string; data: string };
      expect(body.type).toBe('image/png');
      expect(Buffer.from(body.data, 'base64').toString()).toBe('png!');
      return json(200, { path: '/Users/me/.nightshift/uploads/api-1.png' });
    }
    return json(200, { ok: true });
  });
  await renderTab(project(ONE));
  type('이 화면 봐줘');
  const file = new File(['png!'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(box(), { clipboardData: { files: [file], getData: () => '' } });
  await tick();
  // FileReader 는 타이머가 아니라 실제 비동기라 몇 번 더 기다린다
  for (let i = 0; i < 20 && !box().value.includes('uploads'); i++) await tick(10);
  expect(box().value).toBe('이 화면 봐줘 /Users/me/.nightshift/uploads/api-1.png ');
  expect(posts().map(([url]) => url)).toEqual(['/api/projects/api/upload']);
});

test('empty Enter and the 보내기 button send just the Enter key', async () => {
  await renderTab(project(ONE));
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([
    { pane: '%12', key: 'Enter' },
    { pane: '%12', key: 'Enter' },
  ]);
});

test('while an image is uploading, Enter and the send buttons do nothing', async () => {
  let finish: (r: Response) => void = () => {};
  fetchMock.mockImplementation((url, init) => (init?.method === 'POST' && String(url).endsWith('/upload') ? new Promise<Response>((r) => (finish = r)) : Promise.resolve(json(200, { ok: true }))));
  await renderTab(project(ONE));
  type('이거 봐줘');
  fireEvent.paste(box(), { clipboardData: { files: [new File(['png!'], 'a.png', { type: 'image/png' })], getData: () => '' } });
  for (let i = 0; i < 20 && posts().length === 0; i++) await tick(10);
  expect(screen.getByText(/이미지 올리는 중…/, { selector: '.input-target span' })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '보내기' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enter 보내기' }).disabled).toBe(true);
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(posts().map(([url]) => url)).toEqual(['/api/projects/api/upload']);
  expect(box().value).toBe('이거 봐줘');
  await act(async () => finish(json(200, { path: '/tmp/a.png' })));
  await tick();
  expect(box().value).toBe('이거 봐줘 /tmp/a.png ');
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(posts().at(-1)![1]).toEqual({ pane: '%12', text: '이거 봐줘 /tmp/a.png ', enter: true });
});

test('"입력만 하기" omits enter and is disabled while empty', async () => {
  await renderTab(project(ONE));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '입력만 하기' });
  expect(button.disabled).toBe(true);
  type('y');
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([{ pane: '%12', text: 'y' }]);
});

test('"지금 보내기" is only for a Claude Code pane, sends the text with now, and is disabled while empty; 이미지 moves behind 더보기', async () => {
  const view = await renderTab(project([{ ...ONE[0]!, command: 'claude.exe' }]));
  expect(screen.getByRole('button', { name: '이미지' }).className).toBe('more-only');
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '지금 보내기' });
  expect(button.disabled).toBe(true);
  type('테스트도 추가해');
  fireEvent.click(button);
  await tick();
  expect(posts().map(([, body]) => body)).toEqual([{ pane: '%12', text: '테스트도 추가해', now: true }]);
  expect(box().value).toBe('');
  view.unmount();
  await renderTab(project([{ ...ONE[0]!, command: 'codex' }]));
  expect(screen.queryByRole('button', { name: '지금 보내기' })).toBeNull();
  expect(screen.getByRole('button', { name: '이미지' }).className).toBe('');
});

test('special-key buttons send { pane, key } to the selected pane; Ctrl+C asks first', async () => {
  await renderTab(project(TWO));
  fireEvent.click(screen.getByRole('button', { name: '0.1 zsh' }));
  await tick();
  const group = screen.getByRole('group', { name: '특수 키' });
  const keys = group.querySelectorAll('button:not(.more)');
  expect([...keys].map((b) => b.textContent)).toEqual(['Enter', 'Esc', 'Tab', '⇧Tab', '↑', '↓', '←', '→', 'PgUp', 'PgDn', '⌫', 'Ctrl+C', 'Ctrl+D', 'Ctrl+U', 'Ctrl+L']);
  expect([...keys].filter((b) => !b.classList.contains('extra')).map((b) => b.textContent)).toEqual(['Esc', 'Tab', '↑', '↓']);
  const more = screen.getByRole('button', { name: '더보기' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(more);
  expect(group.className).toBe('keys open');
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  for (const name of ['Ctrl+C 보내기 (중단)', 'Shift+Tab 보내기', 'Esc 보내기']) {
    fireEvent.click(screen.getByRole('button', { name }));
    await tick();
  }
  expect(confirm).toHaveBeenCalledOnce();
  expect(posts().map(([, body]) => body)).toEqual([
    { pane: '%2', key: 'C-c' },
    { pane: '%2', key: 'BTab' },
    { pane: '%2', key: 'Escape' },
  ]);
  expect(screen.getByRole('button', { name: 'Ctrl+C 보내기 (중단)' }).className).toContain('caution');
});

test('keys in an empty input are forwarded; with text they edit locally and Tab leaves the box', async () => {
  await renderTab(project(ONE));
  const press = async (init: KeyboardEventInit) => {
    const notPrevented = fireEvent.keyDown(box(), init);
    await tick();
    return !notPrevented;
  };
  expect(await press({ key: 'ArrowUp' })).toBe(true);
  expect(await press({ key: 'Backspace' })).toBe(true);
  expect(await press({ key: 'Tab' })).toBe(true);
  expect(await press({ key: 'Tab', shiftKey: true })).toBe(true);
  expect(await press({ key: 'PageUp' })).toBe(true);
  expect(await press({ key: 'c', ctrlKey: true })).toBe(true);
  expect(posts().map(([, body]) => body.key)).toEqual(['Up', 'BSpace', 'Tab', 'BTab', 'PPage', 'C-c']);

  type('ls');
  expect(await press({ key: 'ArrowUp' })).toBe(false);
  expect(await press({ key: 'Backspace' })).toBe(false);
  expect(await press({ key: 'c', ctrlKey: true })).toBe(false);
  expect(await press({ key: 'Tab' })).toBe(false);
  expect(posts()).toHaveLength(6);
});

test('a 403 shows the server error and puts the text back; the next success clears it', async () => {
  let status = 403;
  fetchMock.mockImplementation(async () => (status === 200 ? json(200, { ok: true }) : json(status, { error: '이 프로젝트는 입력이 허용되지 않습니다' })));
  await renderTab(project(ONE));
  type('rm -rf');
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(screen.getByRole('alert').textContent).toBe('이 프로젝트는 입력이 허용되지 않습니다');
  expect(box().value).toBe('rm -rf');
  status = 200;
  fireEvent.keyDown(box(), { key: 'Enter' });
  await tick();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('on a touch screen Enter inserts a newline, 보내기 sends, and a key button does not pull focus into the input', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {} }));
  await renderTab(project(TWO));
  const input = screen.getByPlaceholderText(/입력 후 보내기/);
  fireEvent.click(screen.getByRole('button', { name: 'Page Up 보내기 (프로그램 안에서 위로)' }));
  await tick();
  expect(document.activeElement).not.toBe(input);
  fireEvent.change(input, { target: { value: 'line' } });
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
  await tick();
  expect(posts().map(([, body]) => body.key)).toEqual(['PPage']);
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await tick();
  expect(document.activeElement).toBe(input);
});

test('on a touch screen, a held Backspace in the empty input keeps repeating: keys pressed while sending are bundled, none dropped', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {} }));
  const replies: (() => void)[] = [];
  fetchMock.mockImplementation((url) => (String(url).includes('/input') ? new Promise((done) => replies.push(() => done(json(200, { ok: true })))) : Promise.resolve(json(200, { ok: true }))));
  await renderTab(project(ONE));
  const input = screen.getByPlaceholderText(/입력 후 보내기/);
  // 비어 보여도 키보드가 지울 글자를 하나 둔다. 그 Backspace 는 막고 pane 으로 넘긴다
  act(() => input.focus());
  expect(box().value).toBe('\u200b');
  for (let i = 0; i < 6; i++) expect(fireEvent.keyDown(box(), { key: 'Backspace', keyCode: 8 })).toBe(false);
  expect(box().value).toBe('\u200b');
  await tick();
  expect(posts().map(([, b]) => [b.key, b.count])).toEqual([['BSpace', undefined]]);
  // 첫 응답이 오면 그사이 누른 다섯 번을 한 번에
  act(() => replies.shift()!());
  await tick();
  expect(posts().map(([, b]) => [b.key, b.count])).toEqual([['BSpace', undefined], ['BSpace', 5]]);
  act(() => replies.shift()!());
  await tick();
  // 키를 못 읽는 키보드(keyCode 229)가 글자를 지워 버려도 pane 의 Backspace 로 보내고 다시 채운다
  fireEvent.change(box(), { target: { value: '' } });
  expect(box().value).toBe('\u200b');
  act(() => replies.shift()!());
  await tick();
  // 친 글은 숨은 글자 없이 보내고, 입력칸을 떠나면 비워 안내 글이 보이게 한다
  fireEvent.change(box(), { target: { value: '\u200b안녕' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  act(() => replies.shift()!());
  await tick();
  expect(posts().slice(2).map(([, b]) => b.text ?? b.key)).toEqual(['BSpace', '안녕']);
  act(() => input.blur());
  expect(box().value).toBe('');
});

test('fits an unattached session to the screen it is opened on, once; an attached one is left alone', async () => {
  const fits = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/panes/%251/fit'));
  await renderTab(project(TWO));
  await init(200, 50);
  await tick(400);
  // 테스트 환경에서는 요소 크기를 잴 수 없어 화면 폭으로 어림한 칸 수(약 120칸)·40줄로 맞춘다
  expect(fits()).toHaveLength(1);
  expect(fits()[0]![1]?.method).toBe('POST');
  expect(JSON.parse(fits()[0]![1]?.body as string)).toMatchObject({ rows: 40 });
  await init(200, 50);
  await tick(400);
  expect(fits()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '화면에 맞추기' }));
  await tick();
  expect(fits()).toHaveLength(2);

  cleanup();
  fetchMock.mockClear();
  const attached = project(TWO);
  attached.tmux.attached = true;
  await renderTab(attached);
  await init(200, 50);
  await tick(400);
  expect(fits()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '화면에 맞추기' })).toBeNull();
});
