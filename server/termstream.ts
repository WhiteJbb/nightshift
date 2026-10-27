/**
 * pane 출력을 그대로 흘려보내는 스트림. tmux 컨트롤 모드(`tmux -C attach`) 클라이언트를 세션마다 하나 띄워
 * `%output` 알림을 구독자에게 전달한다. 첫 화면은 같은 채널로 capture-pane 을 보내 받는다:
 * 그 응답 앞에 온 출력은 이미 화면에 들어 있으니 버리고, 뒤에 온 것만 이어 보낸다 (한 스트림이라 순서가 보장된다).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ControlParser } from './control.ts';
import type { TermEvent } from '../shared/types.ts';

/** 첫 화면에 같이 보내는 스크롤백 줄 수 */
export const SEED_SCROLLBACK = 5000;

type Sink = (e: TermEvent) => void;
type Reply = (ok: boolean, lines: string[]) => void;

interface Sub {
  pane: string;
  sink: Sink;
  /** capturing: 첫 화면 응답 전(출력은 이미 화면에 들어 있으니 버린다) → ready: 그대로 흘린다 */
  stage: 'capturing' | 'ready';
  cols: number;
  rows: number;
}

interface Client {
  proc: ChildProcessWithoutNullStreams;
  pending: Reply[];
  subs: Set<Sub>;
  stderr: string;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const flag = (s: string | undefined) => s === '1';

/** tmux 가 알려 준 모드를 xterm 에 똑같이 거는 이스케이프 시퀀스 */
export function modeCodes(f: Record<string, boolean>): string {
  const set = (on: boolean, code: string) => `\x1b[?${code}${on ? 'h' : 'l'}`;
  return [
    set(f.cursor ?? true, '25'),
    set(f.keypadCursor ?? false, '1'),
    set(f.wrap ?? true, '7'),
    set(f.mouseStandard ?? false, '1000'),
    set(f.mouseButton ?? false, '1002'),
    set(f.mouseAll ?? false, '1003'),
    set(f.mouseSgr ?? false, '1006'),
    set(f.bracketPaste ?? false, '2004'),
  ].join('');
}

const STATE_FORMAT =
  '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{cursor_flag} #{keypad_cursor_flag} #{wrap_flag} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{pane_dead} #{bracket_paste_flag}';

export class TermStreams {
  private clients = new Map<string, Client>();

  /** 지금 이 세션의 터미널을 화면에 띄워 보고 있는 브라우저가 있는지 (숨은 탭은 스트림을 닫는다) */
  watching(session: string): boolean {
    return (this.clients.get(session)?.subs.size ?? 0) > 0;
  }

  /**
   * 보고 있는 pane 이면 그 컨트롤 모드 연결로 키 바이트를 넣는다. 키마다 tmux 를 따로 띄우지 않아 빠르다
   * (띄우는 동안 서버가 멈춘다). 보는 연결이 없으면 null. 실패하면 오류 메시지
   */
  sendRaw(pane: string, bytes: Uint8Array): Promise<string | null> | null {
    const client = [...this.clients.values()].find((c) => [...c.subs].some((s) => s.pane === pane));
    if (!client?.proc.stdin.writable) return null;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return new Promise((resolve) => {
      // 응답 전에 연결이 끊기면 응답이 오지 않는다. 기다리는 입력 요청이 멈추지 않게 실패로 끝낸다
      const gone = () => resolve('tmux 연결이 끊겼습니다');
      client.proc.once('exit', gone);
      this.command(client, [
        `send-keys -t ${pane} -H ${hex}`,
        (ok, lines) => {
          client.proc.off('exit', gone);
          resolve(ok ? null : lines.join('\n') || 'tmux send-keys 실패');
        },
      ]);
    });
  }

  /** 구독을 시작한다. 돌려주는 함수로 끊는다. */
  subscribe(session: string, pane: string, sink: Sink): () => void {
    const client = this.client(session);
    const sub: Sub = { pane, sink, stage: 'capturing', cols: 0, rows: 0 };
    client.subs.add(sub);
    this.seed(client, sub);
    return () => {
      client.subs.delete(sub);
      if (client.subs.size === 0) {
        // 그 사이 이 클라이언트가 죽고 새 클라이언트가 같은 이름으로 들어왔을 수 있다. 내 것만 지운다
        if (this.clients.get(session) === client) this.clients.delete(session);
        client.proc.kill();
      }
    };
  }

