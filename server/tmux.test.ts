import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './exec.ts';
import { compileMatcher, findErrors, findPrompt, isBusy, promptChoices, stripAnsi, stripVolatile } from './logs.ts';
import { agentOnTty, capturePane, cleanOutput, descendants, etimeSeconds, listPanes, listSessions, lsofCwds, MAX_PANES, parsePanes, resizeWindow, workDirs } from './tmux.ts';

vi.mock('./exec.ts', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
beforeEach(() => mockRun.mockReset());

describe('listSessions', () => {
  it('parses sessions', async () => {
    mockRun.mockResolvedValueOnce({ code: 0, stdout: 'agent\t1790000000\t1\t1790000300\t1790000600\nother\t1790000100\t1\t1790000100\t\ngarbage\tx\t0\t\t\n', stderr: '', timedOut: false });
    // list-clients: agent 에는 사람 클라이언트(0)와 컨트롤 클라이언트(1), other 에는 컨트롤 클라이언트만 → other 는 attached 가 아니다
    mockRun.mockResolvedValueOnce({ code: 0, stdout: 'agent\t1\nagent\t0\nother\t1\n', stderr: '', timedOut: false });
    const { sessions, error } = await listSessions();
    expect(error).toBeUndefined();
    expect(sessions.get('agent')).toEqual({
      createdAt: new Date(1790000000_000).toISOString(),
      attached: true,
      lastActivityAt: new Date(1790000600_000).toISOString(),
    });
    expect(sessions.get('other')?.attached).toBe(false);
    expect(sessions.has('garbage')).toBe(false);
  });

  it('treats "no server running" as zero sessions', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/default', timedOut: false });
    expect(await listSessions()).toEqual({ sessions: new Map() });
  });

  it('reports an error when tmux cannot be executed', async () => {
    mockRun.mockResolvedValue({ code: null, stdout: '', stderr: 'spawn tmux ENOENT', timedOut: false });
    expect((await listSessions()).error).toContain('ENOENT');
  });
});

describe('panes', () => {
  it('lists panes per session with the active pane first', () => {
    const out = ['agent\t%3\t1\t0\tnode\t1\t0\t40\t157\t/repo\tserver', 'agent\t%1\t0\t0\tclaude\t0\t1\t50\t157\t/repo\tmy\twin', 'agent\t%2\t0\t1\tzsh\t1\t1\t50\t157\t/repo\tmy\twin', 'other\t%9\t0\t0\tzsh\t1\t1\t24\t80\t/x\tzsh', 'bad\tx\t0'].join('\n');
    const panes = parsePanes(out);
    expect(panes.get('agent')!.map((p) => p.id)).toEqual(['%2', '%1', '%3']);
    expect(panes.get('agent')![0]).toEqual({ id: '%2', window: 0, windowName: 'my\twin', index: 1, command: 'zsh', active: true, height: 50, cols: 157, cwd: '/repo' });
    expect(panes.get('other')).toHaveLength(1);
    expect(panes.has('bad')).toBe(false);
  });

  it('caps the number of panes per session', () => {
    const out = Array.from({ length: 12 }, (_, i) => `s\t%${i}\t0\t${i}\tzsh\t0\t1\t24\t80\tw`).join('\n');
    expect(parsePanes(out).get('s')).toHaveLength(MAX_PANES);
  });

  it('returns no panes when tmux fails', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: 'no server running', timedOut: false });
    expect(await listPanes()).toEqual(new Map());
  });
});

describe('workDirs', () => {
  it('finds every process under the panes, most recently started first, and reads their folders', async () => {
    expect([etimeSeconds('05'), etimeSeconds('01:05'), etimeSeconds('02:01:05'), etimeSeconds('3-02:01:05')]).toEqual([5, 65, 7265, 266465]);
    // 10(pane 셸) → 20(codex) → 30(명령) → 40(손자), 50 은 다른 곳. 9 는 pid 가 한 바퀴 돌아 작지만 가장 최근에 떴다
    const ps = ' 10 1 2-00:00:00 -zsh\n 20 10 1-00:00:00 /opt/codex/bin/codex\n 30 20 01:00 /bin/zsh\n 40 30 00:10 node\n 9 20 00:02 python3\n 50 1 00:01 sleep\n 60 50 00:01 sleep\n';
    expect(descendants(ps, [10]).map((p) => [p.pid, p.shell])).toEqual([
      [9, false],
      [40, false],
      [30, true],
      [20, false],
    ]);
    // 나이가 같으면(같은 초에 뜬 셸과 명령) 자식이 먼저다
    expect(descendants(' 30 10 00:05 bash\n 31 30 00:05 python3\n', [10]).map((p) => p.pid)).toEqual([31, 30]);
    expect(lsofCwds('p20\nfcwd\nn/home/me\np30\nfcwd\nn/home/me/repos/app\n')).toEqual(
      new Map([
        [20, '/home/me'],
        [30, '/home/me/repos/app'],
      ]),
    );
    if (process.platform === 'linux') return; // 리눅스는 /proc 을 읽는다
    mockRun.mockImplementation(async (bin) => ({
      code: 0,
      stdout: bin === 'tmux' ? '10\n' : bin === 'ps' ? ps : 'p20\nfcwd\nn/home/me\np30\nfcwd\nn/home/me/repos/app\np40\nfcwd\nn/home/me/repos/app/src\n',
      stderr: '',
      timedOut: false,
    }));
    expect(await workDirs('money')).toEqual([
      { pid: 40, ppid: 30, shell: false, dir: '/home/me/repos/app/src' },
      { pid: 30, ppid: 20, shell: true, dir: '/home/me/repos/app' },
      { pid: 20, ppid: 10, shell: false, dir: '/home/me' },
    ]);
    expect(mockRun).toHaveBeenCalledWith('lsof', ['-a', '-d', 'cwd', '-p', '9,40,30,20', '-Fpn']);
  });
});

