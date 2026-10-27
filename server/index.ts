import { existsSync, statSync, watchFile } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { cloneRepo } from './git.ts';
import express from 'express';
import { createApp, isTailscaleAddress } from './app.ts';
import { ConfigError, defaultConfigPath, expandPath, loadConfig, SESSION_RE } from './config.ts';
import { applyConfigUpdate, readConfigView, readOnlyView } from './configEdit.ts';
import { demoCollector, demoConfig, demoExec, seedDemoRuns } from './demo.ts';
import { notify } from './exec.ts';
import { logInput, sendInput } from './input.ts';
import { Monitor, realCollector } from './monitor.ts';
import { alertsFor, exportAlerts, gateAlerts, MAC_ALERT_STATES, restoreAlerts } from './notify.ts';
import type { Alert } from './notify.ts';
import { sendNtfy, withRetry } from './push.ts';
import { reloadConfig } from './reload.ts';
import { Runner } from './runner.ts';
import { loadState, saveState } from './state.ts';
import type { TermSize } from './tmux.ts';
import { hasSession, killPane, killSession, newSession, newWindow, resizeWindow, sendRaw, typeLine } from './tmux.ts';
import { TermStreams } from './termstream.ts';
import type { AgentKind, TermEvent } from '../shared/types.ts';
import { AGENT_COMMANDS } from '../shared/types.ts';
import { saveUpload } from './upload.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const dev = flag('--dev');
const demo = flag('--demo') || process.env.NIGHTSHIFT_DEMO === '1';
const configPath = path.resolve(option('--config') ?? process.env.NIGHTSHIFT_CONFIG ?? defaultConfigPath('config'));

// 예상하지 못한 비동기 오류 하나로 관제 서버가 죽지 않게 한다.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

