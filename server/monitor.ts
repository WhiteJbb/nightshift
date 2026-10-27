import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { GitBaseline, GitInfo, ProjectSnapshot, RunKind, RunResult, RunSummary, SinceBaseline, Snapshot, TmuxInfo } from '../shared/types.ts';
import { NOT_A_REPO } from '../shared/types.ts';
import type { Config, ProjectConfig } from './config.ts';
import { collectGit, collectSince, repoRoot } from './git.ts';
import type { LogPos, LogScan } from './logs.ts';
import { aboveInput, findPrompt, isBusy, mentionedIn, promptChoices, scanLog, scrolledUp, stripAnsi, stripVolatile, waitingOnBackground } from './logs.ts';
import type { MonitorState } from './state.ts';
import { judge } from './status.ts';
import { capturePane, listPanes, listSessions, workDirs } from './tmux.ts';

export type RawTmux = Omit<TmuxInfo, 'lastOutputChangeAt'>;

/** Monitor 가 데이터를 얻는 유일한 통로. 실제 구현과 demo 구현이 있다. */
export interface Collector {
  git(p: ProjectConfig): Promise<GitInfo>;
  since(p: ProjectConfig, baseline: GitBaseline, git: GitInfo): Promise<SinceBaseline>;
  tmux(projects: ProjectConfig[]): Promise<Map<string, RawTmux>>;
  /** 떠 있는 tmux 세션 전부 (이름, 활성 pane 의 디렉터리). 설정에 없는 세션도 카드로 띄우기 위한 것 */
  discover?(): Promise<{ name: string; cwd: string }[]>;
  /** pos 이후의 로그만 검사한다. null 이면 현재 끝 위치만 잰다. */
  logErrors(p: ProjectConfig, pos: LogPos | null): Promise<LogScan>;
  /** 세션 안 에이전트가 돌리는 명령들과 그 작업 폴더 (최근에 뜬 것부터). 읽지 못했으면 null (없는 것과 다르다) */
  workDirs?(session: string): Promise<{ pid: number; ppid: number; dir: string; shell?: boolean }[] | null>;
  /** dir 이 든 저장소의 맨 위 폴더 (저장소가 아니면 null). 없으면 dir 을 그대로 쓴다 */
  repoRoot?(dir: string): Promise<string | null>;
}

