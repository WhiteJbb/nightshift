// child_process 를 쓰는 유일한 모듈. 다른 서버 코드는 반드시 여기를 거친다.
import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';

// ps: node 로 도는 에이전트(Codex)의 이름을 찾을 때 프로세스 목록만 읽는다
// lsof: 맥에서 에이전트가 돌리는 명령의 작업 폴더(cwd)만 읽는다 (리눅스는 /proc)
const ALLOWED_BINS = ['git', 'tmux', 'osascript', 'ps', 'lsof', 'ss'] as const;
export type Bin = (typeof ALLOWED_BINS)[number];

export interface ExecResult {
  /** 프로세스를 띄우지 못했거나 시그널로 죽었으면 null */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * git/tmux 를 셸 없이 실행한다 (execFile → 인자는 argv 로 그대로 전달, escaping 불필요).
 * 절대 throw 하지 않는다.
 */
export function run(bin: Bin, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!ALLOWED_BINS.includes(bin) || args.some((a) => a.includes('\0'))) {
      return resolve({ code: null, stdout: '', stderr: `허용되지 않은 명령: ${bin}`, timedOut: false });
    }
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        // 감시가 에이전트의 git 작업과 index.lock 을 다투지 않게 한다.
        // launchd 등 셸 밖에서 띄우면 LANG 이 없고, 그러면 tmux 가 출력의 탭을 '_' 로 바꿔 파싱이 깨진다.
        env: { LANG: 'en_US.UTF-8', ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        resolve({
          code: typeof err.code === 'number' ? err.code : null,
          stdout,
          stderr: stderr || err.message,
          timedOut: err.killed === true,
        });
      },
    );
  });
}

/**
 * 감시처럼 한꺼번에 많이 띄우는 명령은 몇 개씩만 띄운다. 프로세스를 띄우는 동안(맥에서 하나에 ~3ms) 메인 스레드가 멈춰서,
 * 저장소 10개의 git 을 한꺼번에 띄우면 그동안 터미널에 친 키가 수백 ms 밀린다. 키 입력(send-keys)은 이 줄을 서지 않는다
 */
const MAX_QUEUED = 4;
let queued = 0;
const waiting: (() => void)[] = [];
export async function runQueued(bin: Bin, args: string[], timeoutMs?: number): Promise<ExecResult> {
  // 끝난 쪽이 자리를 바로 넘겨준다 (그 사이 새로 온 것이 끼어들어 MAX_QUEUED 를 넘지 않게)
  if (queued >= MAX_QUEUED) await new Promise<void>((r) => waiting.push(r));
  else queued++;
  try {
    return await run(bin, args, timeoutMs);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else queued--;
  }
}

/**
 * macOS 알림. 문자열은 AppleScript 소스에 끼워 넣지 않고 argv 로 넘기므로 escaping 이 필요 없다.
 * macOS 가 아니면 아무것도 하지 않는다.
 */
export async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message], 5000);
}

export type ConfiguredExec = (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<ExecResult>;

const MAX_RUN_OUTPUT = 1024 * 1024;

/**
 * config 에 등록된 test/build 명령 전용. command 는 config 파일에서만 와야 한다
 * (호출부는 runner.ts 하나). 셸로 실행하고, 시간 초과나 취소(signal) 시 프로세스 그룹째 종료한다.
 */
export const runConfigured: ConfiguredExec = (command, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      return resolve({ code: null, stdout, stderr: `작업 디렉터리가 없습니다: ${cwd}`, timedOut });
    }
    let child;
    try {
      child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout, stderr: (e as Error).message, timedOut });
    }
    // 출력이 상한을 넘으면 마지막 부분만 남긴다.
    const keepTail = (s: string) => (s.length > MAX_RUN_OUTPUT ? s.slice(-MAX_RUN_OUTPUT) : s);
    child.stdout.on('data', (d: Buffer) => (stdout = keepTail(stdout + d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = keepTail(stderr + d.toString('utf8'))));
    const pid = child.pid;
    const killGroup = () => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        // 이미 종료됨
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    if (signal?.aborted) killGroup();
    signal?.addEventListener('abort', killGroup, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