async function main() {
  const loaded = loadConfig(configPath, ROOT);
  const missing = loaded.missing;
  const config = demo ? demoConfig(loaded.config) : loaded.config;

  const runner = new Runner({
    timeoutSec: config.commandTimeoutSec,
    logDir: demo ? null : path.join(ROOT, '.nightshift/runs'),
    ...(demo ? { exec: demoExec } : {}),
  });
  if (demo) seedDemoRuns(runner);

  // demo 는 저장하지 않는다. --fresh 는 저장된 세션을 무시하고 새로 시작한다.
  const stateFile = demo ? null : path.join(ROOT, '.nightshift/state.json');
  const saved = stateFile && !flag('--fresh') ? loadState(stateFile) : null;
  if (saved) runner.restore(saved.runner);

  const monitor = new Monitor({
    config,
    collector: demo ? demoCollector() : realCollector(config),
    runs: runner.peek,
    history: runner.history,
    demo,
    configPath,
    configMissing: missing && !demo,
    restore: saved?.monitor ?? null,
  });
  runner.onChange = () => monitor.publish();

  // 휴대폰에서 눌러 열 수 있는 주소. loopback 은 휴대폰에서 닿지 않으므로 붙이지 않는다.
  const reachable = !['127.0.0.1', 'localhost', '::1'].includes(config.host);
  const hostForUrl = config.host.includes(':') ? `[${config.host}]` : config.host;
  // tailscale serve 로 https 를 열어 두었으면(allowedHosts 의 *.ts.net) 알림도 그 주소로 연다: 클립보드 등 보안 출처 기능이 된다
  const httpsName = config.allowedHosts.find((h) => h.endsWith('.ts.net'));
  const clickFor = (projectId?: string) =>
    reachable || httpsName ? { click: `${httpsName ? `https://${httpsName}` : `http://${hostForUrl}:${config.port}`}/${projectId ? `#/project/${encodeURIComponent(projectId)}` : ''}` } : {};
  const testPush = async () => {
    const url = monitor.config.ntfyUrl;
    if (!url) return 'ntfy 주소가 설정되어 있지 않습니다. 먼저 저장하세요.';
    return sendNtfy(url, { title: 'NightShift 시험 알림', message: '이 알림이 보이면 휴대폰 푸시가 연결된 것입니다.', ...clickFor() });
  };

  const streams = new TermStreams();
  const deferred = new Map<string, { alert: Alert; at: number }>((saved?.deferred ?? []).map((d) => [d.alert.projectId, d]));
  // 재시작해도 이미 보낸 알림을 다시 보내지 않게 저장해 둔 기억에서 시작한다
  const alertMemory = restoreAlerts(saved?.alerts);

  if (!demo) {
    // 상태 변화 알림. 실패해도 감시는 계속된다.
    monitor.subscribe((snapshot) => {
      const alerts = alertsFor(alertMemory, snapshot);
      const watched = (projectId: string) => {
        const session = snapshot.projects.find((p) => p.id === projectId)?.tmuxSession;
        return session !== undefined && session !== null && streams.watching(session);
      };
      const stateNow = (projectId: string) => {
        const p = snapshot.projects.find((x) => x.id === projectId);
        return p && (p.tmux.exists && p.tmux.waitingPrompt ? 'waiting' : p.status.state);
      };
      for (const a of gateAlerts(deferred, alerts, Date.now(), watched, stateNow)) {
        if (monitor.config.notifications && MAC_ALERT_STATES.includes(a.state)) void notify(a.title, a.message);
        const { ntfyUrl, ntfyStates } = monitor.config;
        if (ntfyUrl && ntfyStates.includes(a.state)) {
          // 일시적인 실패(네트워크, 429)는 잠시 뒤 다시 보낸다. 알림 판단(alertsFor)은 이미 보낸 것으로 기억한다.
          const msg = { title: a.title, message: a.message, state: a.state, ...clickFor(a.projectId) };
          void withRetry(() => sendNtfy(ntfyUrl, msg)).then((error) => error && console.error(`${error} (${a.title})`));
        }
      }
    });

    // 에디터의 원자적 저장(rename)에도 안전하도록 polling 방식으로 감시한다.
    watchFile(configPath, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) void reloadConfig({ configPath, baseDir: ROOT, monitor, runner, collectorFor: realCollector });
    });
  }

  if (stateFile) {
    let last = '';
    monitor.subscribe(() => {
      const state = { version: 2 as const, monitor: monitor.exportState(), runner: runner.exportState(), alerts: exportAlerts(alertMemory), deferred: [...deferred.values()] };
      const json = JSON.stringify(state);
      if (json === last) return;
      try {
        saveState(stateFile, state);
        last = json; // 실패하면 다음 스냅샷에서 다시 시도한다
      } catch (e) {
        console.error(`상태 저장 실패: ${(e as Error).message}`);
      }
    });
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      runner.cancelAll();
      process.exit(0);
    });
  }
  await monitor.tick();
  monitor.start();

  const configEditor = demo
    ? { view: () => readOnlyView(monitor.config, configPath, 'demo mode 에서는 설정을 수정할 수 없습니다.'), update: async () => readOnlyView(monitor.config, configPath, '') }
    : {
        view: () => readConfigView(configPath, ROOT),
        update: async (body: unknown) => {
          applyConfigUpdate(configPath, ROOT, body);
          // 파일 감시를 기다리지 않고 바로 적용한다 (감시가 뒤이어 한 번 더 읽어도 무해하다).
          await reloadConfig({ configPath, baseDir: ROOT, monitor, runner, collectorFor: realCollector });
          return readConfigView(configPath, ROOT);
        },
      };
  const inputLog = path.join(ROOT, '.nightshift/input.log');
  const createSession = async (name: string, repoPath: string, size: TermSize, agent?: AgentKind): Promise<string | null> => {
    if (!SESSION_RE.test(name)) return '세션 이름이 올바르지 않습니다';
    const cwd = expandPath(repoPath, ROOT);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return `디렉터리가 없습니다: ${cwd}`;
    const existed = await hasSession(name);
    const error = await newSession(name, cwd, size);
    // 에이전트는 새로 만든 세션에만 띄운다 (이미 있던 세션에 글자를 치지 않는다)
    if (error || !agent || existed) return error;
    return typeLine(`=${name}:`, AGENT_COMMANDS[agent]);
  };
  // 저장소 폴더가 없어지면 tmux 는 조용히 홈 폴더에서 연다. 엉뚱한 곳에서 명령이 돌지 않게 미리 막는다
  const openWindow = async (session: string, repoPath: string, agent?: AgentKind) => {
    const cwd = expandPath(repoPath, ROOT);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return { error: `디렉터리가 없습니다: ${cwd}` };
    const r = await newWindow(session, cwd);
    if ('error' in r || !agent) return r;
    const error = await typeLine(r.pane, AGENT_COMMANDS[agent]);
    return error ? { error } : r;
  };
  const cloneRepoTo = async (url: string, repoPath: string): Promise<string | null> => {
    const dir = expandPath(repoPath, ROOT);
    if (statSync(path.join(dir, '.git'), { throwIfNoEntry: false })) return null; // 이미 저장소
    // clone 도 등록된 명령과 같은 시간 제한을 쓴다 (hot reload 를 따라가게 매번 읽는다)
    return cloneRepo(url, dir, monitor.config.commandTimeoutSec * 1000);
  };
