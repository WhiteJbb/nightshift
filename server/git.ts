import { realpathSync, statSync } from 'node:fs';
import { NOT_A_REPO } from '../shared/types.ts';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Commit, FileChange, FileStat, GitBaseline, GitInfo, SinceBaseline } from '../shared/types.ts';
import { run, runQueued } from './exec.ts';

// 기준점에 커밋이 없었을 때(빈 저장소) 비교 대상으로 쓰는 Git 의 빈 트리.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LOG_FORMAT = '--format=%H%x1f%an%x1f%cI%x1f%s';

const git = (repo: string, ...args: string[]) => runQueued('git', ['-C', repo, '-c', 'core.quotePath=false', ...args]);

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', date = '', subject = ''] = line.split('\x1f');
      return { hash, author, date, subject };
    });
}

/** `git status --porcelain -z` 출력. 이름 변경/복사는 "XY new\0old\0" 두 레코드로 온다. */
export function parseStatus(out: string): FileChange[] {
  const records = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.length <= 3) continue;
    const status = r.slice(0, 2);
    const file: FileChange = { status, path: r.slice(3) };
    if (/[RC]/.test(status)) file.from = records[++i] ?? '';
    files.push(file);
  }
  return files;
}

/** `git diff --numstat -z` 출력. 이름 변경은 "add\tdel\t\0old\0new\0" 로 온다. */
export function parseNumstat(out: string): FileStat[] {
  const records = out.split('\0');
  const files: FileStat[] = [];
  for (let i = 0; i < records.length; i++) {
    const [add, del, ...rest] = records[i]!.split('\t');
    if (add === undefined || del === undefined) continue;
    // 바이너리 파일은 "-\t-\tpath" → 0 으로 취급
    const stat = { additions: Number(add) || 0, deletions: Number(del) || 0 };
    const name = rest.join('\t');
    if (name) files.push({ path: name, ...stat });
    else {
      const from = records[++i] ?? '';
      files.push({ path: records[++i] ?? '', ...stat, from });
    }
  }
  return files;
}

const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_FILES = 500;

/** untracked 텍스트 파일의 줄 수를 additions 로 센다. 큰 파일·바이너리·읽을 수 없는 파일은 0. */
async function countLines(file: string): Promise<number> {
  let fh;
  try {
    // FIFO 같은 특수 파일은 open 에서 멈출 수 있으므로 열기 전에 거른다.
    const st = await lstat(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_UNTRACKED_BYTES) return 0;
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    if (size === 0 || size > MAX_UNTRACKED_BYTES) return 0;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    if (buf.subarray(0, 8192).includes(0)) return 0;
    let lines = 0;
    for (const byte of buf) if (byte === 10) lines++;
    return buf[size - 1] === 10 ? lines : lines + 1;
  } catch {
    return 0;
  } finally {
    await fh?.close();
  }
}

// ponytail: untracked 파일이 200개를 넘으면 나머지는 줄 수를 세지 않는다 (목록에는 나온다).
async function untrackedStats(repoPath: string, changed: FileChange[]): Promise<FileStat[]> {
  const untracked = changed.filter((f) => f.status === '??').slice(0, MAX_UNTRACKED_FILES);
  return Promise.all(untracked.map(async (f) => ({ path: f.path, additions: await countLines(path.join(repoPath, f.path)), deletions: 0, untracked: true })));
}

/**
 * 줄 수가 같은 수정이나 untracked 파일의 추가 수정도 활동으로 잡히도록
 * 변경 파일들의 크기·수정 시각을 지문에 넣는다.
 */
async function fingerprintOf(repoPath: string, head: string | null, branch: string, changed: FileChange[]): Promise<string> {
  const sigs = await Promise.all(
    changed.slice(0, MAX_FINGERPRINT_FILES).map(async (f) => {
      const st = await lstat(path.join(repoPath, f.path)).catch(() => null);
      return `${f.status}${f.path}:${st?.size ?? -1}:${st?.mtimeMs ?? 0}`;
    }),
  );
  return JSON.stringify([head, branch, changed.length, sigs]);
}

const sum = (files: FileStat[], key: 'additions' | 'deletions') => files.reduce((n, f) => n + f[key], 0);

function failed(error: string): GitInfo {
  return {
    ok: false,
    error,
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
}

/**
 * 홈 폴더 전체가 저장소(~/.git, 대개 실수로 만든 것)인 경우. 저장소로 치지 않는다: 홈 전체를 훑느라 git status 가 끝나지 않고
 * (macOS 는 보호된 폴더마다 경고를 낸다), 파일 탭이 홈의 모든 파일을 열게 된다.
 */
export function isHomeRoot(top: string): boolean {
  try {
    return top === realpathSync(homedir());
  } catch {
    return top === homedir();
  }
}

/** dir 이 든 저장소의 맨 위 폴더. 저장소가 아니거나 홈 폴더 전체가 저장소면 null */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(dir, 'rev-parse', '--show-toplevel');
  const top = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  return top && !isHomeRoot(top) ? top : null;
}