  private client(session: string): Client {
    const existing = this.clients.get(session);
    if (existing) return existing;
    // '=' 는 이름 앞부분 일치가 아니라 정확히 그 이름의 세션. -E: 보기만 하는 연결이 세션 환경(SSH_AUTH_SOCK 등)을 서버 것으로 덮지 않게
    const proc = spawn('tmux', ['-C', 'attach-session', '-E', '-t', `=${session}`], { env: { LANG: 'en_US.UTF-8', ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    // attach 자체도 %begin/%end 응답 블록을 하나 먼저 보낸다. 그 몫을 비워 둬야 뒤의 응답이 제 명령과 맞는다
    const client: Client = { proc, pending: [() => {}], subs: new Set(), stderr: '' };
    const parser = new ControlParser();
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const ev of parser.feed(chunk)) {
        if (ev.type === 'output') {
          for (const sub of client.subs) {
            if (sub.pane !== ev.pane) continue;
            if (sub.stage === 'ready') sub.sink({ type: 'out', data: b64(ev.data) });
          }
        } else if (ev.type === 'reply') client.pending.shift()?.(ev.ok, ev.lines);
        else if (ev.name === 'layout-change' || ev.name === 'window-pane-changed') this.refreshSizes(client);
      }
    });
    // 프로세스가 죽는 중에 명령을 쓰면 EPIPE 가 난다. 처리하지 않으면 서버 전체가 죽는다 (끝 처리는 exit 가 한다)
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (chunk: Buffer) => {
      client.stderr += chunk.toString('utf8');
    });
    const end = () => {
      if (this.clients.get(session) === client) this.clients.delete(session);
      const message = client.stderr.trim();
      for (const sub of client.subs) sub.sink(message ? { type: 'error', message } : { type: 'exit' });
      client.subs.clear();
    };
    proc.on('exit', end);
    proc.on('error', (e) => {
      client.stderr += e.message;
      end();
    });
    this.clients.set(session, client);
    return client;
  }

  /** 명령들을 한 줄로 보낸다. tmux 는 한 줄의 명령을 끊김 없이 차례로 처리해, 그 사이에 pane 출력이 끼지 않는다 */
  private command(client: Client, ...cmds: [string, Reply][]) {
    if (!client.proc.stdin.writable) return;
    for (const [, reply] of cmds) client.pending.push(reply);
    client.proc.stdin.write(`${cmds.map(([cmd]) => cmd).join(' ; ')}\n`);
  }

  /** 첫 화면: 스크롤백 + 현재 화면 + 커서·모드. 화면과 커서를 한 번에 읽고, 그 뒤에 온 출력부터 이어진다 */
  private seed(client: Client, sub: Sub) {
    let lines: string[] | null = null; // capture 가 실패하면 null 로 남아 상태 응답을 무시한다
    const capture = `capture-pane -p -e -t ${sub.pane} -S -${SEED_SCROLLBACK}`;
    const state = `display -p -t ${sub.pane} '${STATE_FORMAT}'`;
    this.command(
      client,
      [capture, (ok, out) => (ok ? (lines = out) : sub.sink({ type: 'error', message: out.join('\n') || 'capture-pane 실패' }))],
      [
        state,
        (ok, out) => {
          const f = (out[0] ?? '').split(' ');
          if (sub.stage !== 'capturing' || lines === null) return;
          if (!ok || f.length < 14) return sub.sink({ type: 'error', message: out.join('\n') || 'pane 상태를 읽지 못했습니다' });
          sub.cols = Number(f[0]);
          sub.rows = Number(f[1]);
          const alt = flag(f[4]);
          const prelude = alt ? '\x1b[?1049h' : '';
          const cursor = `\x1b[${Number(f[3]) + 1};${Number(f[2]) + 1}H`;
          const modes = modeCodes({ cursor: flag(f[5]), keypadCursor: flag(f[6]), wrap: flag(f[7]), mouseStandard: flag(f[8]), mouseButton: flag(f[9]), mouseAll: flag(f[10]), mouseSgr: flag(f[11]), bracketPaste: flag(f[13]) });
          // 두 응답 사이에는 출력이 끼지 않으므로 지금부터 오는 출력은 화면에 아직 없는 것이다
          sub.stage = 'ready';
          sub.sink({ type: 'init', cols: sub.cols, rows: sub.rows, alt, data: Buffer.from(prelude + lines.join('\r\n') + cursor + modes, 'utf8').toString('base64') });
          if (flag(f[12])) sub.sink({ type: 'exit' });
        },
      ],
    );
  }

  /** 창 배치가 바뀌면 pane 크기를 다시 묻는다 */
  private refreshSizes(client: Client) {
    for (const sub of client.subs) {
      if (sub.stage !== 'ready') continue;
      this.command(client, [
        `display -p -t ${sub.pane} '#{pane_width} #{pane_height} #{pane_dead}'`,
        (ok, lines) => {
          const [w, h, dead] = (lines[0] ?? '').split(' ').map(Number);
          if (!ok || !w || !h) return sub.sink({ type: 'exit' });
          if (dead) return sub.sink({ type: 'exit' });
          if (w !== sub.cols || h !== sub.rows) {
            sub.cols = w;
            sub.rows = h;
            sub.sink({ type: 'resize', cols: w, rows: h });
          }
        },
      ]);
    }
  }
}
