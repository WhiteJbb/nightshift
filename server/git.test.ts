import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './exec.ts';
import { run } from './exec.ts';
import { cloneRepo, collectGit, collectSince, GIT_URL_RE, parseNumstat, parseStatus, repoNameFrom } from './git.ts';

// 줄 세운 실행도 같은 가짜 run 으로 간다
vi.mock('./exec.ts', () => {
  const run = vi.fn();
  return { run, runQueued: (...args: unknown[]) => run(...args) };
});
const mockRun = vi.mocked(run);

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (code: number | null, stderr = ''): ExecResult => ({ code, stdout: '', stderr, timedOut: false });

/** git 하위 명령(인자 일부)으로 응답을 고르는 mock */
function respond(table: Record<string, ExecResult>) {
  mockRun.mockImplementation(async (_bin, args = []) => {
    const joined = args.join(' ');
    const key = Object.keys(table).find((k) => joined.includes(k));
    return key ? table[key]! : fail(128, 'unexpected');
  });
}

const REPO = process.cwd(); // 실제로 존재하는 디렉터리면 된다 (git 은 mock)
const LOG = 'abc1234\x1fKim\x1f2026-10-04T01:00:00+09:00\x1ffeat: add thing\ndef5678\x1fLee\x1f2026-10-03T23:00:00+09:00\x1ffix: bug\n';

beforeEach(() => mockRun.mockReset());

describe('parsers', () => {
  it('parses NUL-separated porcelain status including renames and odd names', () => {
    expect(parseStatus(' M src/a.ts\0?? new "file"\n.txt\0R  new.ts\0old.ts\0A  b.ts\0')).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new "file"\n.txt' },
      { status: 'R ', path: 'new.ts', from: 'old.ts' },
      { status: 'A ', path: 'b.ts' },
    ]);
  });

  it('parses NUL-separated numstat including binary files and renames', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\0-\t-\timg.png\x003\t1\t\0old.ts\0new.ts\0')).toEqual([
      { path: 'src/a.ts', additions: 10, deletions: 2 },
      { path: 'img.png', additions: 0, deletions: 0 },
      { path: 'new.ts', additions: 3, deletions: 1, from: 'old.ts' },
    ]);
  });
});

