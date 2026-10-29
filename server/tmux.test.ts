import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './exec.ts';
import { aboveInput, askedQuestion, compileMatcher, findErrors, findPrompt, isBusy, promptChoices, scrolledUp, stripAnsi, stripVolatile, waitingOnBackground } from './logs.ts';
import { agentOnTty, capturePane, cleanOutput, descendants, etimeSeconds, listPanes, listSessions, lsofCwds, MAX_PANES, parsePanes, resizeWindow, workDirs } from './tmux.ts';

// 줄 세운 실행도 같은 가짜 run 으로 간다
vi.mock('./exec.ts', () => {
  const run = vi.fn();
  return { run, runQueued: (...args: unknown[]) => run(...args) };
});
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

  it("reads Claude Code's multiple-choice question and its numbered choices", () => {
    const rule = '────────────────────────────────────────────────';
    // 넓은 화면, 질문 하나
    const fruit = ['❯ Ask me which fruit I like.', rule, ' ☐ Fruit', 'Which fruit do you like?', '❯ 1. Apple', '     Apple', '  2. Banana', '     Banana', '  3. Type something.', rule, '  5. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
    expect(askedQuestion(fruit)).toEqual({
      prompt: 'Which fruit do you like?',
      choices: [
        { key: '1', label: 'Apple' },
        { key: '2', label: 'Banana' },
        { key: '3', label: 'Type something.' },
        { key: '5', label: 'Chat about this' },
      ],
    });
    // 휴대폰 폭: 질문 여러 개(탭), 긴 질문은 막대를 달고 넘어가며, 오른쪽에 미리보기 상자가 붙는다. 안내 줄도 다음 줄로 넘어간다
    const deploy = [rule, '←  ☐ Deploy  ☐ Color  ✔ Submit  →', '│ Which deployment plan should we pick for the', '│ next release?', '❯ 1. Canary rollout        ┌────────────┐', '  2. Blue-green switch     │ Canary     │', '                           │ rollout    │', '                           └────────────┘', rule, '  Chat about this', 'Enter to select · ↑/↓ to navigate · n to add', 'notes · Esc to cancel'];
    expect(askedQuestion(deploy)).toEqual({
      prompt: 'Which deployment plan should we pick for the next release?',
      choices: [
        { key: '1', label: 'Canary rollout' },
        { key: '2', label: 'Blue-green switch' },
      ],
    });
    // 실제 화면 (48칸): 질문이 길어 머리표가 화면 위로 밀려났다. 질문 본문의 "2) …" 는 선택지가 아니다
    const homelab = ['│ 2) 모아 SOUL.md 배포: 12.2에 줄을 추가합니다.', '│ 하나씩 해 봅니다.', '❯ 1. 전부 진행 (Recommended)', '     백업한 뒤 1~3을 순서대로 하고 E2E까지', '  2. 재시작만 나중에', '     파일만 배포합니다.', '  3. Type something.', rule, '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to', 'cancel'];
    expect(askedQuestion(homelab)?.prompt).toBe('선택지 질문에 답하기를 기다리는 중');
    expect(askedQuestion(homelab)?.choices.map((c) => c.label)).toEqual(['전부 진행 (Recommended)', '재시작만 나중에', 'Type something.', 'Chat about this']);
    // 안내 줄이 맨 아래에 없으면(답한 뒤 대화에 남은 것, 입력칸) 질문이 아니다
    expect(askedQuestion([...fruit, '  ⎿  · Which fruit do you like? → Banana', '✻ Cooked for 2s', rule, '❯ ', rule, '  ⏵⏵ auto mode on'])).toBeNull();
    expect(askedQuestion([' ☐ Fruit', 'Which?', '  1. Apple', 'Enter to select'])).toEqual({ prompt: '선택지 질문에 답하기를 기다리는 중', choices: [{ key: '1', label: 'Apple' }] });
    expect(askedQuestion(['answer', 'Enter to select · ↑/↓ to navigate'])).toBeNull();
  });

  it('on a phone-width screen, sees work by the spinner even when the status line kept another item, and by a cut Codex status line', () => {
    const p = ['esc to interrupt'];
    // 실제 화면 (48칸): 하단 줄이 "esc to interrupt" 를 빼고 "⧉ …" 를 남겼다. 스피너 아래로 팁이 들여 써 붙고, 대기 메시지는 위에 온다
    const box = ['────────', '❯ ', '────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ⧉ 홈'];
    const spinning = ['❯ also tell me a joke after', '  ctrl+x ctrl+s to send now', '✶ Fiddle-faddling… (5m 16s · thinking)', '  ⎿  Tip: Use /btw to ask a quick side question', '         ✔ Update installed · Restart to apply'];
    expect(isBusy([...spinning, ...box], p)).toBe(true);
    // 끝난 뒤엔 같은 하단 줄이어도 쉬는 중이다
    expect(isBusy(['  the end.', '✻ Worked for 7m 2s · done 7:31 PM', ...box], p)).toBe(false);
    expect(isBusy(['  the end.', '✻ Worked for 7m 2s · done 7:31 PM', ...box], p, true)).toBe(false);
    // 들여 쓴 답 본문의 같은 모양은 스피너가 아니다
    expect(isBusy(['  ✢ Nesting… (2s)', ...box], p)).toBe(false);
    // Codex: 머리말이 길면 경과 시간 뒤가 잘린다. 경과 시간이 안 보이면 알 수 없다
    for (const l of ['• Waiting for background terminal (1m 25s • es…', '• Exploring the repository layout (1m 2…', '• Working (2h 3m 1s…']) {
      expect(isBusy([l, '  └ python3 build.py', '› Ask Codex to do anything', '  GPT-6 high · ~/repo', '  ← for agents · ? for shortcuts'], p)).toBe(true);
    }
    for (const l of ['• 다음 단계는 (선택)…', '• 응. 5만 step (50k)으로 통일했어', '  Worked for 12s • Oct 27 at 5:48 PM']) {
      expect(isBusy([l, '› Ask Codex to do anything', '  GPT-6 high · ~/repo', '  ← for agents · ? for shortcuts'], p)).toBe(false);
    }
  });

  it('sees Claude Code waiting for background agents or a Monitor, until something comes after that line', () => {
    const box = ['─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ↓ to manage', '  ⏺ main', '  ◯ general-purpose  Run tests   13s · ↓ 35.3k tokens'];
    const waiting = ['  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)', '⏺ I launched one background agent.', '✻ Waiting for 1 background agent to finish'];
    expect(waitingOnBackground([...waiting, ...box])).toBe(true);
    expect(waitingOnBackground(['✻ Waiting for 2 background agents and 1 dynamic workflow to finish', ...box])).toBe(true);
    // Monitor 를 걸어 두고 턴을 끝냄. 셸만 남은 것은 아니다 (개발 서버일 수 있다)
    expect(waitingOnBackground(['⏺ Watching for flag.txt.', '✻ Worked for 7s · done 1:50 AM · 1 monitor still running', ...box])).toBe(true);
    expect(waitingOnBackground(['✻ Worked for 7s · done 1:50 AM · 2 shells, 1 monitor still running', ...box])).toBe(true);
    expect(waitingOnBackground(['✻ Worked for 8s · done 11:48 PM · 1 shell still running', ...box])).toBe(false);
    expect(waitingOnBackground(['✻ Worked for 8s · done 11:48 PM · 1 Artifact comment monitor still running', ...box])).toBe(false);
    // 들여 쓴 알림 줄, 좁은 화면에서 다음 줄로 넘어간 턴 끝 줄도 본다
    expect(waitingOnBackground([...waiting, '                tmux focus-events off · add …', ...box])).toBe(true);
    expect(waitingOnBackground(['✻ Waiting for 1 background agent to', '  finish', ...box])).toBe(true);
    expect(waitingOnBackground(['✻ Worked for 7s · done 1:50 AM · 1', '  monitor still running', ...box])).toBe(true);
    // 다 끝나고 결과를 받은 뒤에는 옛 줄이 남아 있어도 기다리는 게 아니다
    const after = ['› Message from @general-purpose (ctrl+o to expand)', '⏺ The subagent finished.', '⏺ Agent "Run tests" finished · 1m 48s'];
    expect(waitingOnBackground([...waiting, ...after, '─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'])).toBe(false);
    // 지난 대화를 올려 보다 옛 줄이 보이는 것, 답 본문의 같은 말은 기다리는 게 아니다
    expect(waitingOnBackground([...waiting, '  older text Jump to bottom (click) ↓', '─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'])).toBe(false);
    expect(waitingOnBackground(['⏺ ✻ Waiting for 1 background agent to finish', '─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'])).toBe(false);
    // 일하는 중 판정과는 따로다
    expect(isBusy([...waiting, ...box], ['esc to interrupt'])).toBe(false);
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
    // 지난 대화를 올려 보는 중 (그사이 새 글이 오면 표시가 바뀐다)
    for (const hint of ['Jump to bottom (click) ↓', '1 new message (click) ↓', '12 new messages (ctrl+end) ↓', '3 new messages ↓', 'Jump to bottom: fn+↓ to scroll']) {
      expect(scrolledUp(['older', `  text ${hint}`, '─────', '❯ ', '─────', 'footer'])).toBe(true);
    }
    // 답 본문의 같은 말은 버튼이 아니다
    for (const text of ['latest', '  The inbox has 2 new messages.', '  Press Jump to bottom to go back']) expect(scrolledUp(['older', text, '─────', '❯ ', '─────', 'footer'])).toBe(false);
    // 입력칸 안에 친 가로줄은 테두리가 아니다 (입력칸 안의 줄은 들여 써진다)
    expect(aboveInput(['answer', '─────', '❯ notes', '  ─────', '  more', '─────', 'footer'])).toEqual(['answer']);
    // 입력칸에 친 글이 스피너처럼 생겨도 일이 아니다
    expect(isBusy(['answer', '─────', '❯ look at this:', '  ✢ Nesting… (2s)', ...foot], p)).toBe(false);
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