/** 복사해서 붙여 넣을 명령이므로 셸에 안전하게 인용한다. */
export function attachCommand(session: string): string {
  const quoted = /^[\w@+-]+$/.test(session) ? session : `'${session.replace(/'/g, `'\\''`)}'`;
  return `tmux attach -t ${quoted}`;
}

export const NO_LOG: LogScan = { errors: [], end: { offset: 0, ino: 0 } };
const NO_TMUX: RawTmux = { configured: false, exists: false, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [], waitingPrompt: null, attachCommand: null };

export function realCollector(config: Config): Collector {
  return {
    git: (p) => collectGit(p.repoPath),
    since: (p, baseline, git) => collectSince(p.repoPath, baseline, git),
    logErrors: (p, pos) => (p.logFile ? scanLog(p.logFile, config.errorPatterns, config.errorIgnorePatterns, pos) : Promise.resolve(NO_LOG)),
    workDirs,
    repoRoot,
    // ponytail: tmux() 가 같은 목록을 다시 읽는다 (tick 당 ls 두 번). 느려지면 한 tick 안에서 캐시.
    async discover() {
      const [{ sessions }, panes] = await Promise.all([listSessions(), listPanes()]);
      return [...sessions.keys()].map((name) => ({ name, cwd: panes.get(name)?.[0]?.cwd ?? '' }));
    },
    async tmux(projects) {
      const [{ sessions, error }, panesBySession] = await Promise.all([listSessions(), listPanes()]);
      const out = new Map<string, RawTmux>();
      await Promise.all(
        projects.map(async (p) => {
          const name = p.tmuxSession;
          if (!name) return;
          const s = sessions.get(name);
          const panes = s
            ? await Promise.all((panesBySession.get(name) ?? []).map(async ({ height, ...meta }) => ({ ...meta, lines: await capturePane({ id: meta.id, height }) })))
            : [];
          out.set(p.id, {
            configured: true,
            exists: !!s,
            createdAt: s?.createdAt ?? null,
            attached: s?.attached ?? false,
            lastActivityAt: s?.lastActivityAt ?? null,
            output: (panes.find((x) => x.active) ?? panes[0])?.lines.map(stripAnsi) ?? [],
            panes,
            waitingPrompt: null,
            attachCommand: attachCommand(name),
            ...(error ? { error } : {}),
          });
        }),
      );
      return out;
    },
  };
}

interface Tracked {
  /** 기준점을 잡은 저장소. 바뀌면(자동 발견 세션의 cwd 이동 등) 기준점을 버린다 */
  repoPath: string;
  baseline: GitBaseline | null;
  fingerprint: string | null;
  gitChangedAt: string | null;
  logFile: string | null;
  /** 이 위치 이후의 로그만 오류 검사 대상. null = 아직 관측 전 */
  logPos: LogPos | null;
  /** 마지막 스캔에서 본 파일 끝 ("확인 처리" 시 여기로 옮긴다) */
  logEnd: LogPos | null;
  /** 확인 처리 전까지 남겨 두는 로그 오류. 스캔 창(파일 끝 64KB)에서 밀려나도 잊지 않는다 */
  logErrors: string[];
  output: string | null;
  /**
   * pane id 마다 본 것 (휴대폰 폭에서 작업 중 표시가 빠졌을 때 작업을 가늠한다): 폭, Claude Code 입력칸 바로 위 화면
   * (위로 올려 본 화면밖에 못 봤으면 null), 크기가 바뀐 뒤 아직 비교하지 않을 tick 수
   */
  seen: Record<string, { cols: number; body: string | null; quiet: number }> | null;
  outputChangedAt: string | null;
  /** pane 크기 ("%1:120,%2:80"). 바뀌면 프로그램이 화면을 다시 그리는데, 그건 작업이 아니다 */
  sizeKey: string | null;
  /** 크기가 바뀐 뒤 출력 변화를 활동으로 치지 않을 남은 tick 수 */
  settle: number;
  /** 작업 중 표시를 띄운 적이 있는 에이전트 세션 */
  agent: boolean;
  /** 작업 중 표시가 연달아 보이지 않은 tick 수 (도구 호출 사이의 잠깐 빈 틈을 "끝남"으로 보지 않게) */
  quietTicks: number;
  /** 작업 중 표시를 마지막으로 본 시각. 스크롤·입력칸 타이핑도 화면을 바꾸지만 그건 일이 아니다 (대시보드 순서에 쓴다) */
  busyAt: string | null;
}

/** 크기 변경 뒤 화면을 다시 그리는 데 걸리는 tick 수 (그동안의 출력 변화는 활동이 아니다) */
export const RESIZE_SETTLE_TICKS = 2;
/** 작업 중 표시가 이만큼 연달아 안 보여야 "작업을 마침"으로 본다 */
export const READY_TICKS = 2;

type Collected = Pick<ProjectSnapshot, 'repoPath' | 'git' | 'since' | 'lastGitChangeAt' | 'tmux' | 'logErrors'>;

const latest = (a: string | null, b: string | null): string | null => {
  if (!a || !b) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

export interface MonitorOptions {
  config: Config;
  collector: Collector;
  runs: (projectId: string) => Record<RunKind, RunResult | null>;
  history?: (projectId: string) => Record<RunKind, RunSummary[]>;
  demo?: boolean;
  configPath?: string;
  configMissing?: boolean;
  now?: () => number;
  /** 이전 실행에서 저장한 상태. 있으면 모니터링 세션을 이어 간다. */
  restore?: MonitorState | null;
}

export class Monitor {
  snapshot: Snapshot;
  private opts: MonitorOptions;
  private configError: string | null = null;
  private now: () => number;
  private startedAt: string;
  private tracked = new Map<string, Tracked>();
  /** 프로젝트마다 지난 tick 에 본, 에이전트가 돌리던 프로세스들과 그때의 저장소 (followRepo) */
  private workSeen = new Map<string, Map<number, string | null>>();
  /** 프로젝트마다 지난 tick 에 본 pane 의 폴더와 화면에 가장 많이 나온 옆 폴더 (followRepo) */
  private looked = new Map<string, { cwd: string | null; beside: string | null }>();
  /**
   * 일부러 꺼 둔 프로젝트 → 끈 tmux 세션의 이름과 생성 시각 (꺼진 것을 봤거나 이미 꺼진 것을 표시했으면 created 는 null).
   * 생성 시각이 다른 세션이 뜨면 다시 켠 것이라 뺀다. 프로젝트가 보는 세션 이름이 바뀌어도 뺀다. 새 모니터링 세션(reset)으로도 풀리지 않는다.
   * ponytail: tmux 생성 시각은 초 단위라, 끈 그 초 안에 다시 켜고 그사이 tick 이 없으면 그 세션은 꺼 둠으로 남는다 (나중에 죽어도 알리지 않는다)
   */
  private off: Map<string, { session: string; created: string | null }>;
  /** 설정에 없지만 떠 있는 tmux 세션에서 만든 임시 프로젝트. 세션이 사라지면 같이 사라진다. */
  private discovered: ProjectConfig[] = [];
  private collected = new Map<string, Collected>();
  private listeners = new Set<(s: Snapshot) => void>();
  private timer: NodeJS.Timeout | null = null;
  /** tick·reload·reset 을 한 줄로 세워 서로의 중간 상태를 덮어쓰지 않게 한다. */
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.restore?.startedAt ?? new Date(this.now()).toISOString();
    // 저장된 것은 꺼진 것을 본 뒤다: 서버가 꺼진 사이 세션을 다시 켰으면 풀린다
    this.off = new Map(Object.entries(opts.restore?.off ?? {}).map(([id, session]) => [id, { session, created: null }]));
    for (const p of opts.config.projects) {
      const saved = opts.restore?.tracked[p.id];
      // 경로가 달라졌으면 collectOne 이 기준점을 버린다. 따라간 저장소(followRepo)는 여기서 그대로 이어받는다.
      if (saved) this.tracked.set(p.id, { ...newTracked(saved.repoPath), baseline: saved.baseline, gitChangedAt: saved.gitChangedAt, logFile: saved.logFile, logPos: saved.logPos, logErrors: saved.logErrors ?? [], outputChangedAt: saved.outputChangedAt ?? null, agent: saved.agent ?? false, busyAt: saved.busyAt ?? null });
      if (saved?.looked) this.looked.set(p.id, saved.looked);
    }
    this.snapshot = this.build();
  }

  get config(): Config {
    return this.opts.config;
  }

  /** 설정된 프로젝트 + 설정에 없는 tmux 세션 */
  get projects(): ProjectConfig[] {
    return [...this.opts.config.projects, ...this.discovered];
  }

  /** 실행 중 config 교체 (hot reload). 사라진 프로젝트의 추적 상태는 버리고, 남은 프로젝트의 기준점은 유지한다. */
  setConfig(config: Config, collector: Collector, configMissing = false): Promise<void> {
    return this.serial(async () => {
      const keep = new Map(config.projects.map((p) => [p.id, p.repoPath]));
      const old = new Map(this.opts.config.projects.map((p) => [p.id, p.repoPath]));
      for (const id of new Set([...this.tracked.keys(), ...this.collected.keys()])) {
        if (keep.get(id) !== old.get(id)) {
          this.tracked.delete(id);
          this.collected.delete(id);
          this.looked.delete(id);
        }
      }
      this.opts = { ...this.opts, config, collector, configMissing };
      this.configError = null;
      await this.collectAll();
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  /** config 를 다시 읽다 실패했을 때: 이전 설정으로 계속 돌면서 화면에 알린다. */
  setConfigError(message: string | null): void {
    if (this.configError === message) return;
    this.configError = message;
    this.publish();
  }

  /** 디스크에 저장할 상태 (기준점, 변경 시각, 로그 위치와 확인 전 오류). */
  exportState(): MonitorState {
    const tracked: MonitorState['tracked'] = {};
    for (const p of this.opts.config.projects) {
      const tr = this.tracked.get(p.id);
      if (tr) tracked[p.id] = { repoPath: tr.repoPath, baseline: tr.baseline, gitChangedAt: tr.gitChangedAt, logFile: tr.logFile, logPos: tr.logPos, logErrors: tr.logErrors, outputChangedAt: tr.outputChangedAt, agent: tr.agent, busyAt: tr.busyAt, looked: this.looked.get(p.id) ?? null };
    }
    return { startedAt: this.startedAt, tracked, off: Object.fromEntries([...this.off].map(([id, o]) => [id, o.session])) };
  }

  /**
   * 세션을 끈다. 같은 세션을 보는 프로젝트를 모두 꺼 둠으로 표시하고 나서 kill 을 부른다 (실패하면 이번에 표시한 것만 되돌린다).
   * 수집과 한 줄로 세워, 끄기 전에 시작한 수집이 본 옛 세션으로 표시를 지우거나 그 사이 오류로 알리지 못하게 한다. 실패하면 오류 메시지
   */
  async endSession(session: string, kill: () => Promise<string | null>): Promise<string | null> {
    let error: string | null = null;
    await this.serial(async () => {
      const ids = this.opts.config.projects.filter((p) => p.tmuxSession === session).map((p) => p.id);
      const created = ids.map((id) => this.collected.get(id)?.tmux.createdAt).find(Boolean) ?? null;
      const fresh = ids.filter((id) => !this.off.has(id));
      for (const id of ids) this.off.set(id, { session, created });
      error = await kill();
      if (error) for (const id of fresh) this.off.delete(id);
      await this.collectAll();
    });
    return error;
  }

  /** 대시보드 밖에서(터미널에서 exit 등) 끈 세션을 꺼 둠으로 표시한다 (같은 세션을 보는 프로젝트 모두) */
  markOff(session: string): void {
    for (const p of this.opts.config.projects) if (p.tmuxSession === session) this.off.set(p.id, { session, created: null });
    this.publish();
  }

  /** 새 모니터링 세션: 기준점을 버리고 지금부터 다시 센다. */
  reset(): Promise<void> {
    return this.serial(async () => {
      this.tracked.clear();
      this.looked.clear();
      this.startedAt = new Date(this.now()).toISOString();
      await this.collectAll();
    });
  }

  /** 지금까지의 로그 오류를 확인 처리한다. 이후에 추가되는 줄만 다시 검사한다. */
  ackErrors(projectId: string): boolean {
    const tr = this.tracked.get(projectId);
    const c = this.collected.get(projectId);
    if (!tr || !c) return false;
    // 진행 중인 스캔은 logPos 가 바뀐 것을 보고 자기 결과를 버린다 (collectOne 참고).
    tr.logPos = tr.logEnd;
    tr.logErrors = [];
    c.logErrors = [];
    this.publish();
    return true;
  }

  /** 모든 프로젝트를 한 번 수집하고 스냅샷을 갱신한다. 절대 throw 하지 않는다. */
  tick(): Promise<void> {
    return this.serial(() => this.collectAll());
  }

  private async collectAll(): Promise<void> {
    const { collector, config } = this.opts;
    const nowIso = new Date(this.now()).toISOString();
    const known = new Set(config.projects.map((p) => p.tmuxSession));
    const found = await collector.discover?.().catch(() => []);
    this.discovered = (found ?? [])
      .filter((s) => !known.has(s.name) && !config.hiddenSessions.includes(s.name))
      .map((s) => ({ id: `tmux:${s.name}`, name: s.name, repoPath: s.cwd, tmuxSession: s.name, testCommand: null, buildCommand: null, logFile: null, allowInput: false }));
    const projects = this.projects;
    for (const id of new Set([...this.tracked.keys(), ...this.collected.keys()])) {
      if (!projects.some((p) => p.id === id)) {
        this.tracked.delete(id);
        this.collected.delete(id);
        this.looked.delete(id);
      }
    }
    for (const [id, o] of this.off) if (!config.projects.some((p) => p.id === id && p.tmuxSession === o.session)) this.off.delete(id);
    let tmuxError: string | undefined;
    const tmuxAll = await collector.tmux(projects).catch((e: Error) => {
      tmuxError = `tmux 수집 실패: ${e.message}`;
      return new Map<string, RawTmux>();
    });
    const rawTmux = (p: ProjectConfig): RawTmux =>
      tmuxAll.get(p.id) ?? (p.tmuxSession ? { ...NO_TMUX, configured: true, attachCommand: attachCommand(p.tmuxSession), ...(tmuxError ? { error: tmuxError } : {}) } : NO_TMUX);
    await Promise.all(
      projects.map(async (p) => {
        try {
          this.collected.set(p.id, await this.collectOne(p, rawTmux(p), nowIso));
        } catch (e) {
          // 한 프로젝트의 수집 실패가 나머지를 막지 않게 오류 상태로 표시만 한다.
          this.collected.set(p.id, {
            repoPath: p.repoPath,
            git: { ...EMPTY_GIT, error: `수집 실패: ${(e as Error).message}` },
            since: null,
            lastGitChangeAt: null,
            tmux: { ...NO_TMUX, lastOutputChangeAt: null },
            logErrors: [],
          });
        }
      }),
    );
    this.publish();
  }

  /**
   * 저장소가 아닌 경로로 등록된 프로젝트는 pane 이 Git 저장소 안으로 cd 하면 그 저장소를 따라간다 (config 는 바꾸지 않는다).
   * 홈 폴더(나 그 위)로 등록된 세션은 에이전트를 홈에서 띄운 것이라, 에이전트가 명령을 돌리는 폴더(Codex 의 workdir 등)의 저장소도 따라간다.
   * 한 번 따라간 저장소는 pane 이 다른 곳으로 가도 저장소인 동안 유지하고, 에이전트가 다른 저장소에서 일하기 시작하면 그리로 옮긴다.
   * 홈 밖의 폴더로 등록한 프로젝트는 에이전트가 옆 폴더(같은 상위 폴더 안: 과제2 → 과제3 등)로 옮겨 가 일하는 것도, 저장소가 아니어도 따라간다.
   * 홈에서 띄운 에이전트가 절대경로로만 다루면 명령의 작업 폴더로는 알 수 없어서, 화면의 경로에 가장 많이 나온 옆 폴더를 본다.
   */
  private async followRepo(p: ProjectConfig, raw: RawTmux): Promise<{ project: ProjectConfig; git: GitInfo }> {
    const git = await this.opts.collector.git(p);
    if (git.ok || git.error !== NOT_A_REPO) return { project: p, git };
    const paneCwd = raw.panes.find((x) => x.active)?.cwd || raw.panes[0]?.cwd;
    const followed = this.tracked.get(p.id)?.repoPath;
    // 홈이 링크일 수 있다 (설정 경로는 실제 폴더로 적었을 수 있다)
    const real = (dir: string) => realpath(dir).catch(() => dir);
    const parent = path.dirname(p.repoPath);
    const [where, home, up] = await Promise.all([real(p.repoPath), real(homedir()), real(parent)]);
    // 상위 폴더가 링크면 tmux 는 실제 경로를 알려 준다: 옆 폴더는 설정 경로의 이름으로 맞춘다
    const cwd = paneCwd && path.dirname(paneCwd) === up ? path.join(parent, path.basename(paneCwd)) : paneCwd;
    const fromHome = !path.relative(where, home).startsWith('..');
    const procs = fromHome && raw.exists && p.tmuxSession && this.opts.collector.workDirs ? await this.opts.collector.workDirs(p.tmuxSession) : null;
    // 홈(이나 그 위)의 바로 아래는 옆 폴더로 보지 않는다 (~/.venvs, ~/repos 같은 것이라 프로젝트가 아니다)
    // ponytail: 옆 폴더만 본다. 멀리 떨어진, 저장소 아닌 폴더는 어디까지가 프로젝트인지 알 수 없다
    const nearby = !fromHome && path.relative(up, home).startsWith('..');
    const sibling = (dir: string) => nearby && path.dirname(dir) === parent;
    const before = this.looked.get(p.id);
    // 화면을 못 읽었거나 위로 올려 보는 중이면 지난번 본 것을 그대로 둔다 (내려왔을 때 그대로인 화면을 새 일로 보지 않게)
    const readable = raw.output.length > 0 && !scrolledUp(raw.output);
    let beside = nearby && !readable ? (before?.beside ?? null) : null;
    if (nearby && readable) {
      // 입력칸에 치는 중인 글은 일하는 곳이 아니다: Claude Code 는 가로줄 사이, Codex 는 맨 아래 "› " 줄부터 (보낸 글도 "› " 로 남지만 입력칸이 늘 그 아래다)
      const above = aboveInput(raw.output);
      const typing = above.findLastIndex((l) => /^›(?: |$)/.test(l));
      for (const name of mentionedIn(typing < 0 ? above : above.slice(0, typing), [...new Set([parent, up])], homedir())) {
        const dir = path.join(parent, name);
        if ((await stat(dir).catch(() => null))?.isDirectory()) {
          beside = dir;
          break;
        }
      }
    }
    // 같은 저장소의 하위 폴더들은 맨 위로 모은다 (폴더마다 다른 프로젝트로 보면 추적 기록이 매번 새로 시작된다)
    const roots = new Map<string, string | null>();
    for (const dir of new Set([cwd, beside, followed, ...(procs ?? []).map((x) => x.dir)])) {
      if (dir) roots.set(dir, this.opts.collector.repoRoot ? await this.opts.collector.repoRoot(dir) : dir);
    }
    const fresh = procs ? this.freshWork(p, procs, followed, (dir) => roots.get(dir) ?? null) : [];
    // 옆 폴더는 pane 이 cd 로 옮겨 가거나 화면에 가장 많이 나온 옆 폴더가 바뀐 때만 본다: 옛 경로가 화면에 남아 있거나
    // pane 이 에이전트를 띄운 폴더에 그대로 있어도, 그 뒤에 따라간 곳을 되돌리지 않는다. pane 이 저장소 안에 있으면 그 저장소다 (위와 같다).
    // 처음 볼 때는 둘 다 보되 화면이 먼저다 (에이전트를 등록한 폴더에서 띄우고 옆 폴더에서 일할 수 있다)
    const seen = { cwd: cwd ?? before?.cwd ?? null, beside };
    this.looked.set(p.id, seen);
    const inRepo = !!(cwd && roots.get(cwd));
    const changed = inRepo ? [] : before ? [seen.cwd !== before.cwd ? cwd : null, beside !== before.beside ? beside : null] : [beside, cwd];
    const tried = new Set<string>();
    for (const dir of new Set([...changed, inRepo ? cwd : undefined, ...fresh, followed, ...(procs ?? []).map((x) => x.dir)])) {
      const root = dir ? (roots.get(dir) ?? (sibling(dir) ? dir : null)) : null;
      if (!root || tried.has(root)) continue;
      if (root === p.repoPath) {
        // 등록한 폴더로 cd 했거나 그 폴더가 가장 많이 나오게 됐으면 돌아온다
        if (changed.includes(dir)) break;
        continue;
      }
      tried.add(root);
      const project = { ...p, repoPath: root };
      const found = await this.opts.collector.git(project);
      // 옆 폴더는 저장소가 아니어도, git 을 잠깐 못 읽어도(시간 초과 등) 있는 동안 따라간다 (다음에 다시 찾을 신호가 없다)
      if (found.ok || (sibling(root) && (await stat(root).catch(() => null))?.isDirectory())) return { project, git: found };
    }
    return { project: p, git };
  }

  /**
   * 에이전트가 새로 일하기 시작한 폴더들 (최근 것부터): 지난번에 없던 명령과, 계속 쓰는 셸이 다른 저장소로 옮겨 간 것.
   * 뒤에서 계속 도는 옛 프로세스(남겨 둔 개발 서버 등)와 그것이 띄운 일꾼은 따라간 저장소를 되돌리지 않게 뺀다.
   * 처음 볼 때(재시작 직후 포함) 이미 따라간 저장소가 있으면 기억만 한다
   */
  private freshWork(p: ProjectConfig, procs: { pid: number; ppid: number; dir: string; shell?: boolean }[], followed: string | undefined, rootOf: (dir: string) => string | null): string[] {
    const now = new Map(procs.map((x) => [x.pid, rootOf(x.dir)]));
    const seen = this.workSeen.get(p.id) ?? (followed && followed !== p.repoPath ? now : undefined);
    this.workSeen.set(p.id, now);
    if (!seen) return procs.map((x) => x.dir);
    const byPid = new Map(procs.map((x) => [x.pid, x]));
    return procs
      .filter((x) => {
        if (seen.has(x.pid)) return seen.get(x.pid) !== now.get(x.pid);
        // 가장 가까운, 전부터 돌던 조상이 셸이 아니고(서버 등) 같은 저장소면 그 조상이 띄운 일꾼이다.
        // 에이전트의 새 명령은 에이전트(홈)와 저장소가 다르고, 계속 쓰는 셸 아래의 새 프로세스는 새 명령이다
        let up = byPid.get(x.ppid);
        while (up && !seen.has(up.pid)) up = byPid.get(up.ppid);
        return !up || up.shell === true || rootOf(up.dir) !== rootOf(x.dir);
      })
      .map((x) => x.dir);
  }

  private async collectOne(config: ProjectConfig, raw: RawTmux, nowIso: string): Promise<Collected> {
    const { project: p, git } = await this.followRepo(config, raw);
    const off = this.off.get(p.id);
    if (off) {
      if (!raw.exists) off.created = null;
      else if (raw.createdAt !== off.created) this.off.delete(p.id);
    }
    let tr = this.tracked.get(p.id);
    if (!tr || tr.repoPath !== p.repoPath) this.tracked.set(p.id, (tr = newTracked(p.repoPath)));

    // 로그 파일 설정이 바뀌면 이전 파일의 위치는 의미가 없다.
    if (tr.logFile !== p.logFile) Object.assign(tr, { logFile: p.logFile, logPos: null, logEnd: null, logErrors: [] });
    const scannedFrom = tr.logPos;
    const log = await this.opts.collector.logErrors(p, scannedFrom);
    // 스캔하는 사이 "확인 처리"로 위치가 옮겨졌으면 이 결과는 낡은 것이므로 버린다.
    if (tr.logPos === scannedFrom && scannedFrom !== null) tr.logErrors = [...new Set([...tr.logErrors, ...log.errors])].slice(-MAX_LOG_ERRORS);
    const logErrors = tr.logErrors;
    if (tr.logPos === scannedFrom) {
      tr.logEnd = log.end;
      // 최초 관측 이전의 내용은 검사하지 않는다. 파일이 교체·축소됐으면 처음부터 다시 본다.
      if (scannedFrom === null) tr.logPos = log.end;
      else if (scannedFrom.ino !== log.end.ino || scannedFrom.offset > log.end.offset) tr.logPos = { offset: 0, ino: log.end.ino };
    }
    let since: SinceBaseline | null = null;
    if (git.ok) {
      tr.baseline ??= { at: nowIso, branch: git.branch, head: git.head };
      since = await this.opts.collector.since(p, tr.baseline, git);
      // working tree 지문이 이전 폴링과 달라졌으면 Git 활동으로 본다.
      if (tr.fingerprint !== null && git.fingerprint !== tr.fingerprint) tr.gitChangedAt = nowIso;
      tr.fingerprint = git.fingerprint;
    }

    let lastOutputChangeAt: string | null = null;
    let waitingPrompt: string | null = null;
    let waitingChoices: TmuxInfo['waitingChoices'];
    let agent: TmuxInfo['agent'];
    if (raw.exists) {
      // 어느 pane 이든 출력이 바뀌면 활동이다. pane 정보가 없으면 활성 pane 출력만 본다.
      const plain = raw.panes.length ? raw.panes.map((pane) => pane.lines.map(stripAnsi)) : [raw.output];
      const ids = raw.panes.length ? raw.panes.map((x) => x.id) : [''];
      // pane 목록은 활성 pane 이 앞이라 다른 pane 을 고를 때마다 순서가 바뀐다. 비교하는 값(출력·크기)은 id 순으로 만든다
      const byId = ids.map((id, i) => ({ id, i, cols: raw.panes[i]?.cols ?? 0 })).sort((a, b) => a.id.localeCompare(b.id));
      const norm = (s: string) => (this.opts.config.ignoreSpinnerChanges ? stripVolatile(s) : s);
      const text = norm(byId.map((x) => plain[x.i]!.join('\n')).join('\f'));
      plain.forEach((lines, i) => {
        if (waitingPrompt !== null) return;
        waitingPrompt = findPrompt(lines, this.opts.config.promptPatterns);
        const pane = raw.panes[i];
        const options = waitingPrompt !== null && pane ? promptChoices(lines, waitingPrompt) : [];
        if (pane && options.length) waitingChoices = { pane: pane.id, options };
      });
      // 보는 화면에 맞춰 pane 크기를 바꾸면 프로그램이 화면을 다시 그린다. 그 변화로 "실행 중"이 되지 않게 잠시 무시한다
      const sizeKey = raw.panes.length ? byId.map((x) => `${x.id}:${x.cols}`).join(',') : '';
      if (tr.sizeKey !== null && sizeKey !== tr.sizeKey) tr.settle = RESIZE_SETTLE_TICKS;
      tr.sizeKey = sizeKey;
      if (tr.output !== null && text !== tr.output && tr.settle === 0) tr.outputChangedAt = nowIso;
      // 휴대폰 폭에서 작업 중 표시가 빠졌을 때 쓰는 pane 마다의 화면 변화. 다른 pane 의 출력·크기 변경이 섞이지 않게 pane 마다 따로 본다.
      // 입력칸 바로 위 8줄만 보고, 입력칸에 치는 글은 뺀다. 한쪽이 다른 쪽의 끝부분이면(입력칸이 커지거나 화면 높이가 바뀌어
      // 위쪽이 잘리거나 드러남) 새 출력이 아니다. 새 출력은 아래에 붙어 끝부분이 달라진다.
      // 위로 올려 보는 동안은 기준을 그대로 둔다: 맨 아래로 돌아오면 올려 보기 전 화면과 비교한다 (그사이 일했으면 달라져 있다).
      // 폭이 바뀌면 줄이 다시 나뉘므로 기준을 버리고, 다시 그리는 동안은 비교하지 않는다
      const seen = Object.fromEntries(
        plain.map((lines, i) => {
          const id = ids[i]!;
          const cols = raw.panes[i]?.cols ?? 0;
          const before = tr.seen?.[id];
          const resized = before !== undefined && before.cols !== cols;
          // 캡처에 실패하면(빈 화면) 기준을 비운다: 돌아온 같은 화면을 새 출력으로 보지 않게
          const body = lines.length === 0 ? null : scrolledUp(lines) ? (resized ? null : (before?.body ?? null)) : norm(aboveInput(lines).slice(-8).join('\n'));
          return [id, { cols, body, quiet: resized ? RESIZE_SETTLE_TICKS : Math.max(0, (before?.quiet ?? 0) - 1) }];
        }),
      );
      const changedPane = (id: string) => {
        const [a, b] = [tr.seen?.[id]?.body, seen[id]!];
        const tailOf = (x: string, y: string) => x === y || x.endsWith(`\n${y}`);
        return a != null && b.body !== null && !tailOf(a, b.body) && !tailOf(b.body, a) && b.quiet === 0;
      };
      const busy = plain.some((lines, i) => isBusy(lines, this.opts.config.busyPatterns, changedPane(ids[i]!)));
      const waiting = !busy && plain.some(waitingOnBackground);
      // 작업 중 표시를 한 번 봤거나, pane 에서 Claude Code·Codex 가 돌고 있으면 에이전트 세션이다
      if (busy || waiting || raw.panes.some((x) => /claude|codex/i.test(x.command))) tr.agent = true;
      tr.quietTicks = busy || waiting ? 0 : tr.quietTicks + 1;
      if (tr.agent) agent = waiting ? 'waiting' : tr.quietTicks >= READY_TICKS ? 'ready' : 'busy';
      if (tr.settle > 0) tr.settle -= 1;
      tr.output = text;
      tr.seen = seen;
      // tmux 의 활동 시각은 스피너 출력에도 갱신되므로 최초 관측의 초기값으로만 쓰고,
      // 이후에는 정규화한 출력 비교로만 갱신한다. demo 수집기는 이 값을 직접 제어한다.
      if (this.opts.demo) lastOutputChangeAt = latest(tr.outputChangedAt, raw.lastActivityAt);
      else lastOutputChangeAt = tr.outputChangedAt ??= raw.lastActivityAt;
      // 처음 보는(또는 예전 상태 파일의) 세션은 그때까지의 출력 시각에서 시작한다
      tr.busyAt = busy ? nowIso : (tr.busyAt ?? lastOutputChangeAt);
    } else {
      tr.output = null;
      tr.seen = null;
      tr.outputChangedAt = null;
      tr.busyAt = null;
    }

    return {
      repoPath: p.repoPath,
      git,
      since,
      lastGitChangeAt: latest(git.recentCommits[0]?.date ?? null, tr.gitChangedAt),
      tmux: { ...raw, lastOutputChangeAt, waitingPrompt, ...(waitingChoices ? { waitingChoices } : {}), ...(agent ? { agent, lastBusyAt: tr.busyAt } : {}) },
      logErrors,
    };
  }

  /** 수집해 둔 데이터로 상태를 다시 판정해 구독자에게 알린다 (test/build 실행 상태가 바뀔 때도 호출). */
  publish(): void {
    this.snapshot = this.build();
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private build(): Snapshot {
    const { config } = this.opts;
    const now = this.now();
    const projects: ProjectSnapshot[] = this.projects.flatMap((p) => {
      const c = this.collected.get(p.id);
      if (!c) return [];
      const runs = this.opts.runs(p.id);
      const status = judge({ ...c, runs, thresholds: config.thresholds, sessionExitIsError: config.sessionExitIsError, off: this.off.has(p.id), now });
      return [{ ...p, ...c, runs: { test: tailRun(runs.test), build: tailRun(runs.build) }, history: this.opts.history?.(p.id) ?? { test: [], build: [] }, status }];
    });
    const count = (state: string) => projects.filter((p) => p.status.state === state).length;
    return {
      generatedAt: new Date(now).toISOString(),
      startedAt: this.startedAt,
      demo: this.opts.demo ?? false,
      refreshIntervalSec: config.refreshIntervalSec,
      configPath: this.opts.configPath ?? '',
      configMissing: this.opts.configMissing ?? false,
      configError: this.configError,
      summary: {
        total: projects.length,
        sessionsRunning: projects.filter((p) => p.tmux.exists).length,
        running: count('running'),
        waiting: count('waiting'),
        idle: count('idle'),
        stalled: count('stalled'),
        error: count('error'),
        off: count('off'),
      },
      projects,
    };
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 이전 tick 이 끝난 뒤에 다음 tick 을 예약하므로 느린 수집이 겹치지 않는다. */
  start(): void {
    this.stopped = false;
    const loop = () => {
      // 주기는 매번 현재 config 에서 읽으므로 hot reload 로 바뀐 값이 다음 tick 부터 적용된다.
      if (!this.stopped) this.timer = setTimeout(() => void this.tick().then(loop), this.opts.config.refreshIntervalSec * 1000);
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const MAX_LOG_ERRORS = 50;

/** 스냅샷(매 tick SSE 로 나간다)에 싣는 실행 출력의 최대 길이 (stdout/stderr 각각). 전체는 따로 받는다 */
export const SNAPSHOT_OUTPUT_CHARS = 16 * 1024;
const tailRun = (r: RunResult | null): RunResult | null => {
  if (!r || (r.stdout.length <= SNAPSHOT_OUTPUT_CHARS && r.stderr.length <= SNAPSHOT_OUTPUT_CHARS)) return r;
  return { ...r, stdout: r.stdout.slice(-SNAPSHOT_OUTPUT_CHARS), stderr: r.stderr.slice(-SNAPSHOT_OUTPUT_CHARS), truncated: true };
};
const newTracked = (repoPath: string): Tracked => ({ repoPath, baseline: null, fingerprint: null, gitChangedAt: null, logFile: null, logPos: null, logEnd: null, logErrors: [], output: null, seen: null, outputChangedAt: null, sizeKey: null, settle: 0, agent: false, quietTicks: READY_TICKS, busyAt: null });

const EMPTY_GIT: GitInfo = {
  ok: false,
  branch: '',
  head: null,
  clean: true,
  changedFiles: [],
  diffStat: [],
  additions: 0,
  deletions: 0,
  recentCommits: [],
  todayCommits: [],
  fingerprint: '',
};
