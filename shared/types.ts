// 서버와 UI가 공유하는 API 타입. 런타임 코드 없음 (type-only import 전용).

/** waiting = 에이전트가 사용자 입력(확인 프롬프트 등)을 기다리는 중 */
/** off: 일부러 꺼 둔 세션 (대시보드에서 세션 종료, 또는 꺼진 세션을 꺼 둠으로 표시). 세션이 다시 뜨면 풀린다 */
export type ProjectState = 'running' | 'waiting' | 'idle' | 'stalled' | 'error' | 'off';
export type RunKind = 'test' | 'build';

export interface Commit {
  hash: string;
  author: string;
  /** ISO 8601 */
  date: string;
  subject: string;
}

export interface FileChange {
  path: string;
  /** git status --porcelain 의 XY 코드 (예: " M", "??", "A ") */
  status: string;
  /** 이름이 바뀐 파일의 원래 경로 */
  from?: string;
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  /** 이름이 바뀐 파일의 원래 경로 */
  from?: string;
  /** untracked 파일 (additions 는 파일의 줄 수) */
  untracked?: boolean;
}

export interface GitInfo {
  ok: boolean;
  /** ok=false 일 때의 사유 */
  error?: string;
  branch: string;
  head: string | null;
  clean: boolean;
  changedFiles: FileChange[];
  /** HEAD 대비 working tree 의 파일별 diff stat */
  diffStat: FileStat[];
  additions: number;
  deletions: number;
  recentCommits: Commit[];
  todayCommits: Commit[];
  /** 활동 감지용 불투명 지문 (HEAD + 변경 파일들의 크기·수정 시각). UI 는 쓰지 않는다 (실시간 스냅샷에서는 빈 값). */
  fingerprint: string;
  /**
   * 실시간 스냅샷에서 파일 목록(changedFiles·diffStat)을 잘랐을 때: 실제 변경 파일 수와 전체 목록의 지문.
   * 전체는 /api/projects/:id 로 받고, 지문이 바뀌면 다시 받는다 (Git 지문은 앞쪽 파일만 보므로 뒤쪽 변화는 lastGitChangeAt 에 잡히지 않는다)
   */
  cut?: { total: number; key: string };
}

/** 모니터링이 이 프로젝트를 처음 확인한 시점의 기준점 */
export interface GitBaseline {
  at: string;
  branch: string;
  head: string | null;
}

/** 최초 확인 시점부터 발생한 변경 (커밋되지 않은 변경 포함) */
export interface SinceBaseline {
  baseline: GitBaseline;
  commits: Commit[];
  files: FileStat[];
  additions: number;
  deletions: number;
  /** 실시간 스트림에서 commits·files 를 뺀 것. 전체는 GET /api/projects/:id 로 받는다 */
  partial?: boolean;
}

/** 경로가 Git 저장소가 아닐 때의 git.error. 오류 상태로 치지 않는다 (tmux 세션만 보는 프로젝트) */
export const NOT_A_REPO = 'Git 저장소가 아닙니다';

export interface TmuxPane {
  /** tmux pane id (예: "%12") */
  id: string;
  window: number;
  windowName: string;
  index: number;
  /** pane 에서 실행 중인 명령 (예: "node", "zsh") */
  command: string;
  /** 세션의 활성 윈도우의 활성 pane 인지 */
  active: boolean;
  /** pane 의 현재 디렉터리 (설정에 없는 세션의 저장소 경로로 쓴다) */
  cwd?: string;
  /** pane 의 가로 칸 수. 터미널 영역보다 넓으면 가로 스크롤이 생긴다 */
  cols?: number;
  /** 에이전트가 도는 pane 이면 그 pane 만의 상태 (TmuxInfo.agent 와 같은 뜻). 터미널마다 "작업 끝남"을 알리는 데 쓴다 */
  agent?: 'busy' | 'ready' | 'waiting';
  /**
   * 최근 출력 (최대 100줄). 색상용 SGR 시퀀스(ESC [ ... m)만 남아 있고 다른 제어 문자는 제거됨.
   * SGR 상태는 줄을 넘어 이어진다.
   */
  lines: string[];
}

