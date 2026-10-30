import type { ProjectState, Snapshot, TmuxPane } from '../shared/types.ts';

// 유휴는 Mac 알림에서는 빠지지만, 휴대폰 푸시는 ntfyStates 로 고를 수 있어 전환 자체는 여기서 만든다.
const ALERT_STATES: Partial<Record<ProjectState, string>> = { waiting: '입력 대기', idle: '유휴', stalled: '정지 의심', error: '오류' };
/** Mac 알림을 띄우는 상태 */
export const MAC_ALERT_STATES: ProjectState[] = ['waiting', 'stalled', 'error'];

export interface Alert {
  title: string;
  message: string;
  projectId: string;
  state: ProjectState;
  /** 작업 끝남이면 일을 마친 터미널(pane id). 보는 중인지·아직 쉬는지를 그 터미널로 판단한다 */
  pane?: string;
}

/** 미뤄 둔 알림의 열쇠. 한 세션의 여러 터미널이 각각 끝남을 기다릴 수 있다 */
export const alertKey = (a: Alert): string => (a.pane ? `${a.projectId} ${a.pane}` : a.projectId);

/** 프로젝트별로 알림 판단에 필요한 기억. alertsFor 가 호출마다 갱신한다. */
export interface AlertMemory {
  state: ProjectState;
  /** 마지막으로 알린 상태 */
  alertedState: ProjectState | null;
  /** 마지막으로 알림 상태에 들어온 뒤 출력이 바뀐 tick 수 (Git 변화는 REALERT_ACTIVITY 로 친다) */
  activity: number;
  /** undefined 면 아직 못 본 것 (재시작 뒤 복원한 기억). 첫 값은 활동으로 치지 않는다 */
  lastOutputAt: string | null | undefined;
  lastGitAt: string | null | undefined;
  /** 상태별로 마지막 알림 시각과 그때의 Git 변화 시각 */
  lastAlert: Partial<Record<ProjectState, { at: string; git: string | null }>>;
  /** 에이전트 pane 마다 지난번 상태. undefined 면 아직 못 본 것 */
  panes?: Record<string, string>;
}

/** 재시작해도 이어지게 저장하는 부분 */
export type SavedAlerts = Record<string, Pick<AlertMemory, 'state' | 'alertedState' | 'lastAlert' | 'panes'>>;

export const exportAlerts = (memory: Map<string, AlertMemory>): SavedAlerts => Object.fromEntries([...memory].map(([id, m]) => [id, { state: m.state, alertedState: m.alertedState, lastAlert: m.lastAlert, panes: m.panes }]));

export const restoreAlerts = (saved: SavedAlerts | undefined): Map<string, AlertMemory> =>
  new Map(Object.entries(saved ?? {}).map(([id, m]) => [id, { ...m, activity: 0, lastOutputAt: undefined, lastGitAt: undefined }]));

/**
 * 한 번 알린 상태로 되돌아왔을 때 다시 알리려면 그 사이에 이만큼의 활동이 있어야 한다.
 * 멈춘 세션도 화면 갱신 한 번으로 "정상"이 됐다가 30분 뒤 다시 "정지 의심"이 되는데, 그건 새 소식이 아니다.
 */
export const REALERT_ACTIVITY = 3;

/**
 * 정지 의심·오류는 한 번 알리면 이 시간 동안 Git 변화(커밋·파일 변경)가 없는 한 다시 알리지 않는다.
 * 화면 출력은 크기 바꾸기·시계·스피너로도 바뀌어 "실제로 돌았다"는 증거로 약하다.
 */
export const REALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const COOLDOWN_STATES: ProjectState[] = ['stalled', 'error'];

/**
 * 이전 상태와 비교해 새로 입력 대기·정지 의심·오류가 된 프로젝트의 알림을 만든다.
 * 처음 보는 프로젝트는 알리지 않는다 (시작 시 알림 폭주 방지). 같은 상태의 반복은 그 사이에 실제 활동이 있었을 때만 알린다.
 */
