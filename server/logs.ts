import { open, stat } from 'node:fs/promises';

// CSI, OSC, 기타 ESC 시퀀스와 탭·개행을 제외한 제어 문자.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

// eslint-disable-next-line no-control-regex
const SGR_RE = /^\x1b\[[0-9;:]*m$/;
/** 색상용 SGR 시퀀스만 남기고 나머지 제어 시퀀스를 제거한다. */
export const keepSgr = (s: string): string => s.replace(ANSI_RE, (m) => (SGR_RE.test(m) ? m : ''));

/**
 * 패턴 목록을 줄 판정 함수로 만든다. "/…/flags" 는 정규식, 그 외는 대소문자 무시 부분 일치.
 * 정규식이 잘못되면 throw (config 검증에서 잡는다).
 */
export function compileMatcher(patterns: string[]): (line: string) => boolean {
  const tests = patterns.map((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) {
      const re = new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''));
      return (line: string) => re.test(line);
    }
    const needle = p.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  });
  return (line) => tests.some((t) => t(line));
}

// 숫자(경과 시간·토큰 수), 점자 스피너, 흔한 스피너 글리프.
const VOLATILE_RE = /[\d\u2800-\u28ff✢✳✶✻✽✺·∗*|/\\—-]/g;
/** 스피너·카운터만 도는 화면을 "변화 없음"으로 보기 위한 비교용 정규화. */
export const stripVolatile = (s: string): string => s.replace(VOLATILE_RE, '');

const PROMPT_SCAN_LINES = 15;
// Claude Code 가 지난 대화를 올려 볼 때 화면 아래에 띄우는 버튼: "Jump to bottom (click) ↓", 그사이 새 글이 왔으면 "2 new messages ↓",
// 또는 "…: fn+↓ to scroll". 뒤에 붙는 ↓·"to scroll" 까지 맞춰, 답 본문의 같은 말과 구분한다
const SCROLL_HINT_RE = /(?:Jump to bottom|\b\d+ new messages?)(?:(?: \([^)]*\))? ↓|: .+ to scroll)/;
/** Claude Code 에서 지난 대화를 위로 올려 보는 중인지 */
export const scrolledUp = (lines: string[]): boolean => aboveInput(lines.filter((l) => l.trim() !== '')).slice(-3).some((l) => SCROLL_HINT_RE.test(l));
/** Claude Code 입력칸(맨 아래 가로줄 둘 사이)부터 아래를 뺀 화면. 가로줄이 둘 없으면 그대로. 입력칸 테두리는 첫 칸부터 그어진다(입력칸 안에 친 줄은 들여 써진다) */
export function aboveInput(lines: string[]): string[] {
  const rules = lines.flatMap((l, i) => (/^─{3,}\s*$/.test(l) ? [i] : []));
  return rules.length >= 2 ? lines.slice(0, rules.at(-2)) : lines;
}
// Claude Code 의 작업 중 스피너 줄 ("✢ Nesting… (2s · ↓ 55 tokens)"). 끝난 뒤의 "✻ Sautéed for 5s · done" 과 다르다
const SPINNER_RE = /^[·✢✳✶✻✽*∗] [^\s…]+…/;
// 권한 모드로 시작하는 Claude Code 하단 줄("⏵⏵ auto mode on …", "⏸ plan mode on …")이 구분점으로 끝남 = 들어가지 않는 항목을 뺐다
const FOOTER_CUT_RE = /^\s*(?:⏵⏵|⏸)\s.*\s·\s*$/;
// 턴은 끝났지만 스스로 이어서 일할 것을 기다리는 Claude Code 의 턴 끝 줄: 백그라운드 에이전트·워크플로
// ("✻ Waiting for 1 background agent to finish"), Monitor ("✻ Worked for 7s · done 1:50 AM · 1 shell, 1 monitor still running").
// 셸만 남은 것("1 shell still running")은 아니다: 개발 서버처럼 계속 떠 있을 수 있다
const WAITING_RE = /^✻ (?:(?:.* · )?Waiting for \d+ (?:background agents?|dynamic workflows?)\b|.* · (?:.*, )?\d+ monitors?\b)/;
/**
 * 턴은 끝났지만 백그라운드 에이전트·Monitor 를 기다리는 중인지 (끝나면 스스로 이어서 일한다).
 * 입력칸 바로 위의 마지막 대화 항목(첫 칸에서 시작하는 줄과 이어지는 들여 쓴 줄)이 그 턴 끝 줄일 때만 본다:
 * 다 끝난 뒤의 짧은 후속 답에는 턴 끝 줄이 새로 붙지 않아 옛 줄이 화면에 남는다. 지난 대화를 올려 보는 중이면 보지 않는다
 */