export interface TmuxInfo {
  /** config 에 tmux 세션이 등록되어 있는지 */
  configured: boolean;
  exists: boolean;
  createdAt: string | null;
  attached: boolean;
  /** tmux 가 보고하는 세션 마지막 활동 시각 */
  lastActivityAt: string | null;
  /** NightShift 가 관측한 pane 출력의 마지막 변경 시각 */
  lastOutputChangeAt: string | null;
  /** 활성 pane 의 최근 출력 (최대 100줄, ANSI 제거됨) */
  output: string[];
  /** 세션의 모든 pane (최대 8개). 세션이 없으면 빈 배열 */
  panes: TmuxPane[];
  /** 입력 대기 프롬프트로 판정된 줄. 없으면 null */
  waitingPrompt: string | null;
  /** 프롬프트 아래의 번호 선택지 ("❯ 1. Yes", "2. No") 와 그 pane. 화면에서 버튼으로 바로 답한다 */
  waitingChoices?: { pane: string; options: { key: string; label: string }[] };
  /**
   * 화면에 "작업 중" 표시(esc to interrupt)를 한 번이라도 띄운 에이전트 세션이면: busy = 지금 일하는 중, ready = 할 일을 마치고 기다림,
   * waiting = 턴은 끝났지만 백그라운드 에이전트·Monitor 를 기다림 (끝나면 스스로 이어서 일한다).
   * 이런 세션은 화면이 바뀌었는지(스크롤·입력·크기 변경도 바꾼다)가 아니라 이 표시로 상태를 정한다.
   */
  agent?: 'busy' | 'ready' | 'waiting';
  /** 에이전트 세션이 작업 중 표시를 마지막으로 띄운 시각. 스크롤·입력으로는 바뀌지 않아 "마지막으로 일한 때"로 쓴다 */
  lastBusyAt?: string | null;
  /** 예: tmux attach -t session-name */
  attachCommand: string | null;
  error?: string;
}

export interface RunResult {
  kind: RunKind;
  command: string;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** 사용자가 취소했거나 서버 재시작으로 중단됨 */
  canceled: boolean;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  /** 스냅샷에 실으려고 stdout/stderr 의 앞부분을 잘라냈으면 true. 전체는 GET /api/projects/:id/run/:kind */
  truncated?: boolean;
}

/** 실행 이력 한 건 (출력 제외) */
export type RunSummary = Pick<RunResult, 'startedAt' | 'finishedAt' | 'exitCode' | 'timedOut' | 'canceled' | 'durationMs'>;

