import type { AgentKind, FsOp, ProjectSnapshot, ConfigUpdate, ConfigView, NewSessionRequest, TermSize, InputRequest, RawInputRequest, RunKind, RunResult, Snapshot, UploadRequest } from '../../shared/types.ts';

/** 서버가 돌려준 오류. 검증 실패(400)면 issues 에 항목별 메시지가 들어 있다. */
export class ApiError extends Error {
  issues: string[];
  /** HTTP 상태 코드 */
  status: number;
  constructor(message: string, issues: string[] = [], status = 0) {
    super(message);
    this.issues = issues;
    this.status = status;
  }
}

async function req<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', json?: unknown): Promise<T> {
  const res = await fetch(
    url,
    json === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const { error, issues } = (body ?? {}) as { error?: unknown; issues?: unknown };
    throw new ApiError(
      typeof error === 'string' ? error : `HTTP ${res.status}`,
      Array.isArray(issues) ? issues.filter((i) => typeof i === 'string') : [],
      res.status,
    );
  }
  if (body === null) throw new Error('서버 응답을 해석할 수 없습니다');
  return body as T;
}

/**
 * 연결이 끊긴 뒤 이만큼(ms) 안에 다시 붙으면 끊김을 알리지 않는다. 휴대폰에서 브라우저를 나갔다 오면 OS 가 연결을 끊었다가
 * 곧 다시 붙는데, 그때마다 "끊김"이 깜박이면 진짜 끊김과 구별되지 않는다
 */
export const DOWN_GRACE_MS = 5000;

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const api = {
  snapshot: () => req<Snapshot>('/api/snapshot'),
  project: (id: string) => req<ProjectSnapshot>(`/api/projects/${encodeURIComponent(id)}`),
  run: (id: string, kind: RunKind) =>
    req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/run/${kind}`, 'POST'),
  cancelRun: (id: string, kind: RunKind) =>
    req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/run/${kind}`, 'DELETE'),
  runOutput: (id: string, kind: RunKind) => req<RunResult>(`/api/projects/${encodeURIComponent(id)}/run/${kind}`),
  ackErrors: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/ack-errors`, 'POST'),
  // pane id 는 "%12" 꼴이라 반드시 인코딩한다
  createSession: (body: NewSessionRequest) => req<{ id: string }>('/api/sessions', 'POST', body),
  hideSession: (name: string) => req<{ ok: true }>(`/api/sessions/${encodeURIComponent(name)}/hide`, 'POST'),
  unhideSession: (name: string) => req<{ ok: true }>(`/api/sessions/${encodeURIComponent(name)}/hide`, 'DELETE'),
  killSession: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/session`, 'DELETE'),
  deleteProject: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, 'DELETE'),
  newWindow: (id: string, agent?: AgentKind) => req<{ pane: string }>(`/api/projects/${encodeURIComponent(id)}/windows`, 'POST', agent ? { agent } : {}),
  files: (id: string) => req<{ files: string[]; ignored: string[] }>(`/api/projects/${encodeURIComponent(id)}/files`),
  file: (id: string, path: string) => req<{ content: string; version: string }>(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
  /** 그림 파일 주소 (<img src> 에 그대로 쓴다) */
  rawUrl: (id: string, path: string) => `/api/projects/${encodeURIComponent(id)}/raw?path=${encodeURIComponent(path)}`,
  saveFile: (id: string, body: { path: string; content: string; version: string }) => req<{ version: string }>(`/api/projects/${encodeURIComponent(id)}/file`, 'PUT', body),
  fsOp: (id: string, body: { op: FsOp; path: string; to?: string }) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/fs`, 'POST', body),
  closePane: (id: string, paneId: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/panes/${encodeURIComponent(paneId)}`, 'DELETE'),
  markOff: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/off`, 'POST', {}),
  startSession: (id: string, size: TermSize & { agent?: AgentKind }) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/session`, 'POST', size),
  fitPane: (id: string, paneId: string, size: TermSize) =>
    req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/panes/${encodeURIComponent(paneId)}/fit`, 'POST', size),
  sendInput: (id: string, body: InputRequest) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/input`, 'POST', body),
  sendRaw: (id: string, body: RawInputRequest) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/raw`, 'POST', body),
  upload: (id: string, body: UploadRequest) => req<{ path: string }>(`/api/projects/${encodeURIComponent(id)}/upload`, 'POST', body),
  resetSession: () => req<{ ok: true }>('/api/session/reset', 'POST'),
  testPush: () => req<{ ok: true }>('/api/notify/test', 'POST'),
  config: () => req<ConfigView>('/api/config'),
  saveConfig: (update: ConfigUpdate) => req<ConfigView>('/api/config', 'PUT', update),
};
