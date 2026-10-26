// UI → tmux 키 입력. allowInput 을 켠 프로젝트에만, loopback·Tailscale 바인딩일 때만 허용된다 (app.ts).
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { InputKey } from '../shared/types.ts';
import { sendKey, sendText } from './tmux.ts';

export const INPUT_KEYS = ['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'PPage', 'NPage', 'BSpace', 'C-c', 'C-d', 'C-u', 'C-l'] as const satisfies readonly InputKey[];
export const MAX_INPUT_CHARS = 20000;

export type ParsedInput = { pane: string } & ({ text: string; enter: boolean; now?: true } | { key: InputKey });

/** 신뢰할 수 없는 요청 본문을 검증한다. 문제가 있으면 오류 메시지(문자열). */
export function parseInput(body: unknown): ParsedInput | string {
  if (typeof body !== 'object' || body === null) return '요청 본문이 필요합니다';
  const { pane, text, enter, now, key } = body as Record<string, unknown>;
  if (typeof pane !== 'string' || !/^%\d+$/.test(pane)) return 'pane 이 올바르지 않습니다';
  if ((text === undefined) === (key === undefined)) return 'text 와 key 중 하나만 보내야 합니다';
  if (key !== undefined) {
    if (!(INPUT_KEYS as readonly unknown[]).includes(key)) return '허용되지 않은 키입니다';
    return { pane, key: key as InputKey };
  }
  if (typeof text !== 'string' || text === '') return 'text 는 비어 있지 않은 문자열이어야 합니다';
  if (text.length > MAX_INPUT_CHARS) return `text 는 ${MAX_INPUT_CHARS}자 이하여야 합니다`;
  if (text.includes('\0')) return 'text 에 NUL 문자를 넣을 수 없습니다';
  return { pane, text, enter: enter === true, ...(now === true && { now: true }) };
}

/** 글자를 넣고 Enter 를 누르기까지 쉬는 시간. Codex 는 글자 뒤 120ms 안의 Enter 를 붙여넣기의 줄바꿈으로 본다. */
export const ENTER_DELAY_MS = 200;

/** 입력을 tmux 로 보낸다. 실패하면 오류 메시지. */
export async function sendInput(input: ParsedInput): Promise<string | null> {
  if ('key' in input) return sendKey(input.pane, input.key);
  const error = await sendText(input.pane, input.text);
  if (error || !(input.enter || input.now)) return error;
  await sleep(ENTER_DELAY_MS);
  // Claude Code 의 send now(chat:sendNow). 일하는 중이면 대기열에서 기다리지 않고 바로 읽게 하고, 쉬는 중이면 Enter 처럼 보낸다
  return input.now ? sendKey(input.pane, 'C-x', 'C-s') : sendKey(input.pane, 'Enter');
}

/** 보낸 입력을 한 줄 JSON 으로 남긴다. 기록 실패가 입력을 막지는 않는다. */
/** 입력 기록이 이보다 커지면 .1 로 한 번 돌린다 (터미널에 치는 글이 모두 쌓이므로) */
export const INPUT_LOG_MAX_BYTES = 5 * 1024 * 1024;

// 파일마다 한 줄로 세운다: 동시에 들어온 입력이 함께 크기를 보고 둘 다 돌리려다 기록을 잃지 않게
const logQueue = new Map<string, Promise<void>>();

export function logInput(file: string, project: string, input: ParsedInput, maxBytes = INPUT_LOG_MAX_BYTES): Promise<void> {
  const next = (logQueue.get(file) ?? Promise.resolve()).then(() => writeLog(file, project, input, maxBytes));
  logQueue.set(file, next);
  return next;
}

async function writeLog(file: string, project: string, input: ParsedInput, maxBytes: number): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    if (((await stat(file).catch(() => null))?.size ?? 0) > maxBytes) await rename(file, `${file}.1`);
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), project, ...input })}\n`);
  } catch (e) {
    console.error(`입력 기록 실패: ${(e as Error).message}`);
  }
}