export function alertsFor(memory: Map<string, AlertMemory>, snapshot: Snapshot): Alert[] {
  const alerts: Alert[] = [];
  for (const p of snapshot.projects) {
    // 오래된 오류(지난 테스트 실패 등)가 남아 있어도 에이전트가 묻고 있으면 그게 지금 알릴 일이다
    const state: ProjectState = p.tmux.exists && p.tmux.waitingPrompt ? 'waiting' : p.status.state;
    const outputAt = p.tmux.lastOutputChangeAt;
    const gitAt = p.lastGitChangeAt;
    const agents = p.tmux.panes.filter((x) => x.agent);
    const paneStates = Object.fromEntries(agents.map((x) => [x.id, x.agent!]));
    const m = memory.get(p.id);
    if (!m) {
      memory.set(p.id, { state, alertedState: null, activity: 0, lastOutputAt: outputAt, lastGitAt: gitAt, lastAlert: {}, panes: paneStates });
      continue;
    }
    if (m.lastOutputAt !== undefined && outputAt !== m.lastOutputAt) m.activity += 1;
    if (m.lastGitAt !== undefined && gitAt !== m.lastGitAt) m.activity += REALERT_ACTIVITY;
    m.lastOutputAt = outputAt;
    m.lastGitAt = gitAt;
    // 이번에 일을 마친 에이전트 터미널. 한 세션에 에이전트가 여럿이면 어느 터미널인지 제목에 붙인다
    const finished = agents.filter((x) => x.agent === 'ready' && m.panes?.[x.id] !== undefined && m.panes[x.id] !== 'ready');
    const where = (x: TmuxPane) => (agents.length < 2 ? '' : ` (터미널 ${p.tmux.panes.some((y) => y.window === x.window && y.id !== x.id) ? `${x.window}.${x.index}` : x.window})`);
    // 일을 마친 터미널마다 "작업 끝남"을 알린다. 다른 터미널이 아직 일해 세션이 실행 중이어도.
    // 입력 대기·오류 등이면 그쪽 알림이 가므로 미루고, 끝나기 전 상태를 기억해 두어 풀리면 알린다
    const eligible = state === 'idle' || state === 'running';
    const byPane = eligible ? finished : [];
    m.panes = eligible ? paneStates : { ...paneStates, ...Object.fromEntries(finished.map((x) => [x.id, m.panes![x.id]!])) };
    for (const x of byPane) alerts.push({ title: `NightShift · ${p.name}: 작업 끝남${where(x)}`, message: '작업을 마치고 다음 지시를 기다리는 중', projectId: p.id, state: 'idle', pane: x.id });
    // 에이전트가 할 일을 마친 유휴는 "작업 끝남" 으로 알린다. 에이전트 터미널을 아는 세션은 위에서 터미널마다 알린다
    // (일하던 터미널을 닫아 세션이 쉬게 된 것은 끝남이 아니다)
    const done = state === 'idle' && p.tmux.agent === 'ready';
    const label = done ? '작업 끝남' : ALERT_STATES[state];
    if (m.state !== state && label && !(done && agents.length)) {
      const alert = { title: `NightShift · ${p.name}: ${label}`, message: state === 'waiting' && p.tmux.waitingPrompt ? `입력 대기: ${p.tmux.waitingPrompt}` : p.status.reasons.join(', ') || label, projectId: p.id, state };
      // 유휴는 정지 의심으로 가는 길목이라 반복 판단에 끼우지 않는다 (기본으로는 보내지도 않는다).
      if (state === 'idle') alerts.push(alert);
      else {
        const last = m.lastAlert[state];
        const cooling = COOLDOWN_STATES.includes(state) && last !== undefined && last.git === gitAt && Date.parse(snapshot.generatedAt) - Date.parse(last.at) < REALERT_COOLDOWN_MS;
        if (!cooling && !(m.alertedState === state && m.activity < REALERT_ACTIVITY)) {
          alerts.push(alert);
          m.alertedState = state;
          m.lastAlert[state] = { at: snapshot.generatedAt, git: gitAt };
        }
        m.activity = 0;
      }
    }
    m.state = state;
  }
  for (const id of memory.keys()) if (!snapshot.projects.some((p) => p.id === id)) memory.delete(id);
  return alerts;
}

/** "작업 끝남"은 이만큼 기다렸다 보낸다: 그 사이 다시 일을 시작하면(대화 중 다음 지시) 알리지 않는다 */
export const FINISH_HOLD_MS = 3 * 60_000;

/**
 * 보낼 알림을 고른다. 미뤄 둔 알림(deferred)도 함께 다룬다.
 * - 작업 끝남·입력 대기: 그 세션 터미널을 보고 있으면 미룬다
 * - 작업 끝남: FINISH_HOLD_MS 동안 미룬다
 * 미뤄 둔 알림은 그 사이 상태가 바뀌면(still 이 거짓) 버리고, 조건이 풀리면 보낸다.
 */
export function gateAlerts(
  deferred: Map<string, { alert: Alert; at: number }>,
  fresh: Alert[],
  now: number,
  watched: (a: Alert) => boolean,
  still: (a: Alert) => boolean,
): Alert[] {
  const send: Alert[] = [];
  const held = (a: Alert, at: number) => ((a.state === 'idle' || a.state === 'waiting') && watched(a)) || (a.state === 'idle' && now - at < FINISH_HOLD_MS);
  for (const [key, d] of deferred) {
    if (!still(d.alert)) deferred.delete(key);
    else if (!held(d.alert, d.at)) {
      deferred.delete(key);
      send.push(d.alert);
    }
  }
  for (const a of fresh) {
    if (held(a, now)) deferred.set(alertKey(a), { alert: a, at: now });
    else send.push(a);
  }
  return send;
}

/**
 * 미뤄 둔 알림이 아직 맞는지. 터미널 하나의 작업 끝남은 그 터미널이 계속 쉬는 동안 맞다
 * (다른 터미널이 다시 일하거나 세션이 잠깐 오류·입력 대기여도: 다시 만들 수 없으니 버리지 않는다).
 * 나머지는 세션 상태가 그대로일 때
 */
export function stillTrue(snapshot: Snapshot, a: Alert): boolean {
  const p = snapshot.projects.find((x) => x.id === a.projectId);
  if (!p) return false;
  if (a.pane) return p.tmux.panes.find((x) => x.id === a.pane)?.agent === 'ready';
  return (p.tmux.exists && p.tmux.waitingPrompt ? 'waiting' : p.status.state) === a.state;
}