describe('capturePane', () => {
  it('captures by pane id with colors, keeping only SGR sequences', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'line 1  \n\x1b[32mgreen\x1b[0m\x1b[2K\x1b]0;title\x07\n\x1b[0m\n\n', stderr: '', timedOut: false });
    expect(await capturePane({ id: '%7', height: 40 })).toEqual(['line 1', '\x1b[32mgreen\x1b[0m']);
    const args = mockRun.mock.calls[0]![1];
    expect(args).toEqual(['-u', 'capture-pane', '-p', '-e', '-J', '-t', '%7', '-S', '-60']);
  });

  it('starts inside the screen when the pane is taller than the limit', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: 'x\n', stderr: '', timedOut: false });
    await capturePane({ id: '%7', height: 130 });
    expect(mockRun.mock.calls[0]![1].at(-1)).toBe('30');
  });

  it('returns nothing when the capture fails', async () => {
    mockRun.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false });
    expect(await capturePane({ id: '%7', height: 40 })).toEqual([]);
  });
});

describe('resizeWindow', () => {
  it('resizes, then unpins the window and keeps the size as the session default', async () => {
    mockRun.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    expect(await resizeWindow('%7', { cols: 100, rows: 30 })).toBeNull();
    expect(mockRun.mock.calls.map((c) => c[1])).toEqual([
      ['resize-window', '-t', '%7', '-x', '100', '-y', '30'],
      ['set-option', '-w', '-t', '%7', '-u', 'window-size'],
      ['set-option', '-t', '%7', 'default-size', '100x30'],
    ]);
    mockRun.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "can't find pane", timedOut: false });
    expect(await resizeWindow('%9', { cols: 80, rows: 24 })).toBe("can't find pane");
  });
});

describe('output cleaning', () => {
  it('keeps only the last 100 lines', () => {
    const out = Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n');
    const lines = cleanOutput(out);
    expect(lines).toHaveLength(100);
    expect(lines[99]).toBe('l149');
  });

  it('strips CSI, OSC and control characters', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok\r\x1b[2K\x08')).toBe('red ok');
  });
});

