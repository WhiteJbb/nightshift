import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { constants, createGzip, gzipSync } from 'node:zlib';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AgentKind, ConfigView, EditableProject, RawInputRequest, Snapshot, TermEvent } from '../shared/types.ts';
import { AGENT_COMMANDS } from '../shared/types.ts';
import type { Config } from './config.ts';
import { ConfigError, SESSION_RE } from './config.ts';
import { ConfigConflict } from './configEdit.ts';
import { FileError, fsOp, listFiles, listIgnored, readRaw, readText, writeText } from './files.ts';
import { GIT_URL_RE } from './git.ts';
import type { ParsedInput } from './input.ts';
import { parseInput } from './input.ts';
import type { Monitor } from './monitor.ts';
import type { Runner } from './runner.ts';
import type { TermSize } from './tmux.ts';
import { clampSize, MAX_PANES } from './tmux.ts';
import { parseUpload } from './upload.ts';

/** 한 번에 받는 raw 입력의 최대 바이트 (키 몇 개나 마우스 보고 묶음이면 충분하다) */
export const MAX_RAW_BYTES = 4096;
/** 터미널 스트림 한 연결이 보내지 못하고 쌓아 둘 수 있는 최대 바이트 */
export const MAX_SSE_BUFFER = 8 * 1024 * 1024;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();
const isLoopback = (host: string) => LOOPBACK.has(hostname(host));
const isLoopbackBind = (host: string) => isLoopback(host) || host === '::1';

