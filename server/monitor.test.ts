import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { parseConfig } from './config.ts';
import { demoCollector, demoConfig, seedDemoRuns } from './demo.ts';
import type { Collector, RawTmux } from './monitor.ts';
import { attachCommand, Monitor, NO_LOG } from './monitor.ts';
import { Runner } from './runner.ts';

const T0 = Date.parse('2026-10-04T03:00:00Z');
const noRuns = () => ({ test: null, build: null });
const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', tmuxSession: 'app' }, { name: 'lib', repoPath: '/repo/lib' }] }, '/base');

const git = (over: Partial<GitInfo> = {}): GitInfo => ({
  ok: true, branch: 'main', head: 'h1', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0,
  recentCommits: [{ hash: 'h1', author: 'a', date: new Date(T0 - 60 * 60_000).toISOString(), subject: 's' }], todayCommits: [], fingerprint: JSON.stringify(over.changedFiles ?? []), ...over,
});

function fakeCollector(state: { output: string[]; git: GitInfo; gitThrows?: boolean; tmuxThrows?: boolean }): Collector {
  return {
    async git(p) {
      if (state.gitThrows && p.id === 'lib') throw new Error('boom');
      return state.git;
    },
    since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
    async tmux() {
      if (state.tmuxThrows) throw new Error('tmux down');
      const raw: RawTmux = { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 40 * 60_000).toISOString(), output: state.output, panes: [], waitingPrompt: null, attachCommand: 'tmux attach -t app' };
      return new Map([['app', raw]]);
    },
    logErrors: async () => NO_LOG,
  };
}