describe('collectGit', () => {
  it('reports a missing path without running git', async () => {
    const info = await collectGit('/definitely/not/here');
    expect(info).toMatchObject({ ok: false, error: '저장소 경로가 존재하지 않습니다' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('reports a non-git directory', async () => {
    respond({ 'rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') });
    expect(await collectGit(REPO)).toMatchObject({ ok: false, error: 'Git 저장소가 아닙니다' });
  });

  it('does not take a repository at the home folder (an accidental ~/.git) and never scans it', async () => {
    respond({ 'rev-parse --is-inside-work-tree': ok(`true\n${realpathSync(homedir())}\n`) });
    expect(await collectGit(REPO)).toMatchObject({ ok: false, error: 'Git 저장소가 아닙니다' });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('reports a cut-off git status by its cause, not by the warnings printed before it', async () => {
    respond({
      'rev-parse --is-inside-work-tree': ok('true\n'),
      'status --porcelain': fail(null, "warning: could not open directory 'Library/Mail/': Operation not permitted\n"),
    });
    const info = await collectGit(REPO);
    expect(info.error).toMatch(/끝나지 않았습니다/);
    expect(info.error).not.toMatch(/warning/);
  });

  it('collects branch, status, diff and commits', async () => {
    respond({
      'rev-parse --is-inside-work-tree': ok('true\n'),
      'branch --show-current': ok('feat/x\n'),
      'rev-parse --verify': ok('abc1234\n'),
      'status --porcelain': ok(' M src/a.ts\0?? b.ts\0'),
      'diff --numstat': ok('10\t2\tsrc/a.ts\0'),
      '--since=midnight': ok(LOG.split('\n')[0] + '\n'),
      'log -n 10': ok(LOG),
    });
    const info = await collectGit(REPO);
    expect(info).toMatchObject({ ok: true, branch: 'feat/x', head: 'abc1234', clean: false, additions: 10, deletions: 2 });
    expect(info.changedFiles).toHaveLength(2);
    expect(info.recentCommits).toHaveLength(2);
    expect(info.recentCommits[0]).toEqual({ hash: 'abc1234', author: 'Kim', date: '2026-10-04T01:00:00+09:00', subject: 'feat: add thing' });
    expect(info.todayCommits).toHaveLength(1);
    // 모든 호출이 셸 없이 argv 로, 저장소 경로를 -C 로 넘긴다
    for (const [bin, args] of mockRun.mock.calls) {
      expect(bin).toBe('git');
      expect(args.slice(0, 2)).toEqual(['-C', REPO]);
    }
  });

  it('handles a repository with no commits', async () => {
    respond({
      'rev-parse --is-inside-work-tree': ok('true\n'),
      'branch --show-current': ok('main\n'),
      'status --porcelain': ok('?? a.txt\0'),
    });
    const info = await collectGit(REPO);
    expect(info).toMatchObject({ ok: true, branch: 'main', head: null, clean: false, recentCommits: [], additions: 0 });
  });
});

describe('untracked files and fingerprint', () => {
  it('counts untracked lines and notices same-size edits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-git-'));
    try {
      await writeFile(path.join(dir, 'new.ts'), 'a\nb\nc\n');
      await writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 10]));
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      respond({
        'rev-parse --is-inside-work-tree': ok('true\n'),
        'branch --show-current': ok('main\n'),
        'rev-parse --verify': ok('abc1234\n'),
        'status --porcelain': ok('?? new.ts\0?? bin.dat\0?? gone.ts\0?? pipe\0'),
        'diff --numstat': ok(''),
      });
      const first = await collectGit(dir);
      expect(first.diffStat).toEqual([
        { path: 'new.ts', additions: 3, deletions: 0, untracked: true },
        { path: 'bin.dat', additions: 0, deletions: 0, untracked: true },
        { path: 'gone.ts', additions: 0, deletions: 0, untracked: true },
        { path: 'pipe', additions: 0, deletions: 0, untracked: true }, // FIFO 를 열다 멈추지 않는다
      ]);
      expect(first.additions).toBe(3);
      expect((await collectGit(dir)).fingerprint).toBe(first.fingerprint);

      // 줄 수는 같지만 내용이 바뀜 → 지문이 달라져야 한다
      await writeFile(path.join(dir, 'new.ts'), 'x\ny\nz\n');
      await utimes(path.join(dir, 'new.ts'), new Date(), new Date(Date.now() + 5000));
      const second = await collectGit(dir);
      expect(second.additions).toBe(3);
      expect(second.fingerprint).not.toBe(first.fingerprint);

      const since = await collectSince(dir, { at: '2026-10-04T00:00:00Z', branch: 'main', head: 'abc1234' }, second);
      expect(since.files.map((f) => f.path)).toContain('new.ts');
      expect(since.additions).toBe(3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('nested repoPath', () => {
  it('reads changed files relative to the worktree root', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nightshift-git-\nx'));
    try {
      await mkdir(path.join(dir, 'web'));
      await writeFile(path.join(dir, 'web', 'new.ts'), 'a\nb\n');
      respond({
        'rev-parse --is-inside-work-tree': ok(`true\n${dir}\n`),
        'branch --show-current': ok('main\n'),
        'rev-parse --verify': ok('abc1234\n'),
        'status --porcelain': ok('?? web/new.ts\0'),
        'diff --numstat': ok(''),
      });
      const info = await collectGit(path.join(dir, 'web'));
      expect(info.additions).toBe(2);
      expect(info.fingerprint).not.toContain(':-1:');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('collectSince', () => {
  it('diffs against the baseline head', async () => {
    respond({ 'base000..HEAD': ok(LOG), 'diff --numstat -z base000': ok('5\t1\ta.ts\x003\t0\tb.ts\0') });
    const since = await collectSince(REPO, { at: '2026-10-04T00:00:00Z', branch: 'main', head: 'base000' });
    expect(since.commits).toHaveLength(2);
    expect(since).toMatchObject({ additions: 8, deletions: 1 });
  });

  it('diffs against the empty tree when the baseline had no commits', async () => {
    respond({ 'log -n 200': ok(LOG), 'diff --numstat -z 4b825dc': ok('7\t0\ta.ts\0') });
    const since = await collectSince(REPO, { at: '2026-10-04T00:00:00Z', branch: 'main', head: null });
    expect(since).toMatchObject({ additions: 7, deletions: 0 });
    expect(since.commits).toHaveLength(2);
  });
});

describe('clone url', () => {
  it('accepts https, ssh and scp-style urls and nothing else', () => {
    for (const ok of ['https://github.com/me/app.git', 'https://gitlab.example.com:8443/g/sub/app', 'ssh://git@github.com/me/app.git', 'git@github.com:me/app.git']) expect(GIT_URL_RE.test(ok), ok).toBe(true);
    for (const bad of ['/Users/me/app', 'file:///tmp/x', 'ext::sh -c id', 'http://github.com/me/app', 'https://github.com/me/app;id', 'git@github.com:me/app git']) expect(GIT_URL_RE.test(bad), bad).toBe(false);
    expect(['https://github.com/me/app.git', 'git@github.com:me/app', 'https://x.y/a/b/'].map(repoNameFrom)).toEqual(['app', 'app', 'b']);
  });

  it('clones without a shell and reports git stderr or a timeout', async () => {
    mockRun.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', timedOut: false });
    expect(await cloneRepo('git@github.com:me/app.git', '/r/app', 5000)).toBeNull();
    expect(mockRun).toHaveBeenLastCalledWith('git', ['clone', '--', 'git@github.com:me/app.git', '/r/app'], 5000);
    mockRun.mockResolvedValueOnce({ code: 128, stdout: '', stderr: "Cloning into '/r/x'...\nfatal: repository 'x' not found\n", timedOut: false });
    expect(await cloneRepo('https://h/x', '/r/x', 5000)).toBe("fatal: repository 'x' not found");
    mockRun.mockResolvedValueOnce({ code: null, stdout: '', stderr: '', timedOut: true });
    expect(await cloneRepo('https://h/x', '/r/x', 5000)).toBe('git clone 시간 초과');
  });
});