/** Tailscale 이 기기에 주는 주소 (100.64.0.0/10, fd7a:115c:a1e0::/48). tailnet 안에서만 닿는다. */
export function isTailscaleAddress(host: string): boolean {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return host.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/** 터미널 입력을 받아도 되는 바인딩인지: loopback 이거나 Tailscale 주소. 0.0.0.0 이나 LAN 주소는 안 된다. */
export const isPrivateBind = (host: string) => isLoopbackBind(host) || isTailscaleAddress(host);

/**
 * 방어선.
 * - loopback 바인딩이면 Host 헤더가 loopback, *.ts.net(`tailscale serve` 가 중계한 이름), allowedHosts 중 하나여야 한다 (DNS rebinding 방어).
 *   *.ts.net 은 Tailscale 만 DNS 를 정하고 127.0.0.1 로 풀리지 않는다. 그래서 serve 를 손으로 켜거나 기기 이름이 바뀌어도 따로 적을 필요가 없다.
 *   allowedHosts 는 그 밖의 프록시 이름을 위한 것.
 * - Tailscale 바인딩이면 그 주소, MagicDNS 이름(*.ts.net 또는 점 없는 짧은 이름), allowedHosts 만 받는다.
 *   tailnet 의 브라우저도 rebinding 에 걸릴 수 있다. 점 없는 이름은 공개 DNS 로 만들 수 없으므로 안전하다.
 *   그 밖의 주소로 바꾼 경우는 사용자가 감수한 것으로 본다.
 * - 변경 요청은 Origin 이 정확히 이 서버일 때만 허용 (다른 웹사이트가 명령 실행을 유발하지 못하게).
 *   직접 접속이면 http://<Host 헤더> 이고 그 포트가 이 서버가 받은 포트여야 한다. 프록시를 거쳐 *.ts.net 으로 들어왔으면
 *   그 이름과 정확히 같은 https 출처만(다른 tailnet 의 Funnel 페이지는 출처가 달라 막힌다), 그 밖의 프록시는 https://<allowedHosts 이름> (443) 만 받는다.
 *   이름만 보면 같은 기기의 다른 포트(다른 개발 서버)에서 온 요청도 통과하므로 scheme·포트까지 비교한다.
 */
export function guard(config: Pick<Config, 'host'> & Partial<Pick<Config, 'allowedHosts'>>) {
  const tailscale = isTailscaleAddress(config.host);
  const checkHost = isLoopbackBind(config.host) || tailscale;
  const allowed = new Set(config.allowedHosts ?? []);
  const self = new Set([config.host.toLowerCase(), `[${config.host.toLowerCase()}]`]);
  const hostOk = (host: string) => {
    const name = hostname(host);
    return isLoopback(host) || allowed.has(name) || name.endsWith('.ts.net') || (tailscale && (self.has(name) || !name.includes('.')));
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (checkHost && !hostOk(host)) return void res.status(403).json({ error: '허용되지 않은 Host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
      const o = URL.parse(origin)?.origin;
      const direct = URL.parse(`http://${host}`);
      const viaSelf = direct !== null && Number(direct.port || 80) === req.socket?.localPort && o === direct.origin;
      // *.ts.net 으로 들어왔으면 출처도 정확히 그 이름이어야 한다 (이름을 바꾼 뒤 allowedHosts 에 남은 옛 이름에서 오는 요청을 막는다)
      const proxied = URL.parse(`https://${host}`);
      const viaProxy = o?.startsWith('https://') && (proxied?.hostname.endsWith('.ts.net') ? o === proxied.origin : allowed.has(o.slice('https://'.length)));
      if (!viaSelf && !viaProxy) return void res.status(403).json({ error: '허용되지 않은 Origin' });
    }
    next();
  };
}

export interface AppDeps {
  /** 시작 시점의 config. host 검사에만 쓴다 (host/port 는 재시작해야 바뀐다). */
  config: Config;
  monitor: Monitor;
  runner: Runner;
  /** 실시간 pane 보기와 키 입력. 없으면(demo) 스냅샷의 출력만 돌려주고 입력은 거부한다 */
  terminal?: {
    /** 실패하면 오류 메시지 */
    send: (input: ParsedInput) => Promise<string | null>;
    /** 터미널 에뮬레이터의 바이트를 그대로 넣는다. 실패하면 오류 메시지 */
    sendRaw: (paneId: string, bytes: Uint8Array) => Promise<string | null>;
    /** pane 출력 스트림. 돌려주는 함수로 끊는다 */
    stream: (session: string, paneId: string, sink: (e: TermEvent) => void) => () => void;
    log: (projectId: string, input: ParsedInput) => void;
    /** repoPath(원문, "~" 가능)에서 셸 세션을 만든다. 이미 있으면 그대로 둔다. 실패하면 오류 메시지 */
    createSession: (name: string, repoPath: string, size: TermSize, agent?: AgentKind) => Promise<string | null>;
    /** 세션을 끝낸다. 실패하면 오류 메시지 */
    killSession: (name: string) => Promise<string | null>;
    /** 세션에 repoPath(원문)에서 셸 윈도우를 하나 더 연다. agent 를 주면 그 셸에서 띄운다 */
    newWindow: (session: string, repoPath: string, agent?: AgentKind) => Promise<{ pane: string } | { error: string }>;
    /** pane 을 닫는다. 실패하면 오류 메시지 */
    killPane: (paneId: string) => Promise<string | null>;
    /** repoPath(원문) 에 git clone. 이미 저장소면 건너뛴다. 실패하면 오류 메시지 */
    cloneRepo: (url: string, repoPath: string) => Promise<string | null>;
    /** pane 이 속한 윈도우의 크기를 바꾼다. 실패하면 오류 메시지 */
    resize: (paneId: string, size: TermSize) => Promise<string | null>;
    /** 올린 이미지를 저장하고 절대 경로를 돌려준다 */
    saveUpload: (projectId: string, ext: string, data: Buffer) => Promise<string>;
  };
  /** 휴대폰 푸시 시험 전송. 실패하면 오류 메시지. 없으면(demo) 거부한다 */
  testPush?: () => Promise<string | null>;
  /** 설정 편집. 없으면 /api/config 는 404 */
  configEditor?: {
    view: () => ConfigView;
    /** 본문을 검증해 저장하고 즉시 적용한다. 잘못된 값이면 ConfigError */
    update: (body: unknown) => Promise<ConfigView>;
  };
}

/** 요청의 agent: 없으면 undefined, 정해진 에이전트가 아니면 null. `in` 은 constructor 같은 상속 이름도 통과시키므로 쓰지 않는다 */
export const parseAgent = (v: unknown): AgentKind | undefined | null =>
  v === undefined || v === null ? undefined : typeof v === 'string' && Object.hasOwn(AGENT_COMMANDS, v) ? (v as AgentKind) : null;

/** 실시간 스냅샷에 싣는 변경 파일 목록의 최대 길이. 커밋 안 한 결과물이 수천 개인 저장소도 있다 */
export const STREAM_FILES = 300;

/**
 * 5초마다 가는 실시간 스냅샷에서 큰 것을 뺀다: pane 화면 사본(터미널은 따로 스트림으로 받는다),
 * 기준점 이후 커밋·파일 목록과 넘치는 변경 파일 목록(Git·파일 탭이 열 때 따로 받는다), 서버만 쓰는 Git 지문. 휴대폰에서 시간당 수십 MB 가 나가던 것을 줄인다.
 */
export const slimSnapshot = (s: Snapshot): Snapshot => ({
  ...s,
  projects: s.projects.map((p) => {
    const cut = p.git.changedFiles.length > STREAM_FILES || p.git.diffStat.length > STREAM_FILES;
    return {
      ...p,
      git: {
        ...p.git,
        fingerprint: '',
        ...(cut && {
          changedFiles: p.git.changedFiles.slice(0, STREAM_FILES),
          diffStat: p.git.diffStat.slice(0, STREAM_FILES),
          cut: { total: p.git.changedFiles.length, key: createHash('sha1').update(JSON.stringify([p.git.changedFiles, p.git.diffStat])).digest('base64url') },
        }),
      },
      tmux: { ...p.tmux, panes: p.tmux.panes.map((x) => ({ ...x, lines: [] })), output: p.tmux.panes.length ? [] : p.tmux.output },
      since: p.since && { ...p.since, commits: [], files: [], partial: true },
    };
  }),
});

const gzipOk = (req: Request) => req.acceptsEncodings('gzip') === 'gzip';

/** 큰 JSON(스냅샷 수백 KB)은 받는 쪽이 받으면 gzip 으로 보낸다 */
function sendJson(req: Request, res: Response, body: unknown): void {
  const json = JSON.stringify(body);
  res.vary('Accept-Encoding').type('json');
  if (gzipOk(req)) res.set('Content-Encoding', 'gzip').send(gzipSync(json));
  else res.send(json);
}

/**
 * 빌드한 화면 파일. 이름에 해시가 붙은 /assets 는 내용이 바뀌지 않으므로 오래 캐시한다 (새 릴리즈는 index.html 이 새 이름을 가리키고,
 * index.html 은 늘 다시 확인한다). 글로 된 것(js·css·svg)은 받는 쪽이 받으면 gzip 으로 보낸다 (파일마다 한 번 압축해 기억한다)
 */
export function distFiles(dist: string): express.RequestHandler {
  const assets = path.join(dist, 'assets');
  const forever = 'public, max-age=31536000, immutable';
  const files = express.static(dist, { setHeaders: (res, file) => path.dirname(file) === assets && res.set({ 'Cache-Control': forever, Vary: 'Accept-Encoding' }) });
  const zipped = new Map<string, Buffer>();
  return (req, res, next) => {
    const name = /^\/assets\/([\w.-]+\.(?:js|css|svg))$/.exec(req.path)?.[1];
    if (!name || !gzipOk(req)) return files(req, res, next);
    let gz = zipped.get(name);
    if (!gz && existsSync(path.join(assets, name))) zipped.set(name, (gz = gzipSync(readFileSync(path.join(assets, name)))));
    if (!gz) return files(req, res, next);
    res.type(path.extname(name)).set({ 'Content-Encoding': 'gzip', 'Cache-Control': forever, Vary: 'Accept-Encoding' }).send(gz);
  };
}

export function createApp({ config, monitor, runner, configEditor, terminal, testPush }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(guard(config));
  // 다른 페이지가 대시보드를 투명하게 덮어 실행 버튼을 누르게 하지 못하게 (clickjacking: 그 클릭은 대시보드 자신의 출처라 guard 를 지난다)
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });

  const api = express.Router();

  // 처음 띄울 때 받는 것도 실시간 스냅샷과 같은 가벼운 것이다 (한 프로젝트의 전체는 아래)
  api.get('/snapshot', (req, res) => sendJson(req, res, slimSnapshot(monitor.snapshot)));

  // 한 프로젝트의 전체 상태 (스트림에서 뺀 기준점 이후 커밋·파일 목록 포함). Git 탭이 열 때 받는다
  api.get('/projects/:id', (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    sendJson(req, res, project);
  });

  api.get('/events', (req, res) => {
    // 받는 쪽이 받으면 gzip 으로. 스냅샷마다 비워 보내(sync flush) 늦지 않게 하고, 압축 사전은 이어 써서 비슷한 다음 스냅샷이 더 작아진다
    const gz = gzipOk(req) ? createGzip() : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', Vary: 'Accept-Encoding', ...(gz && { 'Content-Encoding': 'gzip' }) });
    gz?.pipe(res);
    const out = gz ?? res;
    // 느린 클라이언트에는 쌓아 두지 않고 건너뛴다. 스냅샷은 매번 전체 상태라 다음 것만 받아도 된다.
    const send = (s: unknown) => {
      if (out.writableNeedDrain || res.writableNeedDrain) return;
      out.write(`data: ${JSON.stringify(s)}\n\n`);
      gz?.flush(constants.Z_SYNC_FLUSH);
    };
    send(slimSnapshot(monitor.snapshot));
    const stop = monitor.subscribe((s) => send(slimSnapshot(s)));
    req.on('close', () => {
      stop();
      gz?.destroy();
    });
  });

  // 요청 본문은 읽지 않는다. 실행되는 명령은 항상 config 에 적힌 것.
  api.post('/projects/:id/run/:kind', (req, res) => {
    const { id, kind } = req.params;
    const project = monitor.config.projects.find((p) => p.id === id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    if (kind !== 'test' && kind !== 'build') return void res.status(400).json({ error: 'kind 는 test 또는 build 여야 합니다' });
    const outcome = runner.start(project, kind);
    if (outcome === 'no-command') return void res.status(400).json({ error: 'config 에 등록된 명령이 없습니다' });
    if (outcome === 'already-running') return void res.status(409).json({ error: '이미 실행 중입니다' });
    res.status(202).json({ ok: true });
  });

  // 스냅샷에는 출력의 끝부분만 실린다 (RunResult.truncated). 전체 출력은 화면에서 펼칠 때 여기서 받는다.
  api.get('/projects/:id/run/:kind', (req, res) => {
    const { id, kind } = req.params;
    if (kind !== 'test' && kind !== 'build') return void res.status(400).json({ error: 'kind 는 test 또는 build 여야 합니다' });
    const run = runner.peek(id)[kind];
    if (!run) return void res.status(404).json({ error: '실행 기록이 없습니다' });
    res.json(run);
  });

  api.delete('/projects/:id/run/:kind', (req, res) => {
    const { id, kind } = req.params;
    if (kind !== 'test' && kind !== 'build') return void res.status(400).json({ error: 'kind 는 test 또는 build 여야 합니다' });
    if (!runner.cancel(id, kind)) return void res.status(409).json({ error: '실행 중이 아닙니다' });
    res.status(202).json({ ok: true });
  });

  // 스냅샷에 있는 pane(= 이 프로젝트의 세션에 속한 pane)만 대상으로 삼는다.
  const findPane = (projectId: string, paneId: unknown) => {
    const project = monitor.snapshot.projects.find((p) => p.id === projectId);
    return { project, pane: project?.tmux.panes.find((x) => x.id === paneId) };
  };

  // 웹에서 터미널로 키 입력을 보내는 유일한 경로. 임의 명령 실행과 같으므로 여러 겹으로 막는다:
  // allowInput 을 켠 프로젝트만, loopback·Tailscale 바인딩일 때만, 그 프로젝트 세션의 pane 으로만.
  const inputBlocked = (project: { allowInput: boolean }): string | null => {
    if (!terminal) return 'demo mode 에서는 입력을 보낼 수 없습니다';
    if (!project.allowInput) return '이 프로젝트는 터미널 입력이 꺼져 있습니다. 설정 화면에서 켜세요.';
    if (!isPrivateBind(config.host)) return '서버가 loopback·Tailscale 이 아닌 주소에 열려 있어 입력을 보낼 수 없습니다';
    return null;
  };
  api.post('/projects/:id/input', express.json({ limit: '32kb' }), async (req, res) => {
    const input = parseInput(req.body);
    if (typeof input === 'string') return void res.status(400).json({ error: input });
    const { project, pane } = findPane(req.params.id, input.pane);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    terminal.log(project.id, input);
    const error = await terminal.send(input);
    if (error) return void res.status(500).json({ error });
    res.json({ ok: true });
  });

  // 터미널 에뮬레이터가 만든 바이트. 글 입력과 같은 경로와 같은 조건이고, 같은 파일에 기록한다.
  api.post('/projects/:id/raw', express.json({ limit: '8kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Partial<RawInputRequest>;
    const bytes = typeof body.data === 'string' && /^[A-Za-z0-9+/=]*$/.test(body.data) ? Buffer.from(body.data, 'base64') : null;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_RAW_BYTES) return void res.status(400).json({ error: `data 는 base64 1~${MAX_RAW_BYTES} 바이트여야 합니다` });
    const { project, pane } = findPane(req.params.id, body.pane);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    // 마우스 보고(휠·클릭)만 있는 바이트는 기록하지 않는다. 사람이 친 글이 아니고 양이 많다
    const text = bytes.toString('utf8');
    // eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
    if (text.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '') !== '') terminal.log(project.id, { pane: pane.id, text, enter: false });
    const error = await terminal.sendRaw(pane.id, bytes);
    if (error) return void res.status(500).json({ error });
    res.json({ ok: true });
  });

  // pane 출력 스트림. 읽기만 하므로 입력 조건은 걸지 않는다 (스냅샷에 있는 pane 만).
  api.get('/projects/:id/term/:paneId', (req, res) => {
    const { project, pane } = findPane(req.params.id, req.params.paneId);
    if (!project || !pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    if (!terminal || !project.tmuxSession) return void res.status(403).json({ error: 'demo mode 에서는 터미널 스트림이 없습니다' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // 출력은 건너뛸 수 없다 (한 조각이 빠지면 화면이 어긋난다). 느린 클라이언트에 너무 쌓이면 끊는다:
    // 브라우저 EventSource 가 다시 붙으면 첫 화면부터 새로 받는다
    const off = terminal.stream(project.tmuxSession, pane.id, (e) => {
      // 끊은 뒤에도 기다리던 첫 화면이 올 수 있다. 끝난 응답에 쓰면 서버가 죽는다
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (res.writableLength > MAX_SSE_BUFFER) {
        off();
        res.end();
      }
    });
    req.on('close', off);
  });

  // 여러 pane 을 SSE 하나로 (나란히 보기). 브라우저는 http/1.1 에서 주소당 연결을 6개만 열어서, pane 마다 열면 입력 요청이 막힌다.
  // 이벤트는 위와 같고 어느 pane 것인지 pane 필드가 붙는다
  api.get('/projects/:id/terms', (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    const ids = typeof req.query.panes === 'string' ? req.query.panes.split(',') : [];
    const panes = ids.map((id) => project?.tmux.panes.find((x) => x.id === id));
    if (!project || !ids.length || ids.length > MAX_PANES || panes.some((x) => !x)) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    if (!terminal || !project.tmuxSession) return void res.status(403).json({ error: 'demo mode 에서는 터미널 스트림이 없습니다' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const offs: (() => void)[] = [];
    const stop = () => offs.splice(0).forEach((off) => off());
    for (const id of ids) {
      offs.push(
        terminal.stream(project.tmuxSession, id, (e) => {
          if (res.writableEnded) return; // 위와 같다
          res.write(`data: ${JSON.stringify({ ...e, pane: id })}\n\n`);
          if (res.writableLength > MAX_SSE_BUFFER) {
            stop();
            res.end();
          }
        }),
      );
    }
    req.on('close', stop);
  });

  // 이미지는 파일로 저장만 한다. 경로를 입력에 넣어 보내는 것은 평범한 글 입력과 같은 경로를 탄다.
  // base64 는 원본의 4/3 이라 10MB 이미지가 14MB 안에 들어온다.
  api.post('/projects/:id/upload', express.json({ limit: '14mb' }), async (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    const upload = parseUpload(req.body);
    if (typeof upload === 'string') return void res.status(400).json({ error: upload });
    res.json({ path: await terminal.saveUpload(project.id, upload.ext, upload.data) });
  });

  // 세션 만들기는 셸 프로세스를 띄우는 일이라 입력과 같은 범위(loopback·Tailscale)에서만 받는다.
  // 실행할 명령은 받지 않는다: 항상 기본 셸만 뜬다.
  const sessionBlocked = (): string | null => {
    if (!terminal) return 'demo mode 에서는 세션을 만들 수 없습니다';
    if (!isPrivateBind(config.host)) return '서버가 loopback·Tailscale 이 아닌 주소에 열려 있어 세션을 만들 수 없습니다';
    return null;
  };

  // 보는 화면에 맞게 tmux 윈도우 크기를 바꾼다. 터미널이 붙어 있는 세션은 그 터미널 화면까지 바뀌므로 건드리지 않는다.
  api.post('/projects/:id/panes/:paneId/fit', express.json({ limit: '4kb' }), async (req, res) => {
    const { project, pane } = findPane(req.params.id, req.params.paneId);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    // 입력 허용과는 상관없다: 크기만 바꾸고 프로그램에 글자를 보내지 않는다 (보기만 하는 프로젝트도 화면에 맞춰 보이게)
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    if (project.tmux.attached) return void res.status(409).json({ error: '터미널이 붙어 있는 세션은 크기를 바꾸지 않습니다' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const error = await terminal.resize(pane.id, clampSize(body.cols, body.rows));
    if (error) {
      // 맞추는 사이 세션·터미널이 닫혔으면(세션 종료 직후 도착한 자동 맞추기 등) 맞출 것이 없을 뿐 오류가 아니다
      await monitor.tick();
      if (!findPane(req.params.id, req.params.paneId).pane) return void res.json({ ok: true });
      return void res.status(500).json({ error });
    }
    await monitor.tick();
    res.json({ ok: true });
  });

  api.post('/projects/:id/session', express.json({ limit: '4kb' }), async (req, res) => {
    const project = monitor.config.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!project.tmuxSession) return void res.status(400).json({ error: '이 프로젝트에는 tmux 세션이 등록되어 있지 않습니다' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agent = parseAgent(body.agent);
    if (agent === null) return void res.status(400).json({ error: '에이전트는 claude 또는 codex 만 고를 수 있습니다' });
    const error = await terminal.createSession(project.tmuxSession, project.repoPath, clampSize(body.cols, body.rows), agent);
    if (error) return void res.status(400).json({ error });
    await monitor.tick();
    res.json({ ok: true });
  });

  // 세션 끝내기: 세션 만들기와 같은 조건(loopback·Tailscale). 글자를 보내는 일이 아니라 입력 허용과는 상관없다. 안에서 돌던 프로그램도 같이 끝난다
  api.delete('/projects/:id/session', async (req, res) => {
    const project = monitor.config.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!project.tmuxSession) return void res.status(400).json({ error: '이 프로젝트에는 tmux 세션이 등록되어 있지 않습니다' });
    // 일부러 끈 세션은 오류가 아니라 꺼 둠이다. 끄기 전에 표시해야 그 사이 tick 이 오류로 알리지 않는다
    monitor.setOff(project.id, true);
    const error = await terminal.killSession(project.tmuxSession);
    if (error) {
      monitor.setOff(project.id, false);
      return void res.status(400).json({ error });
    }
    await monitor.tick();
    res.json({ ok: true });
  });

  // 대시보드 밖에서(터미널에서 exit 등) 끈 세션을 꺼 둠으로 표시한다. 세션을 다시 시작하면 풀린다
  api.post('/projects/:id/off', (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    if (!project || !monitor.config.projects.some((p) => p.id === project.id)) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked) return void res.status(403).json({ error: blocked });
    if (!project.tmuxSession) return void res.status(400).json({ error: '이 프로젝트에는 tmux 세션이 등록되어 있지 않습니다' });
    if (project.tmux.exists) return void res.status(409).json({ error: '세션이 돌고 있습니다. 끄려면 세션 종료를 누르세요' });
    monitor.setOff(project.id, true, true);
    res.json({ ok: true });
  });

  // 같은 세션에 터미널(셸 윈도우)을 하나 더 연다. 셸에 칠 수 있게 되는 일이라 입력과 같은 조건이다
  api.post('/projects/:id/windows', express.json({ limit: '4kb' }), async (req, res) => {
    const project = monitor.snapshot.projects.find((p) => p.id === req.params.id);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = inputBlocked(project);
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!project.tmuxSession || !project.tmux.exists) return void res.status(400).json({ error: 'tmux 세션이 실행 중이 아닙니다' });
    // 그보다 많으면 스냅샷에서 잘려 새 터미널이 안 보인다.
    // ponytail: 스냅샷 기준이라 두 화면에서 동시에 누르면 하나 넘칠 수 있다 (tmux 에는 남고 목록에서만 빠진다). 문제되면 세션별로 줄 세운다
    if (project.tmux.panes.length >= MAX_PANES) return void res.status(409).json({ error: `터미널은 세션당 ${MAX_PANES}개까지 열 수 있습니다` });
    const agent = parseAgent(((req.body ?? {}) as Record<string, unknown>).agent);
    if (agent === null) return void res.status(400).json({ error: '에이전트는 claude 또는 codex 만 고를 수 있습니다' });
    const r = await terminal.newWindow(project.tmuxSession, project.repoPath, agent);
    if ('error' in r) return void res.status(400).json(r);
    await monitor.tick();
    res.json(r);
  });

  // 터미널(pane) 닫기: 세션 종료와 같은 조건. 마지막 pane 이면 세션도 끝난다 (화면은 그때 세션 종료 버튼만 보여 준다)
  api.delete('/projects/:id/panes/:paneId', async (req, res) => {
    const { project, pane } = findPane(req.params.id, req.params.paneId);
    if (!project) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!pane) return void res.status(404).json({ error: 'pane 을 찾을 수 없습니다' });
    const error = await terminal.killPane(pane.id);
    if (error) return void res.status(400).json({ error });
    await monitor.tick();
    res.json({ ok: true });
  });

  // 파일 보기·고치기 (files.ts). 보기는 모든 프로젝트, 저장은 입력과 같은 조건이다 (셸에서 고치는 것과 같은 일).
  // .gitignore 에 걸린 파일(.env 등)은 비밀이 들어 있기 쉬워서 보기도 입력과 같은 조건이다 (그 셸에서 cat 하는 것과 같다)
  const projectOf = (id: string) => {
    const project = monitor.snapshot.projects.find((p) => p.id === id);
    if (!project) throw new FileError('프로젝트를 찾을 수 없습니다', 404);
    return project;
  };
  api.get('/projects/:id/files', async (req, res) => {
    const project = projectOf(req.params.id);
    // 무시된 파일 목록을 못 받아도(거대한 빌드 결과물 등) 보통 파일 목록은 보여 준다
    res.json({ files: await listFiles(project.repoPath), ignored: inputBlocked(project) ? [] : await listIgnored(project.repoPath).catch(() => []) });
  });
  api.get('/projects/:id/file', async (req, res) => {
    const project = projectOf(req.params.id);
    res.json(await readText(project.repoPath, req.query.path, !inputBlocked(project)));
  });
  // 그림 미리보기. 보기 규칙은 /file 과 같다. SVG 를 새 탭에서 바로 열어도 이 출처(터미널 입력 권한이 있다)에서 스크립트가 돌지 않게 sandbox 를 건다
  api.get('/projects/:id/raw', async (req, res) => {
    const project = projectOf(req.params.id);
    const { data, type } = await readRaw(project.repoPath, req.query.path, !inputBlocked(project));
    res.set({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'no-store' }).send(data);
  });
  api.put('/projects/:id/file', express.json({ limit: '4mb' }), async (req, res) => {
    const project = projectOf(req.params.id);
    const blocked = inputBlocked(project);
    if (blocked) return void res.status(403).json({ error: blocked });
    const { path, content, version } = (req.body ?? {}) as Record<string, unknown>;
    res.json({ version: await writeText(project.repoPath, path, content, version, true) });
  });

  // 새 파일·폴더, 이동·이름 바꾸기, 복사, 삭제(.git 안 휴지통으로). 저장과 같은 조건
  api.post('/projects/:id/fs', express.json({ limit: '16kb' }), async (req, res) => {
    const project = projectOf(req.params.id);
    const blocked = inputBlocked(project);
    if (blocked) return void res.status(403).json({ error: blocked });
    const { op, path, to } = (req.body ?? {}) as Record<string, unknown>;
    await fsOp(project.repoPath, op, path, to);
    res.json({ ok: true });
  });

  const editableProjects = (view: ConfigView): EditableProject[] =>
    view.projects.map(({ id, name, repoPath, tmuxSession, logFile, allowInput }) => ({ id, name, repoPath, tmuxSession, logFile, allowInput }));

  api.post('/sessions', express.json({ limit: '32kb' }), async (req, res) => {
    const blocked = sessionBlocked();
    if (blocked || !terminal) return void res.status(403).json({ error: blocked });
    if (!configEditor) return void res.status(403).json({ error: '설정을 수정할 수 없습니다' });
    const view = configEditor.view();
    if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '설정을 수정할 수 없습니다' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { tmuxSession, allowInput, gitUrl, cols, rows } = body;
    const agent = parseAgent(body.agent);
    // 세션 이름만 있어도 된다: 프로젝트 이름은 세션 이름, 경로는 홈 폴더
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : tmuxSession;
    const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim() ? body.repoPath : '~';
    if (agent === null) return void res.status(400).json({ error: '에이전트는 claude 또는 codex 만 고를 수 있습니다' });
    if (typeof name !== 'string' || typeof repoPath !== 'string' || typeof tmuxSession !== 'string' || !name.trim() || !repoPath.trim() || !tmuxSession.trim()) {
      return void res.status(400).json({ error: '세션 이름을 입력하세요' });
    }
    if (!SESSION_RE.test(tmuxSession)) return void res.status(400).json({ error: '세션 이름이 올바르지 않습니다' });
    const registered = (v: ConfigView) => v.projects.some((p) => p.tmuxSession === tmuxSession);
    if (registered(view)) return void res.status(409).json({ error: `세션 "${tmuxSession}" 은 이미 프로젝트로 등록되어 있습니다` });

    // 주소가 있으면 clone 부터. 주소 형식은 서버가 검증하고 명령은 고정이다 (git.ts).
    if (typeof gitUrl === 'string' && gitUrl.trim()) {
      const url = gitUrl.trim();
      if (!GIT_URL_RE.test(url)) return void res.status(400).json({ error: 'Git 저장소 주소는 https://, ssh://, git@host:path 형식만 받습니다' });
      const cloneError = await terminal.cloneRepo(url, repoPath.trim());
      if (cloneError) return void res.status(400).json({ error: `git clone 실패: ${cloneError}` });
    }
    // 세션을 먼저 만든다 (이름·디렉터리가 잘못되면 등록하지 않는다). 이미 있는 세션이면 그대로 등록만 한다.
    const error = await terminal.createSession(tmuxSession, repoPath.trim(), clampSize(cols, rows), agent);
    if (error) return void res.status(400).json({ error });
    // clone 하는 동안 설정이 바뀌었을 수 있으니 쓰기 직전에 다시 읽는다.
    const latest = configEditor.view();
    if (registered(latest)) return void res.status(409).json({ error: `세션 "${tmuxSession}" 은 이미 프로젝트로 등록되어 있습니다` });
    const next = await configEditor.update({
      version: latest.version,
      settings: latest.settings,
      projects: [...editableProjects(latest), { id: null, name: name.trim(), repoPath: repoPath.trim(), tmuxSession, logFile: null, allowInput: allowInput === true }],
    });
    await monitor.tick();
    res.json({ id: next.projects.find((p) => p.tmuxSession === tmuxSession)?.id });
  });

  // 프로젝트를 설정에서 지운다 (설정 화면의 삭제와 같다). tmux 세션은 건드리지 않으므로 돌고 있으면 미등록 세션으로 남는다
  api.delete('/projects/:id', async (req, res) => {
    if (!configEditor) return void res.status(403).json({ error: '설정을 수정할 수 없습니다' });
    const view = configEditor.view();
    if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '설정을 수정할 수 없습니다' });
    if (!view.projects.some((p) => p.id === req.params.id)) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    await configEditor.update({ version: view.version, settings: view.settings, projects: editableProjects(view).filter((p) => p.id !== req.params.id) });
    await monitor.tick();
    res.json({ ok: true });
  });

  // 설정에 없는 tmux 세션을 대시보드에서 숨긴다 (config 의 hiddenSessions). DELETE 는 되돌리기(실행 취소)다. 설정 화면에서 지워도 다시 보인다.
  api.all('/sessions/:name/hide', async (req, res, next) => {
    if (req.method !== 'POST' && req.method !== 'DELETE') return void next();
    if (!configEditor) return void res.status(403).json({ error: '설정을 수정할 수 없습니다' });
    const view = configEditor.view();
    if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '설정을 수정할 수 없습니다' });
    const name = req.params.name;
    if (!SESSION_RE.test(name)) return void res.status(400).json({ error: '세션 이름이 올바르지 않습니다' });
    if (view.projects.some((p) => p.tmuxSession === name)) return void res.status(409).json({ error: '등록된 프로젝트의 세션은 숨길 수 없습니다. 설정에서 프로젝트를 삭제하세요' });
    await configEditor.update({
      version: view.version,
      settings: { ...view.settings, hiddenSessions: req.method === 'DELETE' ? view.settings.hiddenSessions.filter((s) => s !== name) : [...new Set([...view.settings.hiddenSessions, name])] },
      projects: editableProjects(view),
    });
    await monitor.tick();
    res.json({ ok: true });
  });

  api.post('/projects/:id/ack-errors', (req, res) => {
    if (!monitor.ackErrors(req.params.id)) return void res.status(404).json({ error: '프로젝트를 찾을 수 없습니다' });
    res.json({ ok: true });
  });

  api.post('/session/reset', async (_req, res) => {
    await monitor.reset();
    res.json({ ok: true });
  });

  if (configEditor) {
    api.get('/config', (_req, res) => void res.json(configEditor.view()));
    // 본문을 읽는 유일한 경로. 편집 가능한 필드만 반영되며 명령 문자열은 받지 않는다 (configEdit.ts).
    api.put('/config', express.json({ limit: '256kb' }), async (req, res) => {
      const view = configEditor.view();
      if (!view.editable) return void res.status(403).json({ error: view.readOnlyReason ?? '수정할 수 없습니다' });
      res.json(await configEditor.update(req.body));
    });
  }

  api.post('/notify/test', async (_req, res) => {
    if (!testPush) return void res.status(403).json({ error: 'demo mode 에서는 알림을 보낼 수 없습니다' });
    const error = await testPush();
    if (error) return void res.status(400).json({ error });
    res.json({ ok: true });
  });

  api.use((_req, res) => void res.status(404).json({ error: '없는 API 입니다' }));
  // Express 는 인자 4개인 함수만 오류 핸들러로 인식한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  api.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConfigConflict) return void res.status(409).json({ error: err.message });
    if (err instanceof FileError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'config 가 올바르지 않습니다', issues: err.issues });
    // 잘못된 JSON 본문 등 클라이언트 오류는 그 상태 코드로 돌려준다.
    if (err.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  app.use('/api', api);
  return app;
}
