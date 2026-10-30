import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { DEFAULTS, defaultConfigPath, loadConfig } from './config.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { alertsFor, exportAlerts, FINISH_HOLD_MS, gateAlerts, MAC_ALERT_STATES, REALERT_COOLDOWN_MS, restoreAlerts, stillTrue } from './notify.ts';
import { reloadConfig } from './reload.ts';
import { Runner } from './runner.ts';

let dir = '';
beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-reload-'))));
afterAll(() => rm(dir, { recursive: true }));
afterEach(() => vi.restoreAllMocks());

const git: GitInfo = { ok: true, branch: 'main', head: 'h1', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h1' };
const collectorFor = (): Collector => ({
  git: async () => git,
  since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
  tmux: async () => new Map(),
  logErrors: async () => NO_LOG,
});

describe('config files', () => {
  it('loads YAML and both examples describe the same config', async () => {
    const file = path.join(dir, 'c.yaml');
    await writeFile(file, 'refreshIntervalSec: 9\nprojects:\n  - name: App\n    repoPath: /repo/app\n    tmuxSession: app\n');
    const { config } = loadConfig(file, '/base');
    expect(config).toMatchObject({ refreshIntervalSec: 9, projects: [{ id: 'app', tmuxSession: 'app' }] });

    const json = loadConfig('config/nightshift.example.json', process.cwd()).config;
    const yaml = loadConfig('config/nightshift.example.yaml', process.cwd()).config;
    expect(yaml).toEqual(json);
    expect(json.promptPatterns).toEqual(DEFAULTS.promptPatterns);
  });

  it('reports YAML syntax errors and accepts an empty file', async () => {
    const file = path.join(dir, 'bad.yml');
    await writeFile(file, 'projects: [unclosed');
    expect(() => loadConfig(file, '/base')).toThrow(/YAML 파싱 실패/);
    await writeFile(file, '');
    expect(loadConfig(file, '/base').config.projects).toEqual([]);
  });

  it('prefers json, then yaml, then yml', async () => {
    const d = path.join(dir, 'conf');
    expect(defaultConfigPath(d)).toBe(path.join(d, 'nightshift.json'));
    await writeFile(path.join(dir, 'nightshift.yml'), '');
    expect(defaultConfigPath(dir)).toBe(path.join(dir, 'nightshift.yml'));
  });
});

describe('reloadConfig', () => {
  it('applies a changed config, keeps baselines, and keeps the old one on error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = path.join(dir, 'live.json');
    const write = (c: object) => writeFile(file, JSON.stringify(c));
    await write({ projects: [{ name: 'a', repoPath: '/repo/a' }, { name: 'b', repoPath: '/repo/b' }] });

    const runner = new Runner({ timeoutSec: 600, logDir: null });
    const monitor = new Monitor({ config: loadConfig(file, '/base').config, collector: collectorFor(), runs: runner.get });
    await monitor.tick();
    const baselineA = monitor.snapshot.projects[0]!.since!.baseline.at;
    const deps = { configPath: file, baseDir: '/base', monitor, runner, collectorFor };

    await write({ port: 9999, refreshIntervalSec: 2, commandTimeoutSec: 30, projects: [{ name: 'a', repoPath: '/repo/a' }, { name: 'c', repoPath: '/repo/c' }] });
    expect(await reloadConfig(deps)).toBe('applied');
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['a', 'c']);
    expect(monitor.snapshot.projects[0]!.since!.baseline.at).toBe(baselineA);
    expect(monitor.snapshot.refreshIntervalSec).toBe(2);
    expect(runner.timeoutSec).toBe(30);
    expect(monitor.config.port).toBe(4477); // 재시작 전에는 바뀌지 않는다
    expect(monitor.exportState().tracked).not.toHaveProperty('b');

    await writeFile(file, '{ "projects": [ { "name": ');
    expect(await reloadConfig(deps)).toBe('error');
    expect(monitor.snapshot.configError).toContain('JSON 파싱 실패');
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['a', 'c']);

    await rm(file);
    expect(await reloadConfig(deps)).toBe('error');
    expect(monitor.snapshot.configError).toContain('파일이 없습니다');

    await write({ projects: [{ name: 'a', repoPath: '/repo/a' }] });
    expect(await reloadConfig(deps)).toBe('applied');
    expect(monitor.snapshot.configError).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('alerts', () => {
  const T0 = Date.parse('2026-10-16T00:00:00Z');
  const snap = (states: Record<string, string>, activity: Record<string, string | null> = {}, at = T0): Snapshot =>
    ({ generatedAt: new Date(at).toISOString(), projects: Object.entries(states).map(([id, state]) => ({ id, name: id.toUpperCase(), status: { state, reasons: [`${state} reason`] }, tmux: { lastOutputChangeAt: activity[id] ?? null, panes: [] }, lastGitChangeAt: activity[`${id}.git`] ?? null })) }) as unknown as Snapshot;

  it('alerts on transitions into waiting, idle, stalled or error, never into running', () => {
    const prev = new Map();
    expect(alertsFor(prev, snap({ a: 'error', b: 'running' }))).toEqual([]); // 처음 보는 프로젝트
    expect(alertsFor(prev, snap({ a: 'error', b: 'waiting' }))).toEqual([{ title: 'NightShift · B: 입력 대기', message: 'waiting reason', projectId: 'b', state: 'waiting' }]);
    expect(alertsFor(prev, snap({ a: 'running', b: 'waiting' }))).toEqual([]);
    expect(alertsFor(prev, snap({ a: 'idle', b: 'stalled' })).map((x) => [x.title, x.state])).toEqual([['NightShift · A: 유휴', 'idle'], ['NightShift · B: 정지 의심', 'stalled']]);
    expect(alertsFor(prev, snap({ a: 'error' })).map((x) => x.title)).toEqual(['NightShift · A: 오류']);
    expect([...prev.keys()]).toEqual(['a']);
    // Mac 알림에는 유휴가 포함되지 않는다
    expect(MAC_ALERT_STATES).toEqual(['waiting', 'stalled', 'error']);
  });

  it('does not repeat the same alert after a blip, but does after real activity', () => {
    const memory = new Map();
    const titles = (s: Snapshot) => alertsFor(memory, s).map((x) => x.title);
    titles(snap({ a: 'running' }, { a: 't0' }));
    expect(titles(snap({ a: 'waiting' }, { a: 't0' }))).toEqual(['NightShift · A: 입력 대기']);
    // 화면이 한 번 바뀌어 정상 → 다시 입력 대기: 반복이므로 조용히
    titles(snap({ a: 'running' }, { a: 't1' }));
    expect(titles(snap({ a: 'waiting' }, { a: 't1' }))).toEqual([]);
    // 출력이 여러 tick 바뀌었다 = 실제로 돌았다 → 다시 알린다
    titles(snap({ a: 'running' }, { a: 't2' }));
    titles(snap({ a: 'running' }, { a: 't3' }));
    titles(snap({ a: 'running' }, { a: 't4' }));
    expect(titles(snap({ a: 'idle' }, { a: 't4' }))).toEqual(['NightShift · A: 유휴']);
    expect(titles(snap({ a: 'waiting' }, { a: 't4' }))).toEqual(['NightShift · A: 입력 대기']);
  });

  it('stalled and error stay quiet for the cooldown unless Git changed, even with output activity or other alerts between', () => {
    const memory = new Map();
    const titles = (s: Snapshot) => alertsFor(memory, s).map((x) => x.title);
    const H = 60 * 60 * 1000;
    titles(snap({ a: 'running' }, { a: 't0' }));
    expect(titles(snap({ a: 'stalled' }, { a: 't0' }))).toEqual(['NightShift · A: 정지 의심']);
    // 화면 크기 바꾸기·시계 같은 출력 변화만으로는 다시 알리지 않는다
    for (const t of ['t1', 't2', 't3', 't4']) titles(snap({ a: 'running' }, { a: t }, T0 + H));
    expect(titles(snap({ a: 'stalled' }, { a: 't4' }, T0 + H))).toEqual([]);
    // 다른 알림(입력 대기)을 거쳐 돌아와도 마찬가지
    expect(titles(snap({ a: 'waiting' }, { a: 't4' }, T0 + H))).toEqual(['NightShift · A: 입력 대기']);
    expect(titles(snap({ a: 'stalled' }, { a: 't4' }, T0 + H))).toEqual([]);
    // Git 변화가 있었으면 새 소식이다
    titles(snap({ a: 'running' }, { a: 't5', 'a.git': 'g1' }, T0 + 2 * H));
    expect(titles(snap({ a: 'stalled' }, { a: 't5', 'a.git': 'g1' }, T0 + 2 * H))).toEqual(['NightShift · A: 정지 의심']);
    // 쿨다운이 지나면 출력 활동만으로도 다시 알린다
    for (const t of ['t6', 't7', 't8']) titles(snap({ a: 'running' }, { a: t, 'a.git': 'g1' }, T0 + 2 * H + REALERT_COOLDOWN_MS));
    expect(titles(snap({ a: 'stalled' }, { a: 't8', 'a.git': 'g1' }, T0 + 2 * H + REALERT_COOLDOWN_MS))).toEqual(['NightShift · A: 정지 의심']);
  });

  it('an agent that finished its work is announced as 작업 끝남', () => {
    const memory = new Map();
    const withAgent = (state: string, agent: string) => {
      const s = snap({ a: state });
      (s.projects[0]!.tmux as { agent?: string }).agent = agent;
      return s;
    };
    alertsFor(memory, withAgent('running', 'busy'));
    expect(alertsFor(memory, withAgent('idle', 'ready')).map((x) => [x.title, x.state])).toEqual([['NightShift · A: 작업 끝남', 'idle']]);
  });

  it('a prompt is announced even while an old error keeps the status at 오류', () => {
    const memory = new Map();
    const withPrompt = (prompt: string | null) => {
      const s = snap({ a: 'error' });
      Object.assign(s.projects[0]!.tmux, { exists: true, waitingPrompt: prompt });
      return s;
    };
    alertsFor(memory, withPrompt(null));
    expect(alertsFor(memory, withPrompt('Do you want to proceed?')).map((x) => [x.title, x.message])).toEqual([['NightShift · A: 입력 대기', '입력 대기: Do you want to proceed?']]);
  });

  it('작업 끝남 waits a few minutes and is dropped if work starts again; watched terminals defer finish and prompt alerts', () => {
    const deferred = new Map();
    const done = { title: 'A: 작업 끝남', message: '', projectId: 'a', state: 'idle' as const };
    const ask = { title: 'B: 입력 대기', message: '', projectId: 'b', state: 'waiting' as const };
    const err = { title: 'C: 오류', message: '', projectId: 'c', state: 'error' as const };
    let state: Record<string, string> = { a: 'idle', b: 'waiting', c: 'error' };
    const stateNow = (a: { projectId: string; state: string }) => state[a.projectId] === a.state;
    const watching = new Set(['b']);
    const watched = (a: { projectId: string }) => watching.has(a.projectId);
    expect(gateAlerts(deferred, [done, ask, err], 0, watched, stateNow)).toEqual([err]);
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS - 1, watched, stateNow)).toEqual([]);
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS, watched, stateNow)).toEqual([done]);
    // 보고 있는 동안은 입력 대기도 미루고, 그만 보면 보낸다
    watching.clear();
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS + 1, watched, stateNow)).toEqual([ask]);
    // 기다리는 사이 다시 일을 시작하면 버린다
    gateAlerts(deferred, [done], 0, watched, stateNow);
    state = { ...state, a: 'running' };
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS, watched, stateNow)).toEqual([]);
    expect(deferred.size).toBe(0);
  });

  it('with two agents in one session, each terminal is announced when it finishes, even while the other still works or is watched', () => {
    const memory = new Map();
    const at = (state: string, a1: string, a2: string) => {
      const s = snap({ a: state });
      const pane = (id: string, window: number, agent: string) => ({ id, window, index: 0, agent });
      Object.assign(s.projects[0]!.tmux, { exists: true, agent: state === 'idle' ? 'ready' : 'busy', panes: [pane('%1', 0, a1), pane('%2', 1, a2)] });
      return s;
    };
    alertsFor(memory, at('running', 'busy', 'busy'));
    // 1번 터미널은 쉬는데 2번은 아직 일한다: 세션은 실행 중이지만 1번의 끝남을 알린다
    const first = alertsFor(memory, at('running', 'busy', 'ready'));
    expect(first).toEqual([{ title: 'NightShift · A: 작업 끝남 (터미널 1)', message: '작업을 마치고 다음 지시를 기다리는 중', projectId: 'a', state: 'idle', pane: '%2' }]);
    expect(alertsFor(memory, at('running', 'busy', 'ready'))).toEqual([]);
    const last = alertsFor(memory, at('idle', 'ready', 'ready'));
    expect(last.map((x) => [x.title, x.pane])).toEqual([['NightShift · A: 작업 끝남 (터미널 0)', '%1']]);
    // 같은 때 둘 다 끝나도 하나씩 알린다
    alertsFor(memory, at('running', 'busy', 'busy'));
    expect(alertsFor(memory, at('idle', 'ready', 'ready')).map((x) => x.pane)).toEqual(['%1', '%2']);
    // 하나는 끝나고, 일하던 다른 하나를 닫아 세션이 쉬게 되면 끝난 쪽만 알린다
    alertsFor(memory, at('running', 'busy', 'busy'));
    expect(alertsFor(memory, at('running', 'ready', 'busy')).map((x) => x.pane)).toEqual(['%1']);
    const closed = at('idle', 'ready', 'ready');
    closed.projects[0]!.tmux.panes.pop();
    expect(alertsFor(memory, closed)).toEqual([]);

    // 0번 터미널을 보고 있어도 1번의 끝남은 미루지 않는다 (잠깐 기다리는 것만). 0번은 그만 보면, 1번이 다시 일해도 보낸다.
    // 기다리는 사이 그 터미널이 다시 일하면 버린다
    const deferred = new Map();
    let snapshot = at('idle', 'ready', 'ready');
    const watched = (a: { pane?: string }) => a.pane === '%1';
    expect(gateAlerts(deferred, [...first, ...last], 0, watched, (a) => stillTrue(snapshot, a))).toEqual([]);
    expect(deferred.size).toBe(2);
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS, watched, (a) => stillTrue(snapshot, a))).toEqual(first);
    snapshot = at('running', 'ready', 'busy');
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS, () => false, (a) => stillTrue(snapshot, a))).toEqual(last);
    gateAlerts(deferred, first, 0, watched, (a) => stillTrue(snapshot, a));
    expect(gateAlerts(deferred, [], FINISH_HOLD_MS, watched, (a) => stillTrue(snapshot, a))).toEqual([]);
    expect(deferred.size).toBe(0);
  });

  it('remembers sent alerts across a restart', () => {
    const before = new Map();
    alertsFor(before, snap({ a: 'running' }, { a: 't0' }));
    alertsFor(before, snap({ a: 'stalled' }, { a: 't0' }));
    const after = restoreAlerts(JSON.parse(JSON.stringify(exportAlerts(before))));
    // 재시작 뒤 첫 화면은 활동으로 치지 않고, 같은 정지는 다시 알리지 않는다
    expect(alertsFor(after, snap({ a: 'stalled' }, { a: 't9' }))).toEqual([]);
    for (const t of ['t10', 't11', 't12']) alertsFor(after, snap({ a: 'running' }, { a: t }));
    expect(alertsFor(after, snap({ a: 'stalled' }, { a: 't12' }))).toEqual([]);
    expect(restoreAlerts(undefined).size).toBe(0);
  });
});

