import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TermEvent } from '../../shared/types.ts';
import { api, DOWN_GRACE_MS, errorMessage } from './api.ts';
import { charWidth, fontRange, ROW_RATIO, termHeight } from './termsize.ts';

/** 'connecting' | 'live' | 'down' | 'exit' 또는 서버가 보낸 오류 메시지 */
export type TermStatus = string;

export const TERM_FONT = "'JetBrains Mono Variable', 'Term Hangul', ui-monospace, 'SF Mono', Menlo, monospace";
export const TERM_FONT_SIZE = 13;
/** 한 요청에 넣는 raw 바이트 상한 (서버의 MAX_RAW_BYTES 와 같다) */
const RAW_CHUNK = 4096;

// SGR 마우스 보고 중 버튼 없는 이동: 코드의 하위 2비트가 3(버튼 없음)이고 32(이동) 비트가 켜진 것
// eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
const MOTION_RE = /\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+[Mm]/g;
// 오른쪽 버튼 누름·뗌 보고: 우클릭은 붙여넣기로 쓰므로 프로그램에 보내지 않는다 (https 일 때)
// eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
const RIGHT_BUTTON_RE = /\x1b\[<(?:2|6|10|14|18|22|26|30);\d+;\d+[Mm]/g;
const LINE_HEIGHT = 1.2;
/** 휠을 이만큼(px) 굴릴 때마다 PgUp/PgDn 한 번 */
const WHEEL_PAGE_PX = 120;
/** 터치로 한 줄 높이를 쓸 때 보내는 휠 횟수 (마우스를 받는 프로그램). 느리면 올린다 */
const TOUCH_SPEED = 1.5;
/** 손을 뗄 때 이보다 빠르면(px/ms) 관성으로 더 미끄러진다. 1ms 마다 빠르기에 FLING_DECAY 를 곱하고 FLING_STOP 아래에서 멈춘다 */
const FLING_MIN = 0.3;
const FLING_DECAY = 0.996;
const FLING_STOP = 0.03;
/** 터치로 이만큼(ms) 움직이지 않고 누르고 있으면 글자 고르기 */
const LONG_PRESS_MS = 500;
/** 한글 조합 중에 누른 Ctrl+글자: 조합이 이만큼(ms) 안에 끝나지 않으면 혼자 보낸다 */
const IME_CTRL_MS = 100;
/**
 * 클립보드에 쓴다. 이 서버는 보통 http(비보안 출처)로 열려 navigator.clipboard 가 없으니
 * 숨긴 입력칸을 골라 execCommand('copy') 로 쓴다 (클릭 직후라 브라우저가 허용한다).
 */
export function copyText(text: string): boolean {
  if (window.isSecureContext && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  return copyNow(text);
}
/** 숨긴 입력칸을 골라 execCommand('copy') 로 바로 쓴다. 키·클릭 직후에만 되고, 됐는지 바로 안다 */
function copyNow(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus();
  return ok;
}
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
/** 보는 컴퓨터가 맥(아이패드 포함)인가. 키는 서버가 아니라 이 브라우저의 OS 를 따른다 (xterm 처럼 navigator.platform 으로 본다) */
const isApple = () => /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform);

/** pane 의 출력 이벤트를 받는 곳. on 은 이벤트마다, down 은 연결이 끊길 때 불린다. 돌려주는 함수로 그만 받는다 */
/** 터미널에 있는 글 (일반 화면이면 스크롤백까지). 폭이 넘쳐 꺾인 줄은 다시 한 줄로 잇는다 */
export function bufferText(term: Terminal): string {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    // 다음 줄로 이어지는 줄 끝의 빈칸은 글의 일부다. 다만 두 칸 글자(한글)가 안 들어가 비워 둔 마지막 칸은 아니다
    const next = b.getLine(i + 1);
    const joins = next?.isWrapped === true;
    const last = line.getCell(line.length - 1);
    const pad = joins && last?.getWidth() === 1 && last.getChars() === '' && next.getCell(0)?.getWidth() === 2;
    const s = line.translateToString(!joins, 0, pad ? line.length - 1 : undefined);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += s;
    else lines.push(s);
  }
  return lines.join('\n').trimEnd();
}

