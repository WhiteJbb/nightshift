import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitBaseline } from '../shared/types.ts';
import type { LogPos } from './logs.ts';
import type { RunnerState } from './runner.ts';
import type { Alert, SavedAlerts } from './notify.ts';

export interface TrackedState {
  /** 저장소 경로가 바뀌면 기준점을 버리기 위해 함께 저장한다 */
  repoPath: string;
  baseline: GitBaseline | null;
  gitChangedAt: string | null;
  /** 어느 로그 파일의 어디까지 확인했는지. 로그 파일이 바뀌면 버린다. */
  logFile: string | null;
  logPos: LogPos | null;
  /** 확인 처리 전의 로그 오류. 재시작 뒤에는 스캔 창에서 밀려났을 수 있어 함께 저장한다 (예전 파일에는 없다) */
  logErrors?: string[];
  /** 마지막으로 터미널 출력이 바뀐 시각. 없으면 재시작 후 tmux 활동 시각으로 다시 잡는다 */
  outputChangedAt?: string | null;
  /** 에이전트(작업 중 표시를 띄운 적 있는) 세션인지 */
  agent?: boolean;
  /** 에이전트가 작업 중 표시를 마지막으로 띄운 시각 (예전 파일에는 없다) */
  busyAt?: string | null;
  /** 에이전트 pane 마다 작업 중 표시가 안 보인 tick 수. 재시작 뒤에도 미뤄 둔 터미널별 작업 끝남이 이어지게 한다 (예전 파일에는 없다) */
  paneQuiet?: Record<string, number>;
  /** 지난번 본 pane 의 폴더와 화면에 가장 많이 나온 옆 폴더. 다시 띄웠을 때 남아 있던 화면을 새 일로 보지 않게 한다 (예전 파일에는 없다) */
  looked?: { cwd: string | null; beside: string | null } | null;
}

export interface MonitorState {
  startedAt: string;
  tracked: Record<string, TrackedState>;
  /** 꺼 둔 프로젝트 id → 그때 보던 tmux 세션 이름 (예전 파일에는 없다) */
  off?: Record<string, string>;
}

/** 서버를 재시작해도 밤샘 기록이 이어지도록 디스크에 남기는 상태 */
export interface PersistedState {
  version: 2;
  monitor: MonitorState;
  runner: RunnerState;
  /** 알림 반복을 막는 기억 (어느 상태를 언제 알렸는지) */
  alerts?: SavedAlerts;
  /** 보류 중인 알림 ("작업 끝남" 3분 대기 등). 재시작해도 이어서 보낸다 */
  deferred?: { alert: Alert; at: number }[];
}

/** 파일이 없거나 읽을 수 없거나 형식이 다르면 null (새 세션으로 시작). */
export function loadState(file: string): PersistedState | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const s = JSON.parse(text) as Partial<PersistedState>;
    const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;
    if (s.version !== 2 || typeof s.monitor?.startedAt !== 'string' || !isObj(s.monitor.tracked) || !isObj(s.runner)) throw new Error('알 수 없는 형식');
    return { version: 2, monitor: s.monitor, runner: s.runner, alerts: s.alerts, deferred: s.deferred };
  } catch (e) {
    console.warn(`저장된 상태를 읽지 못해 새 세션으로 시작합니다 (${file}): ${(e as Error).message}`);
    return null;
  }
}

/** 임시 파일에 쓴 뒤 rename 해서, 쓰는 도중 죽어도 기존 파일이 깨지지 않게 한다. */
export function saveState(file: string, state: PersistedState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