describe('Monitor', () => {
  it('tracks output and git changes between ticks', async () => {
    let now = T0;
    const state = { output: ['a'], git: git() };
    const m = new Monitor({ config, collector: fakeCollector(state), runs: noRuns, now: () => now });
    await m.tick();
    const app = () => m.snapshot.projects.find((p) => p.id === 'app')!;
    // 최초 관측: tmux 활동 시각(40분 전) + 마지막 커밋(60분 전) → 정지 의심
    expect(app().status.state).toBe('stalled');
    expect(app().since?.baseline).toMatchObject({ branch: 'main', head: 'h1' });

    now += 5000;
    state.output = ['a', 'b'];
    await m.tick();
    expect(app().tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());
    expect(app().status.state).toBe('running');

    now += 20 * 60_000; // 출력이 20분간 그대로 → 유휴
    await m.tick();
    expect(app().status.state).toBe('idle');

    state.git = git({ clean: false, changedFiles: [{ path: 'x.ts', status: ' M' }] });
    await m.tick();
    expect(app().lastGitChangeAt).toBe(new Date(now).toISOString());
    expect(app().since?.baseline.at).toBe(new Date(T0).toISOString());
  });

  it('ignores spinner-only churn but notices real output in any pane', async () => {
    let now = T0;
    const pane = (id: string, lines: string[]) => ({ id, window: 0, windowName: 'w', index: 0, command: 'zsh', active: id === '%1', lines });
    const state = { panes: [pane('%1', ['\x1b[35m✽\x1b[0m Thinking… (10s · 1.2k tokens)']), pane('%2', ['idle'])] };
    let activity = new Date(T0 - 60_000).toISOString();
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: activity, output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'tmux attach -t app' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    await m.tick();
    const first = m.snapshot.projects[0]!.tmux.lastOutputChangeAt;

    now += 5000;
    state.panes = [pane('%1', ['\x1b[35m✻\x1b[0m Thinking… (15s · 1.9k tokens)']), pane('%2', ['idle'])];
    activity = new Date(now).toISOString(); // tmux 는 스피너 출력에도 활동 시각을 올린다
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(first);

    now += 5000;
    state.panes = [state.panes[0]!, pane('%2', ['compiled successfully'])];
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());

    state.panes = [pane('%1', ['Overwrite file? (y/n)']), state.panes[1]!];
    await m.tick();
    expect(m.snapshot.projects[0]!.status).toEqual({ state: 'waiting', reasons: ['입력 대기: Overwrite file? (y/n)'] });
  });

  it('remembers when an agent last worked; scrolling its screen afterwards does not move it, and it survives a restart', async () => {
    let now = T0;
    const pane = (lines: string[]) => ({ id: '%1', window: 0, windowName: 'w', index: 0, command: 'codex', active: true, lines });
    const state = { panes: [pane(['old answer', '› Ask Codex'])] };
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 60_000).toISOString(), output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'x' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    const app = () => m.snapshot.projects.find((p) => p.id === 'app')!;
    await m.tick();
    // 처음 보는 세션은 그때까지의 출력 시각에서 시작한다
    expect(app().tmux.lastBusyAt).toBe(new Date(T0 - 60_000).toISOString());

    now += 5000;
    state.panes = [pane(['• Working (3s • esc to interrupt)'])];
    await m.tick();
    const worked = new Date(now).toISOString();
    expect(app().tmux.lastBusyAt).toBe(worked);

    // 일을 마친 뒤 휴대폰에서 위로 쓸어 봄: 화면은 바뀌지만 마지막으로 일한 시각은 그대로
    for (const lines of [['done', '› Ask Codex'], ['earlier output', '↓ Back to bottom']]) {
      now += 5000;
      state.panes = [pane(lines)];
      await m.tick();
    }
    expect(app().tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());
    expect(app().tmux.lastBusyAt).toBe(worked);

    const again = new Monitor({ config, collector, runs: noRuns, now: () => now, restore: JSON.parse(JSON.stringify(m.exportState())) });
    await again.tick();
    expect(again.snapshot.projects.find((p) => p.id === 'app')!.tmux.lastBusyAt).toBe(worked);
  });

  it('does not count the redraw after a pane resize as activity', async () => {
    let now = T0;
    const pane = (cols: number, lines: string[]) => ({ id: '%1', window: 0, windowName: 'w', index: 0, command: 'claude', active: true, cols, lines });
    const state = { panes: [pane(120, ['long line wrapped at 120'])] };
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 60_000).toISOString(), output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'x' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    await m.tick();
    const first = m.snapshot.projects[0]!.tmux.lastOutputChangeAt;
    // 휴대폰에서 열어 43칸으로 맞춤 → 다시 그림 (두 tick 에 걸쳐)
    for (const lines of [['long line', 'wrapped at 43'], ['long line', 'wrapped at 43', 'status']]) {
      now += 5000;
      state.panes = [pane(43, lines)];
      await m.tick();
      expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(first);
    }
    // 그 뒤의 출력 변화는 다시 활동이다
    now += 5000;
    state.panes = [pane(43, ['long line', 'wrapped at 43', 'status', 'new work'])];
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());
  });

  it('at phone width, where Claude Code drops "esc to interrupt" from its status line, a changing screen is work', async () => {
    let now = T0;
    const foot = ['─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) ·'];
    const pane = (cols: number, lines: string[]) => ({ id: '%1', window: 0, windowName: 'w', index: 0, command: 'claude', active: true, cols, lines });
    const state = { panes: [pane(140, ['old answer', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'])] };
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 60_000).toISOString(), output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'x' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    const agent = () => m.snapshot.projects[0]!.tmux.agent;
    const tick = async (cols: number, lines: string[]) => {
      now += 5000;
      state.panes = [pane(cols, lines)];
      await m.tick();
      return agent();
    };
    await m.tick();
    expect(agent()).toBe('ready');
    // 휴대폰에서 열어 43칸으로 맞춘 직후의 다시 그림(두 tick)은 일이 아니다
    expect(await tick(43, ['answer', 'rewrapped', ...foot])).toBe('ready');
    expect(await tick(43, ['answer', 'rewrapped', 'status', ...foot])).toBe('ready');
    // 답을 써 내려가는 동안
    expect(await tick(43, ['the harbor was', ...foot])).toBe('busy');
    expect(await tick(43, ['the harbor was quiet', ...foot])).toBe('busy');
    // 다 쓰고 멈춤: 두 tick 조용하면 끝난 것
    const done = ['the end', '✻ Sautéed for 5s · done 12:20 AM', '─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
    await tick(43, done);
    expect(await tick(43, done)).toBe('ready');
    // 쉬는 중인데 하단 줄 다른 항목이 빠져 구분점이 남은 화면: 입력칸에 글을 쳐도(보내기 전) 일이 아니다
    const typing = (prompt: string) => ['the end', '✻ Sautéed for 5s · done 12:20 AM', '─────', prompt, '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) ·'];
    for (const prompt of ['❯ ', '❯ please', '❯ please add', '❯ please add tests']) expect(await tick(43, typing(prompt))).toBe('ready');
  });

  it("at phone width, another pane's output does not make an idle Claude Code pane look busy", async () => {
    let now = T0;
    // 쉬는 Claude 인데 하단 줄 항목("1 feedback draft" 등)이 빠져 구분점이 남은 화면
    const claude = { id: '%1', window: 0, windowName: 'w', index: 0, command: 'claude', active: true, cols: 43, lines: ['answer', '─────', '❯ ', '─────', '  ⏵⏵ auto mode on (shift+tab to cycle) ·'] };
    const shell = (lines: string[]) => ({ id: '%2', window: 1, windowName: 'w', index: 0, command: 'zsh', active: false, cols: 43, lines });
    const state = { panes: [claude, shell(['$ npm run dev'])] };
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 60_000).toISOString(), output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'x' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    await m.tick();
    for (const log of ['GET / 200', 'GET /a 200', 'GET /b 200']) {
      now += 5000;
      state.panes = [claude, shell(['$ npm run dev', log])];
      await m.tick();
      expect(m.snapshot.projects[0]!.tmux.agent).toBe('ready');
    }
  });

  it('isolates a failing project and notifies subscribers', async () => {
    const m = new Monitor({ config, collector: fakeCollector({ output: [], git: git(), gitThrows: true }), runs: noRuns, now: () => T0 });
    const seen: Snapshot[] = [];
    const off = m.subscribe((s) => seen.push(s));
    await m.tick();
    off();
    await m.tick();
    expect(seen).toHaveLength(1);
    const [app, lib] = seen[0]!.projects;
    expect(app!.git.ok).toBe(true);
    expect(lib!.status).toEqual({ state: 'error', reasons: ['수집 실패: boom'] });
    expect(seen[0]!.summary).toMatchObject({ total: 2, sessionsRunning: 1, error: 1 });
  });

  it('keeps a configured session visible when tmux collection throws', async () => {
    const m = new Monitor({ config, collector: fakeCollector({ output: [], git: git(), tmuxThrows: true }), runs: noRuns, now: () => T0 });
    await m.tick();
    const app = m.snapshot.projects[0]!;
    expect(app.tmux).toMatchObject({ configured: true, exists: false, attachCommand: 'tmux attach -t app' });
    expect(app.status).toEqual({ state: 'error', reasons: ['tmux 수집 실패: tmux down'] });
  });

  it('demo mode shows every state', async () => {
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    seedDemoRuns(runner, () => T0);
    const m = new Monitor({ config: demoConfig(config), collector: demoCollector(() => T0), runs: runner.get, demo: true, now: () => T0 });
    await m.tick();
    const states = Object.fromEntries(m.snapshot.projects.map((p) => [p.id, p.status.state]));
    expect(states).toEqual({ 'api-server': 'running', 'web-frontend': 'idle', 'mobile-app': 'waiting', 'payments-service': 'error', 'data-pipeline': 'error', 'docs-site': 'stalled' });
    expect(m.snapshot.projects.find((p) => p.id === 'payments-service')!.status.reasons).toEqual(['테스트 실패 (exit 1)']);
    expect(m.snapshot.summary).toMatchObject({ total: 6, sessionsRunning: 5, waiting: 1 });
    const api = m.snapshot.projects[0]!;
    expect(api.tmux.panes).toHaveLength(2);
    expect(api.tmux.output.join('\n')).not.toContain('\x1b');
    expect(m.snapshot.projects.find((p) => p.id === 'mobile-app')!.status.reasons).toEqual(['입력 대기: Do you want to proceed?']);
  });
});

describe('restart', () => {
  it('keeps the terminal-activity clock instead of re-seeding it from tmux', async () => {
    let now = T0;
    const state = { output: ['a'], git: git() };
    const first = new Monitor({ config, collector: fakeCollector(state), runs: noRuns, now: () => now });
    await first.tick();
    now += 10 * 60_000;
    state.output = ['b'];
    await first.tick();
    const changedAt = new Date(now).toISOString();
    expect(first.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(changedAt);

    now += 10 * 60_000;
    const m = new Monitor({ config, collector: fakeCollector(state), runs: noRuns, now: () => now, restore: JSON.parse(JSON.stringify(first.exportState())) });
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(changedAt);
  });
});

describe('followRepo', () => {
  it('follows the pane into a git repository when the configured path is not one, and keeps it', async () => {
    const cfg = parseConfig({ projects: [{ name: 'home', repoPath: '/home/me', tmuxSession: 'home' }] }, '/base');
    let cwd = '/home/me';
    const seen: string[] = [];
    const collector: Collector = {
      async git(p) {
        seen.push(p.repoPath);
        return p.repoPath === '/home/me/repo' ? git() : { ...git(), ok: false, error: 'Git 저장소가 아닙니다' };
      },
      since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
      tmux: async () => new Map([['home', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [{ id: '%1', window: 0, windowName: 'w', index: 0, command: 'zsh', active: true, cols: 80, lines: [], cwd }], waitingPrompt: null, attachCommand: 'x' }]]),
      logErrors: async () => NO_LOG,
    };
    const m = new Monitor({ config: cfg, collector, runs: noRuns, now: () => T0 });
    await m.tick();
    expect(m.snapshot.projects[0]).toMatchObject({ repoPath: '/home/me', git: { ok: false } });

    cwd = '/home/me/repo';
    await m.tick();
    expect(m.snapshot.projects[0]).toMatchObject({ repoPath: '/home/me/repo', git: { ok: true } });
    expect(m.exportState().tracked.home?.repoPath).toBe('/home/me/repo');

    // pane 이 저장소 밖으로 나가도 따라간 저장소는 유지한다
    cwd = '/tmp';
    await m.tick();
    expect(m.snapshot.projects[0]!.repoPath).toBe('/home/me/repo');
    expect(seen.at(-1)).toBe('/home/me/repo');

    // 재시작해도 이어진다
    const again = new Monitor({ config: cfg, collector, runs: noRuns, now: () => T0, restore: JSON.parse(JSON.stringify(m.exportState())) });
    await again.tick();
    expect(again.snapshot.projects[0]!.repoPath).toBe('/home/me/repo');
  });

  it('follows where an agent started in the home folder runs its commands, and moves only when new work starts elsewhere', async () => {
    const home = process.env.HOME;
    process.env.HOME = '/home/me';
    try {
      const cfg = parseConfig({ projects: [{ name: 'money', repoPath: '/home/me', tmuxSession: 'money' }, { name: 'plain', repoPath: '/work/plain', tmuxSession: 'plain' }] }, '/base');
      const repos = ['/home/me/repos/trader', '/home/me/repos/other'];
      let procs: { pid: number; ppid: number; dir: string; shell?: boolean }[] | null = [];
      const asked: string[] = [];
      const pane = { id: '%1', window: 0, windowName: 'w', index: 0, command: 'codex', active: true, cols: 80, lines: [], cwd: '/home/me' };
      const raw = { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [pane], waitingPrompt: null, attachCommand: 'x' };
      const collector: Collector = {
        git: async (p) => (repos.includes(p.repoPath) ? git() : { ...git(), ok: false, error: 'Git 저장소가 아닙니다' }),
        since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
        tmux: async () =>
          new Map([
            ['money', raw],
            ['plain', raw],
          ]),
        logErrors: async () => NO_LOG,
        workDirs: async (session) => {
          asked.push(session);
          return procs;
        },
        repoRoot: async (dir) => repos.find((r) => dir === r || dir.startsWith(`${r}/`)) ?? null,
      };
      const m = new Monitor({ config: cfg, collector, runs: noRuns, now: () => T0 });
      const money = () => m.snapshot.projects.find((p) => p.id === 'money')!;

      // Codex 가 홈에서 떠 있지만 명령은 저장소의 하위 폴더에서 돌린다 (MCP 서버 같은 건 홈에 있다). 저장소 맨 위를 따라간다
      // 20 은 홈에서 뜬 에이전트, 그 아래가 명령들이다
      const agent = { pid: 20, ppid: 10, dir: '/home/me' };
      procs = [{ pid: 30, ppid: 20, dir: '/home/me/repos/trader/src' }, agent];
      await m.tick();
      expect(money()).toMatchObject({ repoPath: '/home/me/repos/trader', git: { ok: true } });
      const baseline = m.exportState().tracked.money?.baseline;
      // 특정 폴더로 등록한 프로젝트는 그 폴더가 의도한 곳이다: 명령 폴더를 따라가지 않는다
      expect(asked).toEqual(['money']);

      // 같은 저장소의 다른 하위 폴더에서 돌려도 같은 프로젝트다 (추적 기록이 이어진다)
      procs = [{ pid: 31, ppid: 20, dir: '/home/me/repos/trader/tests' }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/trader');
      expect(m.exportState().tracked.money?.baseline).toEqual(baseline);

      // 명령이 끝나 쉬는 동안에도 유지한다
      procs = [agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/trader');

      // 다른 저장소에서 새 일을 시작하면 그리로. 그사이 trader 에 개발 서버가 뜬다
      procs = [{ pid: 41, ppid: 20, dir: '/home/me/repos/other' }, { pid: 40, ppid: 20, dir: '/home/me/repos/trader' }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');
      // other 의 명령이 끝나도, 뒤에서 계속 도는 trader 의 개발 서버가 되돌리지 않는다
      procs = [{ pid: 40, ppid: 20, dir: '/home/me/repos/trader' }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');
      // 그 개발 서버가 같은 저장소의 다른 폴더에 새 일꾼을 띄워도 마찬가지다
      procs = [{ pid: 43, ppid: 40, dir: '/home/me/repos/trader/packages/web' }, { pid: 40, ppid: 20, dir: '/home/me/repos/trader' }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');
      // 프로세스를 한 번 못 읽어도(ps 실패) 기억한 프로세스를 잊지 않는다
      procs = null;
      await m.tick();
      procs = [{ pid: 43, ppid: 40, dir: '/home/me/repos/trader/packages/web' }, { pid: 40, ppid: 20, dir: '/home/me/repos/trader' }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');
      // 계속 쓰는 셸(50)이 trader 에서 일하다 other 로 옮겨 가도 따라간다
      procs = [{ pid: 50, ppid: 20, dir: '/home/me/repos/trader', shell: true }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/trader');
      procs = [{ pid: 51, ppid: 50, dir: '/home/me/repos/other' }, { pid: 50, ppid: 20, dir: '/home/me/repos/other', shell: true }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');
      // 그 셸이 다른 저장소에서 한 명령을 돌린 뒤 자기 저장소에서 새 명령을 돌려도 새 일이다 (셸 아래는 일꾼이 아니다)
      procs = [{ pid: 52, ppid: 50, dir: '/home/me/repos/trader' }, { pid: 50, ppid: 20, dir: '/home/me/repos/other', shell: true }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/trader');
      procs = [{ pid: 53, ppid: 50, dir: '/home/me/repos/other' }, { pid: 50, ppid: 20, dir: '/home/me/repos/other', shell: true }, agent];
      await m.tick();
      expect(money().repoPath).toBe('/home/me/repos/other');

      // NightShift 를 다시 띄워도 그 개발 서버를 새 일로 보지 않는다 (기준점도 이어진다)
      const kept = m.exportState().tracked.money?.baseline;
      const again = new Monitor({ config: cfg, collector, runs: noRuns, now: () => T0, restore: JSON.parse(JSON.stringify(m.exportState())) });
      await again.tick();
      expect(again.snapshot.projects.find((p) => p.id === 'money')!.repoPath).toBe('/home/me/repos/other');
      expect(again.exportState().tracked.money?.baseline).toEqual(kept);
    } finally {
      process.env.HOME = home;
    }
  });
});

describe('followRepo with a linked home folder', () => {
  it('still follows commands when the home folder is a link and the project path is the real folder', async () => {
    const real = realpathSync(mkdtempSync(path.join(tmpdir(), 'nightshift-home-')));
    const link = `${real}-link`;
    symlinkSync(real, link);
    const home = process.env.HOME;
    process.env.HOME = link;
    try {
      const cfg = parseConfig({ projects: [{ name: 'money', repoPath: real, tmuxSession: 'money' }] }, '/base');
      const repo = path.join(real, 'repos/trader');
      const pane = { id: '%1', window: 0, windowName: 'w', index: 0, command: 'codex', active: true, cols: 80, lines: [], cwd: real };
      const collector: Collector = {
        git: async (p) => (p.repoPath === repo ? git() : { ...git(), ok: false, error: 'Git 저장소가 아닙니다' }),
        since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
        tmux: async () => new Map([['money', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [pane], waitingPrompt: null, attachCommand: 'x' }]]),
        logErrors: async () => NO_LOG,
        workDirs: async () => [{ pid: 30, ppid: 20, dir: repo }],
      };
      const m = new Monitor({ config: cfg, collector, runs: noRuns, now: () => T0 });
      await m.tick();
      expect(m.snapshot.projects[0]!.repoPath).toBe(repo);
    } finally {
      process.env.HOME = home;
      rmSync(link);
      rmSync(real, { recursive: true });
    }
  });
});

describe('discover', () => {
  it('shows unconfigured tmux sessions as temporary projects and drops them when they close', async () => {
    let found = [{ name: 'app', cwd: '/repo/app' }, { name: 'scratch', cwd: '/tmp/scratch' }];
    const collector = fakeCollector({ output: [], git: git() });
    collector.discover = async () => found;
    collector.tmux = async (projects) => new Map(projects.map((p) => [p.id, { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [], waitingPrompt: null, attachCommand: 'x' }]));
    let now = T0;
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    await m.tick();
    expect(m.snapshot.projects.map((p) => p.id)).toEqual(['app', 'lib', 'tmux:scratch']);
    expect(m.snapshot.projects[2]).toMatchObject({ name: 'scratch', repoPath: '/tmp/scratch', tmuxSession: 'scratch', allowInput: false });

    // 세션이 다른 저장소로 옮겨 가면 기준점도 새로 잡는다
    now = T0 + 60_000;
    found = [{ name: 'app', cwd: '/repo/app' }, { name: 'scratch', cwd: '/tmp/other' }];
    await m.tick();
    expect(m.snapshot.projects[2]!.since?.baseline.at).toBe(new Date(now).toISOString());

    found = [{ name: 'app', cwd: '/repo/app' }];
    await m.tick();
    expect(m.snapshot.projects.map((p) => p.id)).toEqual(['app', 'lib']);

    found = [{ name: 'scratch', cwd: '/tmp/scratch' }, { name: 'noise', cwd: '/tmp' }];
    await m.setConfig(parseConfig({ projects: [], hiddenSessions: ['noise'] }, '/base'), collector);
    expect(m.snapshot.projects.map((p) => p.id)).toEqual(['tmux:scratch']);
  });
});

describe('attachCommand', () => {
  it('quotes unusual session names', () => {
    expect(attachCommand('my-agent')).toBe('tmux attach -t my-agent');
    expect(attachCommand("a$b'c")).toBe(`tmux attach -t 'a$b'\\''c'`);
  });
});

describe('Runner', () => {
  const project = config.projects[0]!;
  it('runs only the configured command in the repo path', async () => {
    const exec = vi.fn(async () => ({ code: 2, stdout: 'out', stderr: 'err', timedOut: false }));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const changed = vi.fn();
    runner.onChange = changed;
    expect(runner.start(project, 'test')).toBe('no-command');
    const p = { ...project, testCommand: 'npm test' };
    expect(runner.start(p, 'test')).toBe('started');
    expect(runner.start(p, 'test')).toBe('already-running');
    expect(runner.get(p.id).test).toMatchObject({ running: true, command: 'npm test' });
    await vi.waitFor(() => expect(runner.get(p.id).test?.running).toBe(false));
    expect(exec).toHaveBeenCalledExactlyOnceWith('npm test', '/repo/app', 7000, expect.any(AbortSignal));
    expect(runner.get(p.id).test).toMatchObject({ exitCode: 2, stdout: 'out', stderr: 'err', timedOut: false });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(runner.history(p.id).test).toEqual([expect.objectContaining({ exitCode: 2, canceled: false })]);
  });

  it('cancels a running command and records it as canceled', async () => {
    const exec = vi.fn((_c: string, _d: string, _t: number, signal?: AbortSignal) => new Promise<{ code: null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => signal!.addEventListener('abort', () => resolve({ code: null, stdout: 'partial', stderr: '', timedOut: false }))));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const p = { ...project, buildCommand: 'npm run build' };
    expect(runner.cancel(p.id, 'build')).toBe(false);
    runner.start(p, 'build');
    expect(runner.cancel(p.id, 'build')).toBe(true);
    await vi.waitFor(() => expect(runner.get(p.id).build?.running).toBe(false));
    expect(runner.get(p.id).build).toMatchObject({ canceled: true, exitCode: null, stdout: 'partial' });
    expect(runner.cancel(p.id, 'build')).toBe(false);
  });

  it('forget drops results and ignores the completion of an abandoned run', async () => {
    let finish = () => {};
    const exec = vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => (finish = () => resolve({ code: 1, stdout: '', stderr: '', timedOut: false }))));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const p = { ...project, testCommand: 'npm test' };
    runner.start(p, 'test');
    runner.forget(p.id);
    finish();
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.get(p.id)).toEqual({ test: null, build: null });
    expect(runner.history(p.id).test).toEqual([]);
  });

  it('keeps bounded history and restores state, marking interrupted runs', () => {
    const runner = new Runner({ timeoutSec: 7, logDir: null });
    const result = (i: number, running = false) => ({ kind: 'test' as const, command: 'npm test', running, startedAt: new Date(T0 + i * 1000).toISOString(), finishedAt: null, exitCode: running ? null : 0, timedOut: false, canceled: false, durationMs: 1, stdout: 'x'.repeat(100_000), stderr: '' });
    for (let i = 0; i < 25; i++) runner.seed('app', result(i));
    expect(runner.history('app').test).toHaveLength(20);
    expect(runner.history('app').test[0]!.startedAt).toBe(result(24).startedAt);
    runner.seed('app', result(99, true));

    const state = JSON.parse(JSON.stringify(runner.exportState()));
    expect(state.results.app.test.stdout).toHaveLength(64 * 1024);
    const restored = new Runner({ timeoutSec: 7, logDir: null });
    restored.restore(state);
    expect(restored.get('app').test).toMatchObject({ running: false, canceled: true });
    expect(restored.get('app').test!.stderr).toContain('서버 재시작으로 중단됨');
    expect(restored.history('app').test).toHaveLength(20);
    expect(restored.history('app').test[0]).toMatchObject({ canceled: true });
  });
});