const terminal = demo ? undefined : { send: sendInput, sendRaw: (pane: string, bytes: Uint8Array) => streams.sendRaw(pane, bytes) ?? sendRaw(pane, bytes), stream: (session: string, pane: string, sink: (e: TermEvent) => void) => streams.subscribe(session, pane, sink), log: (id: string, input: Parameters<typeof sendInput>[0]) => void logInput(inputLog, id, input), createSession, killSession, newWindow: openWindow, killPane, cloneRepo: cloneRepoTo, resize: resizeWindow, saveUpload: (id: string, ext: string, data: Buffer) => saveUpload(path.join(ROOT, '.nightshift/uploads'), id, ext, data) };
  const app = createApp({ config, monitor, runner, configEditor, ...(terminal ? { terminal } : {}), ...(demo ? {} : { testPush }) });
  const server = http.createServer(app);

  if (dev) {
    const { createServer } = await import('vite');
    // Vite 개발 서버는 낯선 Host 헤더를 스스로 차단한다. Host 검사는 guard 가 이미 하므로 같은 기준을 넘겨준다:
    // loopback 이면 *.ts.net·allowedHosts, Tailscale 이면 그 주소도, 그 밖의 주소면 모든 이름을 받는다.
    const allowedHosts = ['127.0.0.1', 'localhost', '::1'].includes(config.host) ? ['.ts.net', ...config.allowedHosts] : isTailscaleAddress(config.host) ? [config.host, '.ts.net', ...config.allowedHosts] : true;
    const vite = await createServer({ server: { middlewareMode: true, hmr: { server }, allowedHosts }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'dist/web');
    if (!existsSync(path.join(dist, 'index.html'))) {
      console.error('dist/web 이 없습니다. 먼저 `npm run build` 를 실행하거나 `npm run dev` 를 사용하세요.');
      process.exit(1);
    }
    app.use(express.static(dist));
  }

  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `포트 ${config.port} 가 이미 사용 중입니다. config 의 port 를 바꾸세요.` : e);
    process.exit(1);
  });
  // Tailscale 주소에 바인딩하고 https 이름(allowedHosts 의 *.ts.net)을 적었으면 127.0.0.1 에서도 받는다:
  // 맥용 Tailscale 앱의 serve 는 로컬 주소로만 중계할 수 있다 (tailscale serve --https=443 http://127.0.0.1:포트)
  if (isTailscaleAddress(config.host) && httpsName) {
    http
      .createServer(app)
      .on('error', (e) => console.error(`127.0.0.1:${config.port} 에서 받지 못했습니다 (https 중계용): ${e.message}`))
      .listen(config.port, '127.0.0.1', () => console.log(`https 중계용: http://127.0.0.1:${config.port} → https://${httpsName}`));
  }
  server.listen(config.port, config.host, () => {
    console.log(`NightShift${demo ? ' (demo)' : ''}: http://${config.host}:${config.port}`);
    if (missing && !demo) console.log(`config 파일이 없습니다: ${configPath}\n  config/nightshift.example.json 을 복사해 프로젝트를 등록하세요.`);
    else if (!demo) console.log(`프로젝트 ${config.projects.length}개 감시 중 (${config.refreshIntervalSec}초 주기)${saved ? `, ${saved.monitor.startedAt} 에 시작한 세션을 이어 갑니다 (새로 시작: --fresh)` : ''}`);
    if (config.projects.some((p) => p.allowInput)) console.log(`터미널 입력 허용: ${config.projects.filter((p) => p.allowInput).map((p) => p.name).join(', ')} (기록: .nightshift/input.log)`);
    if (config.allowedHosts.length) console.log(`추가로 허용한 Host: ${config.allowedHosts.join(', ')}`);
    if (isTailscaleAddress(config.host)) console.log('Tailscale 주소에 바인딩했습니다. tailnet 의 기기에서 접근할 수 있습니다.');
    else if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.warn('경고: loopback 이 아닌 주소에 바인딩했습니다. 네트워크의 누구나 접근할 수 있고, 터미널 입력은 거부됩니다.');
  });
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