export function waitingOnBackground(lines: string[]): boolean {
  if (scrolledUp(lines)) return false;
  const above = aboveInput(lines.filter((l) => l.trim() !== ''));
  // 좁은 화면에선 턴 끝 줄이 다음 줄로 넘어가므로 항목을 이어 붙여 본다
  return WAITING_RE.test(above.slice(above.findLastIndex((l) => /^\S/.test(l))).map((l) => l.trim()).join(' '));
}
/**
 * 화면의 절대경로("/…/dir/이름/…", "'~/…/dir/이름'")에 나온 dir 바로 아래 이름들. 많이 나온 것부터, 같으면 나중에 나온 것부터.
 * 이름에 빈칸·괄호가 있어도 되게 "/"·따옴표로 끝난 것만 센다 ("…"로 잘린 경로는 빠진다)
 */
export function mentionedIn(lines: string[], dir: string, home: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tilde = dir.startsWith(`${home}/`) ? `|~${esc(dir.slice(home.length))}` : '';
  const re = new RegExp(`(?:${esc(dir)}${tilde})/([^/'"]+)[/'"]`, 'g');
  const seen = new Map<string, { n: number; at: number }>();
  let at = 0;
  for (const line of lines) for (const m of line.matchAll(re)) seen.set(m[1]!, { n: (seen.get(m[1]!)?.n ?? 0) + 1, at: at++ });
  return [...seen].sort(([, a], [, b]) => b.n - a.n || b.at - a.at).map(([name]) => name);
}
/**
 * 화면 마지막 몇 줄에 "작업 중" 표시(busyPatterns)가 있는지. 상태 줄은 맨 아래에 있으니 본문 인용에는 잘 걸리지 않는다.
 * changed: 지난번 본 뒤로 화면 글이 바뀌었는지 (표시가 통째로 빠진 좁은 화면에서만 쓴다)
 */
export function isBusy(lines: string[], patterns: string[], changed = false): boolean {
  if (!patterns.length) return false;
  const match = compileMatcher(patterns);
  // 좁은 화면(휴대폰)에선 상태 줄이 "esc to interrup…" 처럼 잘린다. 잘린 끝이 표시의 앞부분(3자 이상)이면 같은 것으로 본다
  const needles = patterns.filter((p) => !/^\/.+\/[a-z]*$/.test(p)).map((p) => p.toLowerCase());
  const cut = (line: string) => {
    const m = /^(.*?)\s*…\s*$/.exec(line.toLowerCase());
    return !!m && needles.some((n) => [...Array(n.length).keys()].some((k) => k >= 3 && m[1]!.endsWith(n.slice(0, k))));
  };
  const tail = lines.filter((l) => l.trim() !== '');
  if (tail.slice(-6).some((l) => match(l) || cut(l))) return true;
  // 휴대폰 폭(43칸)에선 Claude Code 하단 줄이 "esc to interrupt" 를 통째로 빼고 구분점만 남긴다 ("… (shift+tab to cycle) ·").
  // 빠진 게 다른 항목("1 feedback draft" 등)일 수도 있어, 스피너 줄이 보이거나(생각·도구 실행) 화면이 바뀔 때(답을 쓰는 중)만 일하는 것으로 본다
  if (!tail.slice(-3).some((l) => FOOTER_CUT_RE.test(l))) return false;
  // 스피너는 입력칸(치는 중인 글) 위에서만 찾는다
  return changed || aboveInput(tail).slice(-12).some((l) => SPINNER_RE.test(l.trim()));
}
const CHOICE_RE = /^[\s│┃║▌]*(?:[❯›>]\s*)?([1-9])[.)]\s+(.+?)[\s│┃║]*$/;
/** 프롬프트 줄부터 아래로 "1. Yes" 같은 번호 선택지를 모은다 (같은 번호는 처음 것만). */
export function promptChoices(lines: string[], prompt: string): { key: string; label: string }[] {
  const at = lines.map((l) => l.trim()).lastIndexOf(prompt);
  if (at < 0) return [];
  const seen = new Set<string>();
  const options: { key: string; label: string }[] = [];
  for (const line of lines.slice(at)) {
    const m = CHOICE_RE.exec(line);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      options.push({ key: m[1]!, label: m[2]! });
    }
  }
  return options;
}
// 줄 앞뒤의 공백·상자 테두리, 끝의 문장 부호
const EDGE_RE = /^[\s│┃║▌]+|[\s│┃║▌]+$/g;
const TAIL_PUNCT_RE = /[\s:?.!>]+$/;
/**
 * 화면 마지막 줄들에서 입력 대기 프롬프트를 찾는다. 없으면 null.
 * 글자 패턴은 줄 맨 앞("Do you want to …")이나 맨 끝("… (y/n)")에 있을 때만 맞는다:
 * 대화 본문 중간에 그 문구가 인용돼도 입력 대기로 보지 않는다. /정규식/ 은 그대로 쓴다.
 */