export type TermFeed = (pane: string, on: (e: TermEvent) => void, down: () => void) => () => void;
/** 기본: pane 하나에 SSE 하나 */
const paneFeed =
  (projectId: string): TermFeed =>
  (pane, on, down) => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/term/${encodeURIComponent(pane)}`);
    es.onmessage = (ev: MessageEvent<string>) => on(JSON.parse(ev.data) as TermEvent);
    es.onerror = down;
    return () => es.close();
  };
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/**
 * pane 하나를 실제 터미널(xterm.js)로 그린다. 서버의 SSE 스트림(첫 화면 + 이어지는 바이트)을 그대로 쓰고,
 * 입력이 허용된 프로젝트면 키·마우스 보고 바이트를 pane 으로 돌려보낸다. 크기는 tmux pane 을 따른다.
 */
/**
 * focus: 첫 화면을 받으면 키 입력을 받게 한다 (나란히 보기에서는 고른 칸만). heightShare: 쓸 수 있는 높이 중 이 터미널의 몫.
 * feed: 출력을 받는 곳 (나란히 보기는 여러 pane 이 연결 하나를 나눠 쓴다). 없으면 pane 마다 SSE 를 연다.
 * command: pane 에서 도는 프로그램 (TmuxPane.command). 휠을 어떻게 보낼지 고른다
 */
export function Term({ projectId, pane, canInput, command, full = false, focus = true, heightShare = 1, feed, onPick, onStatus, onSize, onNotice }: { projectId: string; pane: string; canInput: boolean; command?: string; full?: boolean; focus?: boolean; heightShare?: number; feed?: TermFeed; /** 꾹 누르면 그때의 터미널 글과 칸 수를 넘긴다 (휴대폰 글자 고르기) */ onPick?: (text: string, cols: number) => void; onStatus: (s: TermStatus) => void; onSize: (cols: number, rows: number) => void; onNotice?: (msg: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  // 콜백이 바뀌어도 터미널을 다시 만들지 않는다
  const cb = useRef({ onStatus, onSize, onNotice, onPick });
  cb.current = { onStatus, onSize, onNotice, onPick };
  // 전체 화면 여부는 글자 크기 계산에만 쓴다. 바뀌어도 터미널을 다시 만들지 않는다
  const fullRef = useRef(full);
  fullRef.current = full;
  const layout = useRef({ focus, heightShare });
  layout.current = { focus, heightShare };
  // Codex 는 tmux 의 mouse 옵션이 꺼져 있으면 마우스를 켜지 않지만, 휠 보고를 받으면 대화를 한 줄씩 움직인다
  const wheelReports = useRef(false);
  wheelReports.current = command === 'codex';
  const xterm = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const mac = isApple();
    const term = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      fontFamily: TERM_FONT,
      fontSize: TERM_FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      disableStdin: !canInput,
      cursorBlink: canInput,
      // Option+←/→/Backspace 를 터미널처럼 단어 이동·삭제(Meta)로 쓴다
      macOptionIsMeta: true,
      // 프로그램이 마우스를 받을 때(Claude Code)도 Option+끌기로 터미널 글자를 직접 고른다 (Cmd+C 로 복사). Windows·Linux 는 xterm 이 Shift+끌기로 한다
      macOptionClickForcesSelection: true,
      theme: { background: '#05070c', foreground: '#e8ebf2', cursor: '#e8ebf2', selectionBackground: 'rgba(255, 255, 255, 0.25)' },
    });
    term.open(el);
    xterm.current = term;
    // 출력의 http(s) 주소를 눌러 새 탭으로 연다 (PR 링크 등). 프로그램이 마우스를 받으면 Cmd(⌘)+클릭
    term.loadAddon(new WebLinksAddon((_ev, uri) => void window.open(uri, '_blank', 'noopener,noreferrer')));

    // 프로그램이 클립보드에 넣으라고 보내는 OSC 52 (Claude Code 에서 끌어 고르면 이걸로 복사한다)
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (!b64 || b64 === '?') return true;
      try {
        const ok = copyText(new TextDecoder().decode(decode(b64)));
        cb.current.onNotice?.(ok ? '복사됨' : `복사하지 못했습니다 (${mac ? 'Option+끌기로 고른 뒤 Cmd+C' : 'Shift+끌기로 고른 뒤 Ctrl+Shift+C'})`);
      } catch {
        // 깨진 base64 는 무시한다
      }
      return true;
    });

    // pane 이 영역보다 넓거나 화면보다 높으면 글자를 줄이고, 작으면 키운다 (범위는 fontRange).
    // 터미널 전체가 한 화면에 들어와야 그 위에서 쓸기를 프로그램 스크롤로 쓸 수 있다
    const fitFont = () => {
      const width = el.clientWidth;
      if (!width) return;
      const perPx = charWidth(`${TERM_FONT_SIZE}px ${TERM_FONT}`) / TERM_FONT_SIZE;
      const byWidth = Math.floor(width / (term.cols * perPx));
      const byHeight = Math.floor(termHeight(fullRef.current, layout.current.heightShare) / (term.rows * ROW_RATIO));
      const [min, max] = fontRange();
      term.options.fontSize = Math.max(min, Math.min(max, byWidth, byHeight));
    };

    let stopFeed = () => {};
    // 잠깐 끊겼다 곧 다시 붙으면(첫 화면이 다시 온다) 알리지 않는다. 그동안 다시 붙지 못할 때만 끊김을 띄운다
    let downTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(downTimer);
      downTimer = undefined;
    };
    const onEvent = (e: TermEvent) => {
      settle();
      if (e.type === 'init') {
        // 다시 연결될 때마다 첫 화면이 다시 오므로 깨끗이 지우고 그린다
        term.reset();
        term.resize(e.cols, e.rows);
        fitFont();
        term.write(decode(e.data));
        cb.current.onStatus('live');
        cb.current.onSize(e.cols, e.rows);
        // 컴퓨터에선 열자마자 키를 칠 수 있게 (휴대폰은 화면 키보드가 튀어나오므로 두지 않는다)
        if (canInput && layout.current.focus && window.matchMedia?.('(pointer: fine)').matches) term.focus();
      } else if (e.type === 'out') term.write(decode(e.data));
      else if (e.type === 'resize') {
        term.resize(e.cols, e.rows);
        fitFont();
        cb.current.onSize(e.cols, e.rows);
      } else {
        // 오류·종료 뒤에는 서버가 더 보내지 않는다. 재연결은 탭을 다시 열 때
        cb.current.onStatus(e.type === 'exit' ? 'exit' : e.message);
        stopFeed();
      }
    };
    stopFeed = (feed ?? paneFeed(projectId))(pane, onEvent, () => void (downTimer ??= setTimeout(() => cb.current.onStatus('down'), DOWN_GRACE_MS)));

    // 키·마우스 보고는 묶어서 한 번에 하나씩 보낸다. 보내는 동안 모인 것은 다음 요청에 합친다
    const pasteOnRightClick = window.isSecureContext && typeof navigator.clipboard?.readText === 'function';
    const enc = new TextEncoder();
    let queue = '';
    let sending = false;
    let closed = false; // 탭·pane 을 바꾼 뒤에는 남은 입력을 이전 pane 으로 보내지 않는다
    let failures = 0;
    const flush = async () => {
      if (closed || sending || queue === '') return;
      sending = true;
      const bytes = enc.encode(queue);
      queue = '';
      try {
        for (let i = 0; i < bytes.length && !closed; i += RAW_CHUNK) await api.sendRaw(projectId, { pane, data: encode(bytes.subarray(i, i + RAW_CHUNK)) });
      } catch (e) {
        // 일부가 갔을 수도 있다. 뒤에 쌓인 입력(Enter 등)까지 이어 보내면 반쪽 명령이 실행될 수 있으니 버리고 알린다
        // (붙여넣는 중에 모아 둔 키도 버린다)
        queue = '';
        failures++;
        cb.current.onNotice?.(`입력을 보내지 못했습니다 (${errorMessage(e)}). 화면을 확인한 뒤 다시 입력하세요`);
        sending = false;
        return;
      }
      sending = false;
      void flush();
    };
    // 이미지를 붙여넣는 동안(클립보드 읽기·올리기) 친 키는 모아 두었다가 그 결과 뒤에 보낸다. 순서가 바뀌면 Enter 가 먼저 갈 수 있다
    let held: string | null = null;
    const send = (d: string) => {
      if (held !== null) held += d;
      else {
        queue += d;
        void flush();
      }
    };
    const holdUntil = (work: Promise<string>) => {
      held = '';
      const before = failures;
      void work.then((text) => {
        if (failures === before) queue += text + (held ?? '');
        held = null;
        void flush();
      });
    };
    // 한글 조합 중에 누른 Ctrl+글자의 제어 문자 (아래 키 처리). 조합이 끝나 xterm 이 확정된 글을 보낸 바로 뒤에 보낸다
    let afterCompose: string | null = null;
    let afterComposeTimer: ReturnType<typeof setTimeout> | undefined;
    // 조합이 끝나(compositionend) xterm 이 확정된 글을 보내기 전까지 (xterm 은 textarea 에서 읽어 setTimeout 0 뒤에 보낸다)
    let delivering = false;
    const sendAfterCompose = () => {
      clearTimeout(afterComposeTimer);
      if (afterCompose !== null) send(afterCompose);
      afterCompose = null;
    };
    const onCompositionEnd = () => {
      delivering = true;
      const before = failures;
      // xterm 보다 나중에 등록한 리스너라 이 타이머는 xterm 이 글을 보낸 뒤에 돈다.
      // ponytail: 그 사이(같은 몇 ms)에 다음 키를 누르면 그 키가 먼저 간다. 사람이 누르는 빠르기로는 생기지 않는다
      setTimeout(() => {
        delivering = false;
        // 확정된 글을 보내지 못했으면 버린다 (Ctrl+D 따위가 앞 글 없이 가지 않게)
        if (failures !== before) afterCompose = null;
        sendAfterCompose();
      }, 0);
    };
    term.textarea?.addEventListener('compositionend', onCompositionEnd);
    const input = term.onData((d) => {
      if (!canInput) return; // disableStdin 이면 오지 않지만, 보기 전용 프로젝트의 바이트는 어떤 경우에도 보내지 않는다
      // 버튼을 누르지 않은 채 움직인 보고(SGR 버튼 코드 35·51·67…)는 버린다. 마우스를 스칠 때마다 요청이 나가지 않게
      d = d.replace(MOTION_RE, '');
      if (pasteOnRightClick) d = d.replace(RIGHT_BUTTON_RE, '');
      if (d === '') return;
      send(d);
    });

    // 이미지 붙여넣기: 파일로 올리고 그 경로를 붙여넣는다. 터미널에 파일을 끌어다 놓은 것과 같아서 Claude Code 가 [Image #1] 첨부로 바꾼다
    // 돌려주는 것은 보낼 글 (실패하면 빈 글)
    const uploadImage = (file: Blob) =>
      new Promise<string>((resolve) => {
        cb.current.onNotice?.('이미지 올리는 중…');
        const reader = new FileReader();
        reader.onload = () => {
          api.upload(projectId, { type: file.type, data: String(reader.result).split(',')[1] ?? '' }).then(
            ({ path }) => {
              cb.current.onNotice?.('이미지 경로를 넣었습니다');
              // 뒤의 공백은 셸에서 경로 여러 개가 붙지 않게. 붙여넣기 안에 넣어야 Claude Code 첨부 앞에 공백이 끼지 않는다
              resolve(term.modes.bracketedPasteMode ? `\x1b[200~${path} \x1b[201~` : `${path} `);
            },
            (err: unknown) => {
              cb.current.onNotice?.(`이미지 올리기 실패: ${errorMessage(err)}`);
              resolve('');
            },
          );
        };
        reader.onerror = () => {
          cb.current.onNotice?.('이미지를 읽지 못했습니다');
          resolve('');
        };
        reader.readAsDataURL(file);
      });
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
      if (!file || !canInput) return;
      e.preventDefault();
      e.stopPropagation();
      if (held === null) holdUntil(uploadImage(file));
    };
    // Ctrl+V 는 Claude Code 의 이미지 붙여넣기 키인데, 클립보드는 서버가 아니라 이 브라우저 쪽에 있다.
    // 여기서 읽어 이미지가 있으면 올리고, 없거나 읽지 못하면(http, 권한 거부) 원래대로 ^V 를 보낸다
    const readClipboard = window.isSecureContext && typeof navigator.clipboard?.read === 'function';
    const clipboardImage = async (): Promise<Blob | null> => {
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) return await item.getType(type);
        }
      } catch {
        // 권한 거부 등은 이미지 없음과 같게 다룬다
      }
      return null;
    };
    el.addEventListener('paste', onPaste, { capture: true });

    // 보는 컴퓨터의 터미널과 같게 (서버가 맥이든 Windows 든 손에 익은 키 그대로): xterm 이 안 보내거나 다르게 보내는 키를 고친다
    //  공통: Shift+Enter → ESC+CR (Claude Code·Codex 줄바꿈), Alt(⌥)+←/→ → 단어 이동(ESC b/f), Alt(⌥)+⌫ → 단어 지우기(ESC DEL)
    //  맥(Terminal·iTerm): ⌘←/⌘→ → 줄 처음·끝(^A/^E), ⌘⌫ → 줄 지우기(^U). ⌘K 는 이 화면의 스크롤백만 지운다
    //  Windows·Linux(VS Code 터미널처럼): Ctrl+Backspace → 단어 지우기(^W). Ctrl+←/→ 는 xterm 대로 보낸다 (ESC b/f 로 바꾸면 vim 입력 모드가 끝난다)
    const KEYS: Record<string, string> = {
      'shift+Enter': '\x1b\r',
      'alt+ArrowLeft': '\x1bb',
      'alt+ArrowRight': '\x1bf',
      'alt+Backspace': '\x1b\x7f',
      ...(mac ? { 'meta+ArrowLeft': '\x01', 'meta+ArrowRight': '\x05', 'meta+Backspace': '\x15' } : { 'ctrl+Backspace': '\x17' }),
    };
    term.attachCustomKeyEventHandler((ev) => {
      const mods = [ev.metaKey && 'meta', ev.ctrlKey && 'ctrl', ev.altKey && 'alt', ev.shiftKey && 'shift'].filter(Boolean).join('+');
      // 복사: ⌘C(맥)는 브라우저가 한다. Windows·Linux 터미널처럼 Ctrl+Shift+C 와, 고른 글이 있을 때의 Ctrl+C 도 복사한다.
      // Ctrl+Shift+C 는 크롬의 요소 검사 키라 고른 글이 없어도 막는다. 고른 글이 없는 Ctrl+C 는 그대로 중단(^C)
      if (ev.code === 'KeyC' && (mods === 'ctrl+shift' || (!mac && mods === 'ctrl' && term.hasSelection()))) {
        if (ev.type === 'keydown' && term.hasSelection()) {
          // 키를 누른 그때라 바로 쓰고 결과를 안다 (navigator.clipboard 는 거절돼도 나중에야 안다)
          const ok = copyNow(term.getSelection());
          // 다음 Ctrl+C 는 중단으로 가게 고른 것을 푼다. 못 했으면 남겨 두어 다시 눌러도 중단되지 않게 한다
          if (ok) term.clearSelection();
          cb.current.onNotice?.(ok ? '복사됨' : '복사하지 못했습니다');
        }
        ev.preventDefault();
        return false;
      }
      // Windows·Linux 의 Ctrl+V·Ctrl+Shift+V 는 브라우저 붙여넣기에 맡긴다 (글은 xterm 이, 이미지는 onPaste 가 받는다)
      if (!mac && ev.code === 'KeyV' && (mods === 'ctrl' || mods === 'ctrl+shift')) return false;
      // 한글 입력 중엔 key 가 'ㅍ' 이라 자판 위치(code)로 본다
      if (mods === 'ctrl' && ev.code === 'KeyV' && canInput && readClipboard) {
        // 앞의 붙여넣기가 아직 끝나지 않았으면 이번 것은 무시한다
        if (ev.type === 'keydown' && held === null) holdUntil(clipboardImage().then((image) => (image ? uploadImage(image) : '\x16')));
        ev.preventDefault();
        return false;
      }
      // 한글 등 IME 가 켜진 채 누른 Ctrl+글자는 keyCode 229 로 와서 xterm 이 버린다(조합 중이었으면 조합만 끝난다). 그러면 Claude Code 의
      // Ctrl+X → Ctrl+S(작업 중 바로 보내기)가 첫 키를 잃고, 홀로 간 Ctrl+S 는 입력을 치워 버린다(stash). 제어 문자를 직접 보낸다:
      // 조합 중이거나 확정된 글이 아직 안 나갔으면 그 글 뒤에 보낸다
      if (ev.keyCode === 229 && mods === 'ctrl' && /^Key[A-Z]$/.test(ev.code)) {
        if (ev.type === 'keydown' && canInput) {
          const byte = String.fromCharCode(ev.code.charCodeAt(3) - 64);
          if (afterCompose !== null) afterCompose += byte;
          else if (ev.isComposing || delivering) {
            afterCompose = byte;
            // 이 키로 조합이 끝나지 않으면(compositionend 가 안 오면) 잠시 뒤 혼자 보낸다
            afterComposeTimer = setTimeout(sendAfterCompose, IME_CTRL_MS);
          } else send(byte);
        }
        return false;
      }
      // 조합이 끝나지 않은 채 다른 키를 누르면 기다리던 것을 이 키 앞에 보낸다
      if (ev.type === 'keydown' && afterCompose !== null && !delivering && !ev.isComposing) sendAfterCompose();
      const combo = `${mods}+${ev.key}`;
      if (combo === 'meta+k') {
        if (ev.type === 'keydown') term.clear();
        ev.preventDefault();
        return false;
      }
      const seq = KEYS[combo];
      if (seq === undefined || !canInput) return true;
      if (ev.type === 'keydown') send(seq);
      ev.preventDefault();
      return false;
    });

    // 우클릭 붙여넣기: 클립보드를 읽을 수 있으면(https) 바로 붙인다. http 에선 브라우저가 막으므로
    // 기본 메뉴를 그대로 띄운다 (xterm 이 입력칸을 마우스 아래로 옮겨 두어 메뉴의 "붙여넣기"가 터미널로 간다)
    const onContextMenu = (e: MouseEvent) => {
      if (!canInput || !pasteOnRightClick || term.hasSelection()) return;
      e.preventDefault();
      navigator.clipboard.readText().then(
        (text) => text && term.paste(text),
        () => cb.current.onNotice?.(`클립보드를 읽지 못했습니다. ${mac ? 'Cmd+V' : 'Ctrl+V'} 로 붙여넣으세요`),
      );
    };
    // xterm 이 먼저 받아 멈추지 않게 잡는 단계에서 듣는다
    el.addEventListener('contextmenu', onContextMenu, { capture: true });

    // 휠: 마우스를 받는 프로그램(Claude Code)엔 xterm 이 휠 보고를 보낸다. 마우스를 안 받는 전체 화면 프로그램엔
    // xterm 이 화살표 키로 바꿔 보내는데, Codex 에선 화살표가 입력 기록 탐색이다. Codex 엔 휠 보고를 직접 만들어 한 줄씩 보내고,
    // 휠 보고를 글자로 받을 다른 프로그램(less 등)엔 PgUp/PgDn 으로 넘긴다
    let wheelAcc = 0;
    term.attachCustomWheelEventHandler((ev) => {
      if (!canInput || term.buffer.active.type !== 'alternate' || term.modes.mouseTrackingMode !== 'none') return true;
      if (wheelReports.current) {
        const r = (el.querySelector('.xterm-screen') ?? el).getBoundingClientRect();
        const rowPx = r.height / term.rows || 16;
        // Codex 는 포인터 아래 영역(대화·입력칸)을 움직이므로 휠을 굴린 칸을 1부터 센다
        const cell = (at: number, start: number, size: number, n: number) => (size > 0 ? Math.min(n, Math.max(1, Math.floor(((at - start) / size) * n) + 1)) : 1);
        const at = `${cell(ev.clientX, r.left, r.width, term.cols)};${cell(ev.clientY, r.top, r.height, term.rows)}M`;
        wheelAcc += ev.deltaMode === 1 ? ev.deltaY * rowPx : ev.deltaY;
        while (Math.abs(wheelAcc) >= rowPx) {
          const down = wheelAcc > 0;
          wheelAcc -= down ? rowPx : -rowPx;
          queue += `\x1b[<${down ? 65 : 64};${at}`;
        }
      } else {
        wheelAcc += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
        while (Math.abs(wheelAcc) >= WHEEL_PAGE_PX) {
          const down = wheelAcc > 0;
          wheelAcc -= down ? WHEEL_PAGE_PX : -WHEEL_PAGE_PX;
          queue += down ? '\x1b[6~' : '\x1b[5~';
        }
      }
      void flush();
      ev.preventDefault();
      return false;
    });
    // 터치: 대체 화면엔 xterm 스크롤백이 없어 손가락으로 쓸어도 아무 일이 없다. 쓴 거리만큼 휠 이벤트로 바꿔 위 경로를 탄다.
    // 줄 단위로 움직이는 프로그램은 손을 떼도 휴대폰 스크롤처럼 그 빠르기로 잠깐 더 미끄러진다
    let lastY: number | null = null;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0; // px/ms. 손가락을 위로 올릴수록(아래 내용을 볼수록) +
    let touchAcc = 0;
    let fling = 0;
    const stopFling = () => {
      cancelAnimationFrame(fling);
      fling = 0;
    };
    /** 프로그램 화면을 dy(px) 만큼 움직인다. 한 줄씩 움직였으면 true (관성은 이때만) */
    const scrollProgram = (dy: number, x: number, y: number): boolean => {
      const target = el.querySelector('.xterm-screen') ?? el;
      const wheel = (deltaY: number, deltaMode: number) => target.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      // 마우스를 안 받는 프로그램은 휠이 PgUp/PgDn 이 된다. 손가락으로 터미널 높이의 30% 를 쓸면 한 쪽 넘어가게 맞춘다
      if (term.modes.mouseTrackingMode === 'none' && !wheelReports.current) {
        wheel((dy * WHEEL_PAGE_PX) / Math.max(1, el.clientHeight * 0.3), 0);
        return false;
      }
      // 쓴 거리 한 줄 높이마다 휠 한 번(Codex 는 보고 하나에 한 줄이라 손가락을 그대로 따라간다), Claude Code 엔 TOUCH_SPEED 번.
      // 픽셀 휠을 그대로 넘기면 xterm 이 작은 값을 트랙패드로 보고 0.3 배로 줄여 느리다
      touchAcc += (dy * (wheelReports.current ? 1 : TOUCH_SPEED)) / Math.max(1, el.clientHeight / term.rows);
      while (Math.abs(touchAcc) >= 1) {
        const step = Math.sign(touchAcc);
        touchAcc -= step;
        wheel(step, 1);
      }
      return true;
    };
    // 꾹 누르기: 휴대폰은 xterm 글자를 손가락으로 고를 수 없어, 움직이지 않고 누르고 있으면 터미널 글을 보통 글로 넘긴다
    let press: ReturnType<typeof setTimeout> | undefined;
    let pressX = 0;
    let pressY = 0;
    const cancelPress = () => clearTimeout(press);
    const onTouchStart = (e: TouchEvent) => {
      // 미끄러지는 중에 닿으면 멈춘다
      stopFling();
      velocity = 0;
      lastT = e.timeStamp;
      lastY = e.touches.length === 1 ? e.touches[0]!.clientY : null;
      cancelPress();
      if (e.touches.length !== 1 || !cb.current.onPick) return;
      pressX = e.touches[0]!.clientX;
      pressY = e.touches[0]!.clientY;
      press = setTimeout(() => {
        // 같은 손가락을 계속 움직여도 숨긴 터미널을 스크롤하지 않게 이 동작은 여기서 끝낸다
        lastY = null;
        velocity = 0;
        cb.current.onPick?.(bufferText(term), term.cols);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!p || Math.hypot(p.clientX - pressX, p.clientY - pressY) > 8) cancelPress();
      // 일반 화면은 xterm 이 스크롤백을 손가락으로 직접 움직인다
      if (lastY === null || term.buffer.active.type !== 'alternate') return;
      const t = e.touches[0]!;
      const dy = lastY - t.clientY;
      if (Math.abs(dy) < 8) return;
      lastY = t.clientY;
      lastX = t.clientX;
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - lastT);
      lastT = e.timeStamp;
      // 컴퓨터의 휠처럼 쓸기는 터미널 안을 움직인다. 보기 전용이라 프로그램에 보낼 수 없거나, 터미널이 화면보다 커서
      // 일부가 영영 안 보일 때만 페이지를 움직인다 (xterm 이 터치 이동을 막아 페이지가 저절로는 안 움직인다)
      const r = el.getBoundingClientRect();
      if (!canInput || (r.height > window.innerHeight && ((dy > 0 && r.bottom > window.innerHeight + 1) || (dy < 0 && r.top < -1)))) {
        window.scrollBy(0, dy);
        velocity = 0;
        return;
      }
      velocity = scrollProgram(dy, t.clientX, t.clientY) ? 0.6 * (dy / dt) + 0.4 * velocity : 0;
    };
    const onTouchEnd = (e: TouchEvent) => {
      cancelPress();
      // 멈췄다 뗀 손가락은 미끄러지지 않는다
      if (lastY === null || Math.abs(velocity) < FLING_MIN || e.timeStamp - lastT > 100) return;
      const y = lastY;
      let v = velocity;
      let prev = performance.now();
      const step = (now: number) => {
        const dt = now - prev;
        prev = now;
        v *= FLING_DECAY ** dt;
        // 글자 고르기로 터미널을 숨기면(높이 0) 멈춘다. 한 줄 높이를 못 재 휠이 부풀어 간다
        if (Math.abs(v) < FLING_STOP || term.buffer.active.type !== 'alternate' || !el.clientHeight) return void (fling = 0);
        scrollProgram(v * dt, lastX, y);
        fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', cancelPress, { passive: true });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitFont) : null;
    ro?.observe(el);
    // 컴퓨터에선 높이를 '터미널이 시작하는 곳부터 화면 끝까지'로 잡는다(termsize.ts): 창 높이가 바뀌거나, 위에 오류 안내가 생겨
    // 터미널이 밀려 내려가면(페이지 크기가 바뀐다) 다시 맞춘다. 세션 정보는 떠서 펼치고 입력 대기 안내는 아래에 두므로 이걸로는 안 바뀐다
    ro?.observe(document.body);
    window.addEventListener('resize', fitFont);
    return () => {
      closed = true;
      queue = '';
      input.dispose();
      el.removeEventListener('paste', onPaste, { capture: true });
      el.removeEventListener('contextmenu', onContextMenu, { capture: true });
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', cancelPress);
      stopFling();
      cancelPress();
      clearTimeout(afterComposeTimer);
      term.textarea?.removeEventListener('compositionend', onCompositionEnd);
      settle();
      ro?.disconnect();
      window.removeEventListener('resize', fitFont);
      stopFeed();
      xterm.current = null;
      term.dispose();
    };
  }, [projectId, pane, canInput]);

  // 나란히 보기에서 다른 칸을 고르면 그 터미널로 키 입력을 옮긴다 (첫 화면 때만 잡으면 칸을 눌러야 했다)
  useEffect(() => {
    if (focus && canInput && window.matchMedia?.('(pointer: fine)').matches) xterm.current?.focus();
  }, [focus, canInput]);

  return <div ref={host} className="xterm-host" aria-label="터미널" />;
}