describe('pattern helpers', () => {
  it('matches plain substrings case-insensitively and /regex/ patterns', () => {
    const match = compileMatcher(['failed', '/^Error:/', '/panic/i']);
    expect(match('Build FAILED')).toBe(true);
    expect(match('Error: boom')).toBe(true);
    expect(match('an error: boom')).toBe(false);
    expect(match('PANIC at the disco')).toBe(true);
    expect(() => compileMatcher(['/(/'])).toThrow();
  });

  it('skips ignored lines when finding errors', () => {
    const lines = ['ok', 'Found 0 errors', 'TypeError: x is not a function', 'no errors found'];
    expect(findErrors(lines, ['error'], ['0 errors', 'no errors'])).toEqual(['TypeError: x is not a function']);
    expect(findErrors(lines, [])).toEqual([]);
  });

  it('finds a prompt only near the bottom of the screen', () => {
    const patterns = ['Do you want to', '(y/n)'];
    expect(findPrompt(['working', '  Do you want to proceed?', '  1. Yes', ''], patterns)).toBe('Do you want to proceed?');
    const scrolledAway = ['Overwrite? (y/n)', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    expect(findPrompt(scrolledAway, patterns)).toBeNull();
    expect(findPrompt(['Do you want to proceed?'], [])).toBeNull();
    // 줄 끝의 (y/n)·[Y/n], 상자 테두리 안의 문구
    expect(findPrompt(['Overwrite file? (y/n)'], patterns)).toBe('Overwrite file? (y/n)');
    expect(findPrompt(['Proceed? [Y/n]: '], ['[y/n]'])).toBe('Proceed? [Y/n]:');
    expect(findPrompt(['│ Do you want to make this edit? │'], patterns)).toBe('│ Do you want to make this edit? │');
  });

  it('ignores prompt words quoted in the middle of conversation text', () => {
    const patterns = ['Do you want to', '(y/n)', '/^\\s*❯\\s*1\\.\\s*Yes/'];
    const chat = ['⏺ 5. 입력 대기 줄 강조: 입력 대기 패턴((y/n), Do you want to 등)에 걸린 줄을 표시', '  알림 예: 입력 대기: ❯ 1. Yes 가 왔습니다', '❯ ', '  ⏵⏵ auto mode on'];
    expect(findPrompt(chat, patterns)).toBeNull();
    expect(findPrompt(['  Do you want to proceed?', '  ❯ 1. Yes', '    2. No'], patterns)).toBe('Do you want to proceed?');
    expect(findPrompt(['  ❯ 1. Yes', '    2. No'], patterns)).toBe('❯ 1. Yes');
  });

  it('collects numbered choices below the prompt', () => {
    const screen = ['1. earlier list item', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for git commands', '   3. No, and tell Claude what to do differently (esc)', ''];
    expect(promptChoices(screen, 'Do you want to proceed?')).toEqual([
      { key: '1', label: 'Yes' },
      { key: '2', label: "Yes, and don't ask again for git commands" },
      { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
    ]);
    expect(promptChoices(['Overwrite? (y/n)'], 'Overwrite? (y/n)')).toEqual([]);
    expect(promptChoices(['x'], 'not on screen')).toEqual([]);
  });

  it('sees the busy marker only in the status lines at the bottom', () => {
    const p = ['esc to interrupt'];
    expect(isBusy(['✻ Hashing… (52s)', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents'], p)).toBe(true);
    expect(isBusy(['• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything'], p)).toBe(true);
    expect(isBusy(['❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'], p)).toBe(false);
    expect(isBusy(['본문에 esc to interrupt 라고 썼다', 'a', 'b', 'c', 'd', 'e', 'f'], p)).toBe(false);
    expect(isBusy(['esc to interrupt'], [])).toBe(false);
    expect(isBusy(['❯ ', '─────', '  ⏵⏵ auto mode on · 1 shell · esc to interrup…'], p)).toBe(true);
    expect(isBusy(['• Working (12s • esc to…'], p)).toBe(true);
    expect(isBusy(['  ⏵⏵ auto mode on (shift+tab to cycle) · esc …'], p)).toBe(true);
    expect(isBusy(['  ⏵⏵ auto mode on · 1 shell · ↓ to manag…'], p)).toBe(false);
  });

  it('on a phone-width screen whose status line dropped the marker, sees work by the spinner or a changing screen', () => {
    const p = ['esc to interrupt'];
    const foot = ['❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) ·'];
    // 생각·도구 실행: 스피너 줄이 팁 줄 아래로 밀려 있어도 본다
    expect(isBusy(['⏺ Counting directories', '✢ Nesting… (2s · ↓ 55 tokens)', '  ⎿  Tip: Did you know you can drag and', '     drop image files into your terminal?', '─────', ...foot], p)).toBe(true);
    // 답을 쓰는 중: 스피너는 없고 글만 바뀐다
    expect(isBusy(['  the lamp knew, because', '─────', ...foot], p)).toBe(false);
    expect(isBusy(['  the lamp knew, because', '─────', ...foot], p, true)).toBe(true);
    // 끝난 줄은 스피너가 아니다
    expect(isBusy(['✻ Sautéed for 5s · done 12:20 AM', ...foot], p)).toBe(false);
    // 하단 줄이 다 들어가 있으면(쉬는 중) 화면이 바뀌어도(입력·스크롤) 일하는 게 아니다
    expect(isBusy(['✢ Nesting… (2s)', '❯ 입력 중', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'], p, true)).toBe(false);
    expect(isBusy([...foot], [], true)).toBe(false);
    // Claude Code 하단 줄이 아닌, 구분점으로 끝나는 셸 출력은 아니다
    expect(isBusy(['$ make', 'step 1 ·'], p, true)).toBe(false);
  });

  it('finds the agent behind a node pane from ps output', () => {
    const ps = ['ttys005  Ss   -zsh', 'ttys005  S+   node /opt/homebrew/bin/codex', 'ttys007  S+   node server.js', '??       S    /Users/u/.codex/bin/codex app-server'].join('\n');
    expect(agentOnTty(ps, 'ttys005')).toBe('codex');
    expect(agentOnTty(ps, 'ttys007')).toBeNull();
    expect(agentOnTty(ps, 'ttys009')).toBeNull();
  });

  it('normalizes spinner and counter churn', () => {
    expect(stripVolatile('✽ Gusting… (10m 8s · ↓ 67.6k tokens)')).toBe(stripVolatile('✻ Gusting… (12m 41s · ↓ 70.1k tokens)'));
    expect(stripVolatile('⠋ building')).toBe(stripVolatile('⠙ building'));
    expect(stripVolatile('editing a.ts')).not.toBe(stripVolatile('editing b.ts'));
  });
});