export interface ProjectStatus {
  state: ProjectState;
  /** 사람이 읽는 판정 사유 */
  reasons: string[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  repoPath: string;
  tmuxSession: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  logFile: string | null;
  /** allowInput 을 켠 프로젝트만 UI 에서 tmux 로 입력을 보낼 수 있다 */
  allowInput: boolean;
  git: GitInfo;
  since: SinceBaseline | null;
  /** 마지막 커밋 또는 working tree 변경이 관측된 시각 */
  lastGitChangeAt: string | null;
  tmux: TmuxInfo;
  /** 로그 파일에서 오류 패턴에 걸린 최근 줄 */
  logErrors: string[];
  status: ProjectStatus;
  runs: Record<RunKind, RunResult | null>;
  /** 끝난 실행의 이력, 최신순, 종류별 최대 20건 */
  history: Record<RunKind, RunSummary[]>;
}

export interface Summary {
  total: number;
  sessionsRunning: number;
  running: number;
  waiting: number;
  idle: number;
  stalled: number;
  error: number;
  off: number;
}

export interface Snapshot {
  generatedAt: string;
  /** 모니터링 세션 시작 시각 (서버를 재시작해도 유지, "새 세션 시작"으로 초기화) */
  startedAt: string;
  demo: boolean;
  refreshIntervalSec: number;
  configPath: string;
  /** config 파일이 없어 빈 목록으로 시작한 경우 */
  configMissing: boolean;
  /** 실행 중 config 를 다시 읽다가 실패했을 때의 메시지 (이전 설정으로 계속 동작 중) */
  configError: string | null;
  summary: Summary;
  projects: ProjectSnapshot[];
}

// ---- 설정 편집 (GET/PUT /api/config) ----

/** UI 에서 바꿀 수 있는 전역 설정. host·port·allowedHosts 는 파일에서만 바꾼다. */
export interface EditableSettings {
  refreshIntervalSec: number;
  thresholds: { idleMinutes: number; stalledMinutes: number; noCommitMinutes: number };
  /** 일반 문자열(대소문자 무시 부분 일치) 또는 "/정규식/플래그" */
  errorPatterns: string[];
  errorIgnorePatterns: string[];
  promptPatterns: string[];
  ignoreSpinnerChanges: boolean;
  sessionExitIsError: boolean;
  notifications: boolean;
  commandTimeoutSec: number;
  /** 휴대폰 푸시를 보낼 ntfy 주소 (예: "https://ntfy.sh/내-주제"). null 이면 보내지 않는다 */
  ntfyUrl: string | null;
  /** 휴대폰 푸시를 보낼 상태. idle 은 에이전트의 "작업 끝남" */
  ntfyStates: ProjectState[];
  /** 대시보드에서 숨긴 미등록 tmux 세션 이름 */
  hiddenSessions: string[];
}

/**
 * UI 에서 바꿀 수 있는 프로젝트 필드. 경로는 파일에 적힌 그대로의 문자열이다
 * (예: "~/code/app", logFile 은 repoPath 기준 상대 경로 가능).
 * 테스트·빌드 명령은 여기에 없다: 명령은 config 파일에서만 등록·수정한다.
 */
export interface EditableProject {
  /** 기존 프로젝트의 id. 새로 추가하는 프로젝트는 null */
  id: string | null;
  name: string;
  repoPath: string;
  tmuxSession: string | null;
  logFile: string | null;
  /** 이 프로젝트의 tmux 세션으로 브라우저에서 키 입력을 보낼 수 있게 할지 */
  allowInput: boolean;
}

export interface ConfigProjectView extends EditableProject {
  id: string;
  /** 읽기 전용 표시용 */
  testCommand: string | null;
  buildCommand: string | null;
  /** 명령이 등록된 프로젝트는 그 명령이 실행될 경로(repoPath)도 UI 에서 바꿀 수 없다 */
  repoPathLocked: boolean;
}

export interface ConfigView {
  path: string;
  /** 불러온 시점의 파일 내용 지문. 저장할 때 그대로 돌려보내 동시 수정을 감지한다 */
  version: string;
  format: 'json' | 'yaml';
  /** false 면 저장할 수 없다 (demo mode 등). 이유는 readOnlyReason */
  editable: boolean;
  readOnlyReason: string | null;
  settings: EditableSettings;
  projects: ConfigProjectView[];
  /** 파일에서만 바꿀 수 있는 값 (읽기 전용 표시용) */
  fileOnly: { host: string; port: number; allowedHosts: string[] };
}

/** PUT /api/config 본문. projects 는 전체 목록이며, 빠진 기존 프로젝트는 삭제된다. */
export interface ConfigUpdate {
  /** 편집을 시작할 때 받은 ConfigView.version. 파일이 그사이 바뀌었으면 409 */
  version: string;
  settings: EditableSettings;
  projects: EditableProject[];
}

// ---- 실시간 터미널 보기와 입력 ----

/** 글자가 아닌 키. 이 목록에 있는 것만 보낼 수 있다. */
export type InputKey = 'Enter' | 'Escape' | 'Tab' | 'BTab' | 'Up' | 'Down' | 'Left' | 'Right' | 'PPage' | 'NPage' | 'BSpace' | 'C-c' | 'C-d' | 'C-u' | 'C-l';

/**
 * POST /api/projects/:id/input — pane 에 키 입력을 보낸다. text 와 key 중 정확히 하나.
 * - text: 글자 그대로 입력한다 (최대 20000자, 여러 줄이면 붙여넣기로 들어간다). enter 가 true 면 이어서 Enter 를 누른다.
 *   now 가 true 면 Enter 대신 Ctrl+X → Ctrl+S (Claude Code 의 send now: 일하는 중에도 대기열에서 기다리지 않고 바로 읽는다).
 * - key: 특수 키 하나 (BTab = Shift+Tab, PPage/NPage = Page Up/Down, C-c = Ctrl+C).
 * 응답: 200 {ok:true} / 400 {error} / 403 {error} (allowInput 꺼짐, demo, 서버가 loopback·Tailscale 이 아닌 주소에 열림) / 404 {error} (프로젝트·pane 없음)
 */
export interface InputRequest {
  /** 이 프로젝트 세션에 속한 pane id (TmuxPane.id) */
  pane: string;
  text?: string;
  enter?: boolean;
  now?: boolean;
  key?: InputKey;
}

/**
 * GET /api/projects/:id/term/:paneId — pane 출력을 SSE 로 흘려보낸다 (data: JSON 한 줄씩).
 * init: 첫 화면(스크롤백 + 현재 화면 + 커서·모드, base64 바이트). 연결될 때마다 다시 온다.
 * out: 이어지는 출력 바이트(base64). resize: pane 크기가 바뀜. error: 메시지. exit: pane·세션이 끝남.
 */
export type TermEvent =
  | { type: 'init'; cols: number; rows: number; alt: boolean; data: string }
  | { type: 'out'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'error'; message: string }
  | { type: 'exit' };

/**
 * POST /api/projects/:id/raw — 터미널이 만든 바이트(키·마우스 보고)를 pane 에 그대로 넣는다. 입력과 같은 조건·기록.
 * 응답: 200 {ok:true} / 400 / 403 / 404 (input 과 같다)
 */
export interface RawInputRequest {
  pane: string;
  /** base64, 최대 4KB */
  data: string;
}

/**
 * POST /api/projects/:id/upload — 이미지를 서버에 파일로 저장한다 (입력과 같은 조건에서만 허용).
 * 응답: 200 {path} — 이 절대 경로를 입력에 넣으면 에이전트가 첨부로 읽는다.
 */
export interface UploadRequest {
  /** image/png · image/jpeg · image/gif · image/webp */
  type: string;
  /** base64 (10MB 이하) */
  data: string;
}

// ---- tmux 세션 만들기 ----

/**
 * POST /api/sessions — 저장소 경로에서 새 tmux 세션(셸)을 만들고 프로젝트로 등록한다.
 * 같은 이름의 세션이 이미 있으면 새로 만들지 않고 그 세션을 등록한다.
 * 응답: 200 {id} (새 프로젝트 id) / 400 {error, issues?} / 403 {error} (demo, 서버가 loopback·Tailscale 밖에 열림) / 409 {error} (이미 등록된 세션)
 *
 * POST /api/projects/:id/session (본문 없음) — 등록된 프로젝트의 세션이 없을 때 그 이름으로 다시 만든다. 200 {ok:true} / 400 / 403 / 404
 */
/** 새 세션에서 바로 띄울 수 있는 에이전트와 그 명령 (웹에서 임의 명령은 받지 않는다) */
export const AGENT_COMMANDS = { claude: 'claude', codex: 'codex' } as const;
/** 파일 탭의 파일 다루기 (POST /api/projects/:id/fs) */
export type FsOp = 'newFile' | 'newDir' | 'move' | 'copy' | 'delete';
export type AgentKind = keyof typeof AGENT_COMMANDS;

export interface NewSessionRequest {
  /** 프로젝트 표시 이름 */
  name: string;
  /** 세션을 시작할 디렉터리. "~" 사용 가능 */
  repoPath: string;
  /** tmux 세션 이름 (공백, ":", "." 불가) */
  tmuxSession: string;
  /** 만들자마자 터미널 입력을 허용할지 */
  allowInput: boolean;
  /** 있으면 repoPath 에 먼저 git clone 한다 (https://, ssh://, git@host:path 만). 이미 저장소가 있으면 건너뛴다 */
  gitUrl?: string;
  /** 새 세션에서 바로 시작할 에이전트. 정해진 명령만 친다 (AGENT_COMMANDS) */
  agent?: AgentKind;
  /** 세션의 화면 크기. 보는 화면에 맞춰 보내면 가로 스크롤이 생기지 않는다 (생략 시 120×40) */
  cols?: number;
  rows?: number;
}

/**
 * 화면 크기 요청 본문 (칸·줄). 서버가 40~300칸, 10~100줄로 자른다.
 * - POST /api/projects/:id/session 의 선택적 본문
 * - POST /api/projects/:id/panes/:paneId/fit — pane 이 속한 tmux 윈도우를 이 크기로 바꾼다.
 *   터미널이 붙어 있지 않은 세션에만 허용 (붙어 있으면 409). 200 {ok:true} / 403 / 404 / 409
 */
export interface TermSize {
  cols: number;
  rows: number;
}