export function findPrompt(lines: string[], patterns: string[]): string | null {
  if (!patterns.length) return null;
  const tests = patterns.map((p) => {
    if (/^\/(.+)\/([a-z]*)$/.test(p)) return compileMatcher([p]);
    const needle = p.toLowerCase();
    return (line: string) => {
      const l = line.replace(EDGE_RE, '').toLowerCase();
      return l.startsWith(needle) || l.endsWith(needle) || l.replace(TAIL_PUNCT_RE, '').endsWith(needle.replace(TAIL_PUNCT_RE, ''));
    };
  });
  const recent = lines.filter((l) => l.trim() !== '').slice(-PROMPT_SCAN_LINES);
  return recent.find((l) => tests.some((t) => t(l)))?.trim() ?? null;
}

const TAIL_BYTES = 64 * 1024;
const MAX_MATCHES = 20;

/** 로그 파일에서 어디까지 확인했는지. ino 가 바뀌면 파일이 교체(rotate)된 것. */
export interface LogPos {
  offset: number;
  ino: number;
}

/**
 * 파일의 [pos.offset, 끝) 구간을 줄 단위로 읽는다 (최대 끝 64KB).
 * 파일이 교체됐거나 줄어들었으면 처음부터 읽는다. 일반 파일이 아니거나 없으면 빈 결과.
 */
export async function readFrom(file: string, pos: LogPos | null): Promise<{ lines: string[]; size: number; ino: number }> {
  let fh;
  try {
    // FIFO 같은 특수 파일은 open 에서 멈출 수 있으므로 열기 전에 거른다.
    if (!(await stat(file)).isFile()) return { lines: [], size: 0, ino: 0 };
    fh = await open(file, 'r');
    const { size, ino } = await fh.stat();
    if (pos === null) return { lines: [], size, ino };
    const from = pos.ino !== ino || pos.offset > size ? 0 : pos.offset;
    const start = Math.max(from, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return { lines: stripAnsi(buf.toString('utf8')).split('\n'), size, ino };
  } catch {
    return { lines: [], size: 0, ino: 0 };
  } finally {
    await fh?.close();
  }
}

export function findErrors(lines: string[], patterns: string[], ignore: string[] = []): string[] {
  if (!patterns.length) return [];
  const isError = compileMatcher(patterns);
  const isIgnored = compileMatcher(ignore);
  return lines.filter((line) => isError(line) && !isIgnored(line)).slice(-MAX_MATCHES);
}

export interface LogScan {
  errors: string[];
  /** 스캔 시점의 파일 끝. 다음 스캔의 시작점이나 "확인 처리"에 쓴다. */
  end: LogPos;
}

/**
 * pos 이후에 추가된 로그에서만 오류를 찾는다.
 * pos 가 null 이면(최초 관측) 기존 내용은 건너뛰고 현재 끝 위치만 돌려준다.
 */
export async function scanLog(file: string, patterns: string[], ignore: string[], pos: LogPos | null): Promise<LogScan> {
  const { lines, size, ino } = await readFrom(file, pos);
  return { errors: findErrors(lines, patterns, ignore), end: { offset: size, ino } };
}