export async function collectGit(repoPath: string): Promise<GitInfo> {
  try {
    if (!statSync(repoPath).isDirectory()) return failed('저장소 경로가 디렉터리가 아닙니다');
  } catch {
    return failed('저장소 경로가 존재하지 않습니다');
  }
  const inside = await git(repoPath, 'rev-parse', '--is-inside-work-tree', '--show-toplevel');
  // macOS 는 launchd 로 띄운 서버가 다운로드·문서·데스크탑 폴더를 읽으려 하면 허락이 날 때까지 멈춰 세운다 (시간 초과로 끝난다)
  if (inside.timedOut) return failed('Git 이 응답하지 않습니다. macOS 가 이 폴더 접근을 막고 있을 수 있습니다 (다운로드·문서·데스크탑 등): 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한에 node 를 추가하세요');
  if (inside.code === null) return failed(`git 을 실행할 수 없습니다: ${inside.stderr.trim()}`);
  // 둘째 줄부터가 맨 위 폴더다 (폴더 이름에 줄바꿈이 있을 수 있다)
  const [isInside, ...rest] = inside.stdout.replace(/\n$/, '').split('\n');
  const top = rest.join('\n');
  if (inside.code !== 0 || isInside !== 'true' || isHomeRoot(top)) return failed(NOT_A_REPO);

  // 커밋이 하나도 없는 저장소에서는 HEAD 관련 명령이 실패한다 → 빈 값으로 취급.
  const [branch, head, status, numstat, recent, today] = await Promise.all([
    git(repoPath, 'branch', '--show-current'),
    git(repoPath, 'rev-parse', '--verify', '-q', 'HEAD'),
    git(repoPath, 'status', '--porcelain', '-z', '-uall'),
    git(repoPath, 'diff', '--numstat', '-z', 'HEAD'),
    git(repoPath, 'log', '-n', '10', LOG_FORMAT),
    git(repoPath, 'log', '--since=midnight', LOG_FORMAT),
  ]);
  // 시간 초과나 출력 상한 초과로 끊겼으면 stderr 는 원인이 아니라 그때까지 나온 경고들이다
  if (status.code === null) return failed('git status 가 끝나지 않았습니다 (시간 초과 또는 출력이 너무 큼): 추적하지 않는 파일이 지나치게 많은지 확인하세요');
  if (status.code !== 0) return failed(`git status 실패: ${status.stderr.trim()}`);
  // porcelain 의 경로는 저장소 최상위 기준이다. repoPath 가 하위 디렉터리(자동 발견 세션의 cwd 등)여도 파일을 제대로 찾게 한다.
  const root = top || repoPath;

  const headSha = head.code === 0 ? head.stdout.trim() : null;
  const changedFiles = parseStatus(status.stdout);
  const branchName = branch.stdout.trim() || (headSha ? `(detached ${headSha.slice(0, 7)})` : '(unknown)');
  const [untracked, fingerprint] = await Promise.all([untrackedStats(root, changedFiles), fingerprintOf(root, headSha, branchName, changedFiles)]);
  const diffStat = [...(numstat.code === 0 ? parseNumstat(numstat.stdout) : []), ...untracked];
  return {
    ok: true,
    branch: branchName,
    head: headSha,
    clean: changedFiles.length === 0,
    changedFiles,
    diffStat,
    additions: sum(diffStat, 'additions'),
    deletions: sum(diffStat, 'deletions'),
    recentCommits: recent.code === 0 ? parseLog(recent.stdout) : [],
    todayCommits: today.code === 0 ? parseLog(today.stdout) : [],
    fingerprint,
  };
}

/** 기준점 이후의 커밋과 변경(커밋되지 않은 working tree 변경, 현재 untracked 파일 포함). */
export async function collectSince(repoPath: string, baseline: GitBaseline, current?: GitInfo): Promise<SinceBaseline> {
  const range = baseline.head ? [`${baseline.head}..HEAD`] : [];
  const [log, numstat] = await Promise.all([
    git(repoPath, 'log', '-n', '200', LOG_FORMAT, ...range),
    git(repoPath, 'diff', '--numstat', '-z', baseline.head ?? EMPTY_TREE),
  ]);
  const files = [...(numstat.code === 0 ? parseNumstat(numstat.stdout) : []), ...(current?.diffStat.filter((f) => f.untracked) ?? [])];
  return {
    baseline,
    commits: log.code === 0 ? parseLog(log.stdout) : [],
    files,
    additions: sum(files, 'additions'),
    deletions: sum(files, 'deletions'),
  };
}

/** clone 을 허용하는 주소 형식: https://, ssh://, git@host:path. 로컬 경로나 ext:: 같은 전송은 받지 않는다. */
export const GIT_URL_RE = /^(https:\/\/[\w.-]+(:\d+)?\/[\w.~/-]+|ssh:\/\/[\w.-]+@?[\w.-]+(:\d+)?\/[\w.~/-]+|[\w.-]+@[\w.-]+:[\w.~/-]+)$/;

/** 주소의 마지막 경로 조각 (".git" 제거). 프로젝트 이름·폴더 이름 기본값으로 쓴다. */
export const repoNameFrom = (url: string): string => url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '';

/** dir 에 clone 한다. 셸 없이 argv 로 넘기고, 자격 증명 프롬프트는 뜨지 않게 해 두었다(exec.ts). 실패하면 git 의 오류 메시지. */
export async function cloneRepo(url: string, dir: string, timeoutMs: number): Promise<string | null> {
  const r = await run('git', ['clone', '--', url, dir], timeoutMs);
  // "Cloning into …" 진행 줄은 빼고 마지막 줄(원인)만 돌려준다.
  const last = r.stderr.trim().split('\n').filter((l) => l.trim() && !l.startsWith('Cloning into')).pop();
  return r.code === 0 ? null : r.timedOut ? 'git clone 시간 초과' : last?.trim() || 'git clone 실패';
}
