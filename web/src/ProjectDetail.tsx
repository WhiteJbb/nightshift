import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import type { AgentKind, Commit, FileStat, InputKey, InputRequest, ProjectSnapshot, ProjectState, RunKind, RunResult, RunSummary, TermEvent, TmuxPane } from '../../shared/types.ts';
import { NOT_A_REPO } from '../../shared/types.ts';
import { AGENTS, StartSession } from './NewSession.tsx';
import { FilesTab, useDismiss } from './Files.tsx';
import { charWidth, fitSize, fontRange } from './termsize.ts';
import { parseAnsi } from './ansi.ts';
import { copyText, Term, TERM_FONT, TERM_FONT_SIZE } from './Term.tsx';
import type { TermFeed, TermStatus } from './Term.tsx';
import { api, ApiError, errorMessage } from './api.ts';
import { dateTime, duration, relTime, STATE_LABEL } from './format.ts';

export function Badge({ state }: { state: ProjectState }) {
  return <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>;
}

export function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="reasons">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

const TABS = [
  ['terminal', '터미널'],
  ['files', '파일'],
  ['git', 'Git'],
  ['runs', '테스트·빌드'],
] as const;
type Tab = (typeof TABS)[number][0];
const TAB_IDS = TABS.map(([id]) => id);
// 고른 탭은 주소에 남긴다: #/project/<id>/<탭>. 새로고침·뒤로 가기에도 그대로다
const hashTab = (): Tab => TAB_IDS.find((id) => id === window.location.hash.split('/')[3]) ?? 'terminal';

interface Props {
  project: ProjectSnapshot;
  now: string;
  /** 스냅샷 갱신 주기(초). 실시간 보기가 안 될 때의 표시에 쓴다 */
  refreshSec?: number;
}

const failed = (r: RunResult | null) => r !== null && !r.running && (r.timedOut || (!r.canceled && r.exitCode !== 0));

export function ProjectDetail({ project: p, now, refreshSec }: Props) {
  const [tab, setTabState] = useState<Tab>(hashTab);
  const setTab = (id: Tab) => {
    setTabState(id);
    // 탭마다 기록이 쌓이지 않게 지금 주소만 바꾼다
    history.replaceState(null, '', `#/project/${encodeURIComponent(p.id)}/${id}`);
  };
  // 화살표·Home·End 로 탭을 옮긴다. 고른 탭만 Tab 순서에 들어간다 (roving tabindex)
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TAB_IDS.indexOf(tab);
    const n = TAB_IDS.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setTab(TAB_IDS[next]!);
    document.getElementById(`tab-${TAB_IDS[next]}`)?.focus();
  };
  // 탭에 붙이는 오류 수: Git 은 로그 오류, 테스트·빌드는 마지막 실행이 실패한 것
  const counts: Record<Tab, number> = { terminal: 0, files: 0, git: p.logErrors.length, runs: [p.runs.test, p.runs.build].filter(failed).length };
  const tabs = (
    <div className="tabs" role="tablist" aria-label="프로젝트 정보" onKeyDown={onTabKey}>
      {TABS.map(([id, label]) => (
        <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={tab === id ? `panel-${id}` : undefined} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
          {label}
          {counts[id] > 0 && (
            <span className="tab-count" title={`오류 ${counts[id]}건`}>
              {counts[id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <p className="crumb">
        <a href="#/">← 대시보드</a>
      </p>
      {/* 머리는 짧게: 제목·상태·탭을 한 줄에, 상태 설명과 경로를 그 아래 한 줄에. 남는 높이는 터미널이 쓴다 */}
      <div className="detail-head">
        <h1>{p.name}</h1>
        <Badge state={p.status.state} />
        {p.id.startsWith('tmux:') && <Register project={p} />}
        {tabs}
        {/* 세션 끝내기·삭제는 드물고 되돌릴 수 없어 머리 오른쪽 끝에 따로 둔다. key 로 바뀔 때 오류 표시를 지운다 */}
        {p.tmuxSession && !p.id.startsWith('tmux:') && <EndSession key={String(p.tmux.exists)} project={p} />}
      </div>
      <div className="detail-meta">
        <Reasons reasons={p.status.reasons} />
        <span className="mono path" title={p.repoPath}>
          {p.repoPath}
        </span>
      </div>
      <LogErrorsAck
        project={p}
        onShow={() => {
          setTab('git');
          setTimeout(() => document.getElementById('log-errors')?.scrollIntoView?.({ block: 'start' }));
        }}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'terminal' && <TerminalTab project={p} now={now} refreshSec={refreshSec} />}
        {tab === 'files' && <FilesTab project={p} />}
        {tab === 'git' && <GitTab project={p} now={now} />}
        {tab === 'runs' && (
          <>
            <p className="hint">명령은 설정 파일에서만 바꿀 수 있습니다.</p>
            <RunPanel project={p} kind="test" title="테스트" />
            <RunPanel project={p} kind="build" title="빌드" />
          </>
        )}
      </div>
    </>
  );
}

/** 설정에 없는 tmux 세션을 지금 경로로 프로젝트에 등록한다 (대시보드의 "등록"과 같은 요청). 등록되면 새 프로젝트 화면으로 옮긴다 */
function Register({ project: p }: { project: ProjectSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = p.tmuxSession ?? p.name;
  const register = () => {
    setBusy(true);
    setError(null);
    api.createSession({ name: session, repoPath: p.repoPath, tmuxSession: session, allowInput: false }).then(
      ({ id }) => {
        window.location.hash = `#/project/${encodeURIComponent(id)}`;
      },
      (e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <span className="dim" title="설정에 없는 tmux 세션. 세션이 닫히면 이 화면도 사라집니다">
        미등록
      </span>
      <button type="button" disabled={busy} onClick={register} title="이 세션을 지금 경로로 프로젝트에 등록합니다">
        {busy ? '등록하는 중…' : '프로젝트로 등록'}
      </button>
      {error && (
        <span className="err" role="alert">
          등록 실패: {error}
        </span>
      )}
    </>
  );
}

/** 로그 오류가 있으면 화면 위쪽에서 바로 보고 확인 처리한다 */
function LogErrorsAck({ project: p, onShow }: { project: ProjectSnapshot; onShow: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ack = () => {
    setBusy(true);
    setError(null);
    api
      .ackErrors(p.id)
      .then(
        () => {
          setDone(true);
          setTimeout(() => setDone(false), 4000);
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setBusy(false));
  };
  if (done) {
    return (
      <p className="ok" role="status">
        로그 오류 표시를 지웠습니다. 새 오류는 계속 감지합니다.
      </p>
    );
  }
  if (p.logErrors.length === 0) return null;
  return (
    <div className="notice error log-ack">
      <strong>로그에서 오류 {p.logErrors.length}건을 감지했습니다.</strong>
      <p className="mono wrap">{p.logErrors.at(-1)}</p>
      <div className="actions">
        <button type="button" onClick={onShow}>
          로그 보기
        </button>
        <button type="button" onClick={ack} disabled={busy}>
          로그 오류 확인 완료
        </button>
      </div>
      <p className="hint">지금까지 감지한 오류 표시를 지웁니다. 새 오류는 계속 감지합니다.</p>
      {error && (
        <p className="err" role="alert">
          확인 처리 실패: {error}
        </p>
      )}
    </div>
  );
}

// [tmux 키, 버튼 글자, 설명]
// 터치 화면에서는 이 키들만 늘 보이고 나머지는 "더보기" 뒤로 접힌다.
const PRIMARY_KEYS: InputKey[] = ['Escape', 'Tab', 'Up', 'Down'];
// 마우스 환경인지. 터치 화면에서는 입력 칸에 포커스를 주면 키보드가 올라와 화면을 가린다
const finePointer = () => typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: fine)').matches;
const KEYS: [InputKey, string, string][] = [
  ['Enter', 'Enter', 'Enter 보내기'],
  ['Escape', 'Esc', 'Esc 보내기'],
  ['Tab', 'Tab', 'Tab 보내기'],
  ['BTab', '⇧Tab', 'Shift+Tab 보내기'],
  ['Up', '↑', '위 화살표 보내기'],
  ['Down', '↓', '아래 화살표 보내기'],
  ['Left', '←', '왼쪽 화살표 보내기'],
  ['Right', '→', '오른쪽 화살표 보내기'],
  // 전체 화면으로 도는 프로그램(Claude Code, less 등)은 스크롤백이 tmux 에 없어서, 프로그램 안에서 직접 넘겨야 한다
  ['PPage', 'PgUp', 'Page Up 보내기 (프로그램 안에서 위로)'],
  ['NPage', 'PgDn', 'Page Down 보내기 (프로그램 안에서 아래로)'],
  ['BSpace', '⌫', 'Backspace 보내기 (한 글자 지우기)'],
  ['C-c', 'Ctrl+C', 'Ctrl+C 보내기 (중단)'],
  ['C-d', 'Ctrl+D', 'Ctrl+D 보내기 (EOF·종료)'],
  ['C-u', 'Ctrl+U', 'Ctrl+U 보내기 (줄 지우기)'],
  ['C-l', 'Ctrl+L', 'Ctrl+L 보내기 (화면 지우기)'],
];
const CAUTION: InputKey[] = ['C-c', 'C-d'];

// 입력칸이 비어 있을 때 그대로 pane 으로 넘기는 키
const FORWARD: Record<string, InputKey> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Backspace: 'BSpace',
  PageUp: 'PPage',
  PageDown: 'NPage',
};
// 빈 입력칸에서 Ctrl 조합은 pane 으로 간다. 컴퓨터에선 키 버튼이 숨겨져 있어 이게 유일한 길이다
const CTRL: Record<string, InputKey> = { c: 'C-c', d: 'C-d', u: 'C-u', l: 'C-l' };

/** pane: 입력을 보낼 pane. 고른 pane 이 사라졌으면 null 이고, 다시 고를 때까지 보내지 않는다 */
/** 터미널 번호: 윈도우 번호, 윈도우가 나뉘어 있으면 pane 번호까지 (예: "1", "0.1") */
const paneNo = (x: TmuxPane, panes: TmuxPane[]) => (panes.some((y) => y.window === x.window && y.id !== x.id) ? `${x.window}.${x.index}` : String(x.window));
/** 글자 고르기 화면의 좌우 여백(px). styles.css 의 .pick .terminal 과 같다 */
const PICK_PAD = 14;
/** 글자 고르기의 최대 글자 크기(px). 터미널(13)보다 한 단계 작게 해 한 화면에 더 많이 담는다 */
const PICK_FONT_MAX = 12;
/** 터미널 글을 화면 가득 보통 글로 보여 준다. 휴대폰의 길게 눌러 고르기·복사가 된다. 최근 출력(맨 아래)부터 보인다 */
function PickText({ text, cols, onDone }: { text: string; cols: number; onDone: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  // 줄은 터미널 폭(cols)에서 나뉘어 오므로(에이전트는 직접 줄을 바꿔 보낸다) 그 칸 수가 화면 폭에 꽉 차는 크기로 그린다
  const [fontSize] = useState(() => {
    const [min] = fontRange();
    const perPx = charWidth(`${TERM_FONT_SIZE}px ${TERM_FONT}`) / TERM_FONT_SIZE;
    return Math.max(min, Math.min(PICK_FONT_MAX, Math.floor(((document.documentElement.clientWidth - 2 * PICK_PAD) / (cols * perPx)) * 10) / 10));
  });
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, []);
  return (
    <div className="pick">
      <pre ref={ref} className="terminal wrap-lines" style={{ fontSize, fontFamily: TERM_FONT }} tabIndex={0} aria-label="터미널 글 (길게 눌러 골라 복사)">
        {text}
      </pre>
      <button type="button" className="more-rows pick-done" onClick={onDone}>
        터미널로
      </button>
    </div>
  );
}

/** 도는 프로그램 이름 (Claude Code 네이티브 실행 파일은 claude.exe 로 보인다) */
const progName = (x: TmuxPane) => x.command.replace(/\.exe$/, '');

/** targetNo: 보낼 곳으로 보여 줄 터미널 번호. pane 이 하나뿐이면 null (보낼 곳이 뻔하다) */
function InputBar({ projectId, pane: target, targetNo }: { projectId: string; pane: TmuxPane | null; targetNo: string | null }) {
  const showTarget = targetNo !== null;
  // ponytail: 이름이 claude 인 pane 만 알아본다. npm 으로 깐 Claude Code 는 node 로 보여 "지금 보내기"가 없다
  const claude = target !== null && progName(target) === 'claude';
  const pane = target?.id ?? '';
  const [text, setText] = useState('');
  const [moreKeys, setMoreKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 올리는 중인 이미지 수. 다 올라가 경로가 입력에 들어가기 전엔 프롬프트를 보내지 않는다
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 이미지는 서버에 파일로 저장하고 그 경로를 입력 칸에 넣는다. Claude Code·Codex 는 프롬프트 안의 이미지 경로를 첨부로 읽는다.
  const attach = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    setUploading((n) => n + 1);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      api
        .upload(projectId, { type: file.type, data: String(reader.result).split(',')[1] ?? '' })
        .then(
          ({ path }) => {
            setText((cur) => `${cur.trimEnd()}${cur.trim() ? ' ' : ''}${path} `);
            inputRef.current?.focus();
          },
          (e: unknown) => setError(errorMessage(e)),
        )
        .finally(() => setUploading((n) => n - 1));
    };
    reader.onerror = () => {
      setError('이미지를 읽지 못했습니다');
      setUploading((n) => n - 1);
    };
    reader.readAsDataURL(file);
  };
  const imageOf = (files: FileList | undefined) => (files ? [...files].find((f) => f.type.startsWith('image/')) : undefined);
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = imageOf(e.clipboardData?.files);
    if (!file) return; // 글은 평소대로 붙는다
    e.preventDefault();
    attach(file);
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const file = imageOf(e.dataTransfer?.files);
    if (!file) return;
    e.preventDefault();
    attach(file);
  };

  // 입력칸은 잠그지 않는다(포커스 유지). 보내는 중의 전송 시도만 무시한다
  const send = (body: InputRequest) => {
    // 글을 보낸 뒤에는 이어서 칠 수 있게 입력 칸에 포커스를 둔다.
    // 키 버튼은 마우스 환경에서만 포커스를 되돌린다 (터치 화면에서 PgUp 을 누를 때마다 키보드가 뜨지 않게).
    if (body.text !== undefined || finePointer()) inputRef.current?.focus();
    // 보낼 pane 이 없거나, 이미지 경로가 아직 안 들어왔는데 프롬프트를 제출하려 하면 보내지 않는다
    if (busy || !target || (uploading > 0 && (body.text !== undefined || body.key === 'Enter'))) return;
    setBusy(true);
    const sent = body.text;
    if (sent !== undefined) setText('');
    api
      .sendInput(projectId, body)
      .then(
        () => setError(null),
        (e: unknown) => {
          setError(errorMessage(e));
          // 보내지 못한 글은 되돌려 놓는다. 그사이 새로 친 글이 있으면 그 앞에 붙여 둘 다 남긴다
          if (sent !== undefined) setText((cur) => (cur === '' ? sent : `${sent}\n${cur}`));
        },
      )
      .finally(() => setBusy(false));
  };
  const sendText = (enter: boolean) => {
    if (text !== '') send(enter ? { pane, text, enter: true } : { pane, text });
    else if (enter) send({ pane, key: 'Enter' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 등 IME 조합 중의 Enter 는 조합 확정이지 전송이 아니다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.altKey) return;
    if (e.ctrlKey) {
      const ctrl = text === '' ? CTRL[e.key.toLowerCase()] : undefined;
      if (ctrl) {
        e.preventDefault();
        send({ pane, key: ctrl });
      }
      return;
    }
    const forward = FORWARD[e.key];
    if (e.key === 'Enter') {
      // Shift+Enter 는 줄바꿈. 터치 화면의 키보드에는 Shift+Enter 가 없으니 Enter 가 줄바꿈이고 "보내기" 버튼이 보낸다
      if (e.shiftKey || !finePointer()) return;
      e.preventDefault();
      sendText(true);
    } else if (e.key === 'Tab') {
      // 빈 입력칸에서만 pane 으로 보낸다. 글을 치는 중엔 평소처럼 포커스가 옮겨져 키보드로 빠져나갈 수 있다
      if (text === '') {
        e.preventDefault();
        send({ pane, key: e.shiftKey ? 'BTab' : 'Tab' });
      }
    } else if (text === '' && forward) {
      e.preventDefault();
      send({ pane, key: forward });
    }
  };

  const blocked = busy || !target || uploading > 0;
  return (
    <div className={target ? 'input-bar' : 'input-bar lost'}>
      {/* pane 이 하나뿐이면 보낼 곳이 뻔하니 숨긴다 */}
      {target ? (
        (showTarget || uploading > 0) && (
          <p className="input-target">
            {showTarget && (
              <>
                보낼 곳: <span className="dim mono">{targetNo}</span> <span className="mono">{progName(target)}</span>
              </>
            )}
            {uploading > 0 && <span className="warn">{showTarget ? ' · ' : ''}이미지 올리는 중…</span>}
          </p>
        )
      ) : (
        <p className="err input-target" role="alert">
          선택한 pane 이 사라졌습니다. 위에서 pane 을 다시 고르면 보낼 수 있습니다.
        </p>
      )}
      <div className="input-row">
        <textarea
          ref={inputRef}
          className="mono"
          aria-label="pane 에 보낼 입력"
          placeholder={finePointer() ? '입력 후 Enter (줄바꿈은 Shift+Enter)' : '입력 후 보내기'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20000}
          rows={Math.min(8, text.split('\n').length)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
        />
        <button type="button" className="primary" disabled={blocked} onClick={() => sendText(true)}>
          보내기
        </button>
        {/* Claude Code 는 일하는 중에 Enter 로 받은 글을 대기열에 두었다가 지금 일이 끝나면 읽는다. Ctrl+X → Ctrl+S(send now)는 바로 읽게 한다:
            돌던 명령은 백그라운드로 옮기고 같은 턴에 읽고, 답만 쓰던 중이면 그 답을 끊는다. 쉬는 중이면 그냥 보낸다.
            휴대폰 화면 폭에선 일하는 중 표시가 잘려 안 보여서, 일하는 동안만 띄우지 않고 늘 둔다 */}
        {claude && (
          <button type="button" disabled={blocked || text === ''} title="일하는 중에도 기다리지 않고 바로 전달합니다 (Ctrl+X → Ctrl+S). 보내기는 지금 일이 끝난 뒤 전달합니다" onClick={() => send({ pane, text, now: true })}>
            지금 보내기
          </button>
        )}
        <button type="button" className="more-only" disabled={blocked || text === ''} title="Enter 를 누르지 않고 글만 pane 에 넣습니다 (아직 제출하지 않음)" onClick={() => sendText(false)}>
          입력만 하기
        </button>
        {/* 휴대폰 입력칸이 좁아지지 않게, 지금 보내기가 있으면 이미지는 "더보기" 뒤로 */}
        <button type="button" className={claude ? 'more-only' : undefined} disabled={uploading > 0} title="이미지를 골라 파일로 저장하고 경로를 입력에 넣습니다 (붙여넣기·끌어다 놓기도 됩니다)" onClick={() => fileRef.current?.click()}>
          {uploading > 0 ? '이미지 올리는 중…' : '이미지'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          aria-label="이미지 파일"
          onChange={(e) => {
            attach(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className={moreKeys ? 'keys open' : 'keys'} role="group" aria-label="특수 키">
        {KEYS.map(([key, label, title]) => (
          <button
            key={key}
            type="button"
            className={[CAUTION.includes(key) ? 'caution' : '', PRIMARY_KEYS.includes(key) ? '' : 'extra'].join(' ').trim() || undefined}
            title={title}
            aria-label={title}
            disabled={busy || !target || (key === 'Enter' && uploading > 0)}
            onClick={() => {
              // 중단·종료 키는 되돌릴 수 없다. 버튼은 손가락이 미끄러지기 쉬우니 한 번 묻는다 (키보드의 Ctrl+C 는 그대로)
              if (CAUTION.includes(key) && !window.confirm(`${label} 를 보낼까요? 실행 중인 프로그램이 중단될 수 있습니다.`)) return;
              send({ pane, key });
            }}
          >
            {label}
          </button>
        ))}
        <button type="button" className="more" aria-expanded={moreKeys} onClick={() => setMoreKeys(!moreKeys)}>
          {moreKeys ? '접기' : '더보기'}
        </button>
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <p className="hint input-help">
        입력은 선택한 pane 에 그대로 전달됩니다. 보낸 내용은 서버에 기록됩니다. 빈 입력칸에서는 Esc·방향키·Tab·PgUp/PgDn·Ctrl+C 같은 키가 그대로 pane 으로 갑니다. 이미지를 붙여넣거나 끌어다 놓으면 파일로 저장돼 경로가 들어갑니다.
      </p>
    </div>
  );
}

/** 입력 대기 프롬프트의 번호 선택지를 버튼으로: 그 번호 키를 프롬프트가 뜬 pane 에 보낸다 (입력 허용 프로젝트만). 상세와 대시보드 카드가 같이 쓴다 */
export function QuickAnswers({ project: p }: { project: ProjectSnapshot }) {
  const [answering, setAnswering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = p.tmux.waitingChoices;
  if (!p.allowInput || !choices) return null;
  return (
    <div className="choices" role="group" aria-label="바로 답하기">
      {choices.options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={answering !== null}
          onClick={() => {
            setAnswering(o.key);
            setError(null);
            api
              .sendInput(p.id, { pane: choices.pane, text: o.key })
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setAnswering(null));
          }}
        >
          {o.key}. {o.label}
        </button>
      ))}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 세션 끝내기. 세션이 없으면 같은 자리에서 프로젝트 삭제(설정에서만 지운다). 둘 다 되돌릴 수 없어 한 번 묻는다 */
function EndSession({ project: p }: { project: ProjectSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = p.tmux.exists;
  const end = () => {
    const ask = running
      ? `"${p.tmuxSession}" 세션을 끝낼까요?\n안에서 돌던 프로그램(에이전트 포함)도 종료됩니다.`
      : `"${p.name}" 프로젝트를 목록에서 삭제할까요?\n폴더와 파일은 그대로 남습니다.`;
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    (running ? api.killSession(p.id) : api.deleteProject(p.id).then(() => void (window.location.hash = '#/')))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <p className="end-session">
      <button type="button" className="danger" disabled={busy} onClick={end}>
        {running ? (busy ? '끝내는 중…' : '세션 종료') : busy ? '삭제하는 중…' : '삭제'}
      </button>
      {error && (
        <span className="err" role="alert">
          {' '}
          {error}
        </span>
      )}
    </p>
  );
}

/** 명령 출력의 색 시퀀스(vitest 등)를 색으로 그린다. 그대로 두면 "[32m✓" 같은 글자가 보인다 */
function AnsiText({ text }: { text: string }) {
  return parseAnsi(text.split('\n')).map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      {line.map((span, j) => (
        <span key={j} style={span.style}>
          {span.text}
        </span>
      ))}
    </Fragment>
  ));
}

const onVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};
/** 이만큼 마우스·키보드·터치가 없으면 자리를 비운 것으로 본다 (터미널 연결을 닫아 서버가 다시 알림을 보낸다) */
const AWAY_MS = 5 * 60_000;
const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** 자리 비움: 마지막 입력 뒤 AWAY_MS 가 지났는지. 다시 움직이면 바로 돌아온다 */
function useAway(): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setAway(true), AWAY_MS);
    const onActivity = () => {
      clearTimeout(timer);
      setAway(false);
      timer = setTimeout(() => setAway(true), AWAY_MS);
    };
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { passive: true, capture: true });
    return () => {
      clearTimeout(timer);
      for (const e of ACTIVITY) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, []);
  return away;
}

/**
 * 나란히 보기: 터미널들의 출력을 SSE 하나로 받아 pane 별로 나눠 준다. 브라우저는 http/1.1 에서 주소당 연결을 6개만 열어서
 * pane 마다 열면 입력 요청이 막힌다. 칸(Term)들이 먼저 등록하고, 연결은 그 뒤에 열린다 (자식 effect 가 먼저 돈다)
 */
function useSharedFeed(projectId: string, paneIds: string, on: boolean, attempt: string): TermFeed {
  const listeners = useRef(new Map<string, { on: (e: TermEvent) => void; down: () => void }>());
  useEffect(() => {
    if (!on || !paneIds) return;
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/terms?panes=${encodeURIComponent(paneIds)}`);
    es.onmessage = (ev: MessageEvent<string>) => {
      const e = JSON.parse(ev.data) as TermEvent & { pane: string };
      listeners.current.get(e.pane)?.on(e);
    };
    es.onerror = () => listeners.current.forEach((l) => l.down());
    return () => es.close();
  }, [projectId, paneIds, on, attempt]);
  return useCallback((pane, on, down) => {
    const l = { on, down };
    listeners.current.set(pane, l);
    return () => {
      if (listeners.current.get(pane) === l) listeners.current.delete(pane);
    };
  }, []);
}

/** 저절로 하는 크기 맞추기의 실패: 못 하게 막힌 서버(demo, 공개 주소에 열림)면 조용히 넘어가고, 그 밖의 오류만 알린다 */
const quietFit = (e: unknown, show: (msg: string) => void) => {
  if (!(e instanceof ApiError && e.status === 403)) show(errorMessage(e));
};

/** 나란히 보기의 한 칸: 터미널 하나와 그 이름·연결 상태. 누르거나 키보드로 들어오면 입력 대상이 된다 */
function SplitCell({ project: p, pane: x, no, selected, cols, share, span, full, canFit, feed, onSelect, onReconnect, onNotice }: { project: ProjectSnapshot; pane: TmuxPane; no: string; selected: boolean; cols: number; share: number; span: number; full: boolean; canFit: boolean; feed: TermFeed; onSelect: () => void; onReconnect: () => void; onNotice: (msg: string) => void }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [fitError, setFitError] = useState<string | null>(null);
  // 붙어 있는 터미널이 없으면 이 칸 크기에 맞춘다. 칸 배치(전체 화면, 칸 수에 따른 높이·폭)가 바뀌면 다시. 첫 화면이 그려진 뒤에 잰다
  const fittedFor = useRef<string | null>(null);
  const layoutKey = `${full}:${cols}:${share}:${span}`;
  useEffect(() => {
    if (!canFit || !size || fittedFor.current === layoutKey) return;
    const timer = setTimeout(() => {
      fittedFor.current = layoutKey;
      const want = fitSize(viewRef.current, full, share);
      if (want.cols !== size.cols || want.rows !== size.rows) void api.fitPane(p.id, x.id, want).catch((e: unknown) => quietFit(e, setFitError));
    }, 300);
    return () => clearTimeout(timer);
  }, [canFit, size, full, share, layoutKey, p.id, x.id]);
  const live = status === 'live';
  return (
    <div className={selected ? 'split-cell selected' : 'split-cell'} style={span > 1 ? { gridColumn: `span ${span}` } : undefined} onPointerDown={onSelect} onFocusCapture={(e) => {
        // 키보드로 터미널에 들어올 때만 고른다 (칸의 버튼으로 Tab 하면 그 버튼에 포커스를 둔다)
        if (viewRef.current?.contains(e.target as Node)) onSelect();
      }}
    >
      <div className="split-head">
        <span className="dim mono">{no}</span>
        <span className="mono">{progName(x)}</span>
        {fitError && <span className="err">{fitError}</span>}
        <span className={live ? 'conn conn-live' : status === 'down' ? 'conn conn-down' : 'conn'} role="status" title={live ? '실시간' : status}>
          <span className="dot" />
        </span>
        {!live && status !== 'connecting' && (
          <button type="button" className="more-rows" onClick={onReconnect}>
            다시 연결
          </button>
        )}
      </div>
      <div ref={viewRef} className="term-view">
        <Term projectId={p.id} pane={x.id} canInput={p.allowInput} command={x.command} full={full} focus={selected} heightShare={share} feed={feed} onNotice={onNotice} onStatus={setStatus} onSize={(cols, rows) => setSize({ cols, rows })} />
      </div>
    </div>
  );
}

/** 새 터미널 메뉴 폭(px). styles.css 의 .new-term .menu 와 같다 */
const MENU_WIDTH = 150;
/** 나란히 보기의 열 수: 둘이면 2열, 넷까지 2×2, 그보다 많으면 3열 */
const splitCols = (n: number) => (n <= 2 ? n : n <= 4 ? 2 : 3);

export function TerminalTab({ project: p, now }: Props) {
  const t = p.tmux;
  const viewRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // 휴대폰에선 터미널 탭을 열면 터미널 틀을 화면 맨 위로 올린다: 터미널과 입력칸이 한 화면에 들어온다
  // 컴퓨터에선 맨 위로: 터미널 높이를 화면 끝까지로 잡으므로, 다른 프로젝트에서 내려 둔 스크롤이 남으면 아래가 잘린다
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 720px)').matches) frameRef.current?.scrollIntoView?.({ block: 'start' });
    else if (window.matchMedia?.('(pointer: fine)').matches) window.scrollTo({ top: 0 });
  }, []);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  // 고른 pane 이 사라지면 보기는 활성 pane 으로 돌아가지만, 입력은 다시 고를 때까지 막는다 (다른 pane 으로 새지 않게)
  const chosen = t.panes.find((x) => x.id === paneId);
  const lost = paneId !== null && !chosen;
  const pane = chosen ?? t.panes.find((x) => x.active) ?? t.panes[0];
  // 처음 보여 준 pane 에 고정한다: 다른 tmux 클라이언트가 활성 pane 을 바꿔도 입력이 다른 셸로 가지 않게
  useEffect(() => {
    if (paneId === null && pane) setPaneId(pane.id);
  }, [paneId, pane]);
  // 새 터미널: 만든 pane 이 스냅샷에 들어오면 그리로 옮긴다 (그 전에 고르면 "사라진 pane" 으로 보인다)
  const [opening, setOpening] = useState(false);
  // 무엇을 띄울지 고르는 메뉴. 바깥을 누르거나 Esc 면 닫는다
  const [menuOpen, setMenuOpen] = useState(false);
  // 버튼이 터미널 틀 오른쪽 끝 가까이 있으면 메뉴를 오른쪽에 맞춰 펼친다 (틀 밖은 잘린다)
  const [menuRight, setMenuRight] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (opened && t.panes.some((x) => x.id === opened)) {
      setPaneId(opened);
      setOpened(null);
    }
  }, [opened, t.panes]);
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useDismiss(infoRef, showInfo, () => setShowInfo(false));
  const [fitting, setFitting] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');
  // 스트림이 알려 준 pane 크기 (칸·줄)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  // 늘리면 터미널을 새로 붙인다 (끊김·pane 종료 뒤 "다시 연결")
  const [attempt, setAttempt] = useState(0);
  // 전체 화면: 터미널이 창을 다 채우고, 붙은 터미널이 없으면 tmux 크기도 그 화면에 맞춘다
  const [full, setFull] = useState(false);
  // 나란히 보기: 세션의 터미널을 한 화면에 칸으로 나눠 모두 띄운다 (터미널이 둘 이상일 때만).
  // 켠 상태는 프로젝트마다 이 브라우저에 기억한다 (저장소를 못 쓰는 창이면 기억만 안 된다)
  const splitKey = `split:${p.id}`;
  const [split, setSplit] = useState(() => {
    try {
      return localStorage.getItem(splitKey) === '1';
    } catch {
      return false;
    }
  });
  const splitOn = split && t.panes.length > 1;
  const grid = { cols: splitCols(t.panes.length), rows: Math.ceil(t.panes.length / splitCols(t.panes.length)) };
  // 탭이 뒤로 가거나 휴대폰 화면이 꺼지면 터미널 스트림을 닫는다. 서버는 "보고 있는 사람 없음"으로 보고 작업 끝남·입력 대기 알림을 보낸다
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState !== 'hidden');
  // 탭을 앞에 띄워 둔 채 자리를 비워도 마찬가지로 닫는다
  const away = useAway();
  // 나란히 보기의 연결. 다시 연결하면 칸의 터미널도 새로 만들어 첫 화면부터 받는다
  // 입력 허용이 바뀌면 칸의 터미널을 새로 만드므로 연결도 새로 열어 첫 화면을 다시 받는다
  const [feedAttempt, setFeedAttempt] = useState(0);
  const feedKey = `${feedAttempt}:${p.allowInput}`;
  const feed = useSharedFeed(p.id, t.panes.map((x) => x.id).join(','), splitOn && visible && !away, feedKey);
  // 터미널에서 복사·이미지 붙여넣기의 결과를 잠깐 보여 준다
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };
  // 휴대폰은 터미널 글자를 손가락으로 고를 수 없다. 꾹 누른 때의 글을 보통 글로 펼쳐 길게 눌러 골라 복사하게 한다 (pane 을 바꾸면 끝)
  const [picked, setPicked] = useState<{ pane: string; text: string; cols: number } | null>(null);
  const picking = picked !== null && picked.pane === pane?.id;
  // 다른 pane 으로 가면 끝낸다 (돌아왔을 때 예전 글이 새 터미널을 가리지 않게)
  if (picked && !picking) setPicked(null);
  const autoFitted = useRef<string | null>(null);
  // 크기 맞추기는 입력 허용과 상관없다 (글자를 보내지 않는다). 다른 터미널이 붙어 있으면 그 화면까지 바뀌므로 안 한다
  const canFit = t.exists && !t.attached;
  // 붙어 있는 터미널이 없으면, 터미널을 연 화면(휴대폰·컴퓨터) 크기에 pane 을 한 번 맞춘다. 나중에 다른 화면에서 열면 거기에 맞춘다
  useEffect(() => {
    // 나란히 보기에서는 칸마다 맞춘다 (여기서 재면 하나씩 보기 틀이 없어 엉뚱한 크기가 된다)
    if (splitOn || !canFit || !pane || !size || autoFitted.current === pane.id) return;
    // 첫 화면이 그려진 뒤에 재야 실제 칸 폭을 쓴다
    const timer = setTimeout(() => {
      autoFitted.current = pane.id;
      const want = fitSize(viewRef.current, full);
      if (want.cols !== size.cols || want.rows !== size.rows) void api.fitPane(p.id, pane.id, want).catch((e: unknown) => quietFit(e, setFitError));
    }, 300);
    return () => clearTimeout(timer);
  }, [splitOn, canFit, pane, size, full, p.id]);

  if (!t.configured) {
    return (
      <div className="notice">
        <strong>tmux 세션이 등록되지 않았습니다.</strong>
        <p>설정 파일에서 이 프로젝트의 tmux 세션 이름을 지정하면 터미널 출력을 볼 수 있습니다.</p>
      </div>
    );
  }
  if (!t.exists) {
    return (
      <div className="notice error">
        <strong>tmux 세션을 찾을 수 없습니다.</strong>
        <p>
          등록된 세션 <code>{p.tmuxSession}</code> 이(가) 실행 중이 아닙니다.
        </p>
        {t.error && <p className="mono wrap">{t.error}</p>}
        <StartSession projectId={p.id} />
      </div>
    );
  }

  // pane 이 터미널 영역과 크기가 다른지
  const want = fitSize(viewRef.current, full);
  const misfit = size !== null && (size.cols !== want.cols || size.rows !== want.rows);
  const fit = () => {
    if (!pane) return;
    setFitting(true);
    setFitError(null);
    api
      .fitPane(p.id, pane.id, fitSize(viewRef.current, full))
      .catch((e: unknown) => setFitError(errorMessage(e)))
      .finally(() => setFitting(false));
  };

  const openTerminal = (agent?: AgentKind) => {
    setMenuOpen(false);
    setOpening(true);
    api
      .newWindow(p.id, agent)
      .then((r) => setOpened(r.pane))
      .catch((e: unknown) => showNotice(errorMessage(e)))
      .finally(() => setOpening(false));
  };

  const closePane = (x: TmuxPane) => {
    if (!window.confirm(`터미널 ${paneNo(x, t.panes)} (${progName(x)}) 을 닫을까요?\n안에서 돌던 프로그램도 종료됩니다.`)) return;
    api
      .closePane(p.id, x.id)
      // 닫은 터미널을 아직 보고 있으면 남은 것으로 옮긴다 (그대로 두면 "사라진 pane" 으로 입력이 막힌다).
      // 응답을 기다리는 사이에 다른 터미널을 골랐으면 그대로 둔다
      .then(() => setPaneId((cur) => (cur === x.id ? (t.panes.find((y) => y.id !== x.id)?.id ?? null) : cur)))
      .catch((e: unknown) => showNotice(errorMessage(e)));
  };

  const copy = (cmd: string) => {
    setCopyMsg(copyText(cmd) ? '복사됨' : '복사 실패');
    setTimeout(() => setCopyMsg(null), 1500);
  };

  const live = status === 'live';
  // 화면이 안 보이거나 자리를 비운 동안: 연결을 쉰다. 마우스·키를 움직이면 다시 붙는다
  const pausedText = away ? '자리를 비운 동안 연결을 쉬는 중입니다. 마우스나 키를 움직이면 다시 연결합니다.' : '화면이 보이지 않아 연결을 쉬는 중입니다.';
  const statusLabel = status === 'live' ? '실시간' : status === 'connecting' ? '연결 중' : status === 'down' ? '연결 끊김 · 재연결 중' : status === 'exit' ? 'pane 종료' : status;

  const waiting = t.waitingPrompt !== null && (
    <div className="notice waiting" role="status">
      <strong>에이전트가 입력을 기다리고 있습니다.</strong>
      <p className="mono wrap">{t.waitingPrompt}</p>
      <QuickAnswers project={p} />
    </div>
  );
  // 컴퓨터에선 입력 대기 안내를 터미널 아래에 둔다: 위에 끼면 터미널이 밀려 입력 줄이 화면 밖으로 나간다 (거기선 터미널에 바로 친다)
  const waitingBelow = finePointer();
  // 세션 정보: 버튼이 있으면 터미널 위에 떠서 펼친다 (터미널 크기·자리를 바꾸지 않게). 버튼이 없으면(pane 없음) 펼쳐 둔다
  const info = (
    <div className={pane ? 'term-info pop' : 'term-info'} ref={infoRef} style={pane ? { top: (barRef.current?.offsetHeight ?? 46) + 6 } : undefined}>
      {t.attachCommand && (
        <div className="cmdline">
          <code>{t.attachCommand}</code>
          <button type="button" onClick={() => copy(t.attachCommand!)}>
            {/* 알림 영역은 그대로 두고 안쪽 글자만 바꿔 그린다: 낭독기가 변화를 읽고, 등장 전환도 걸린다 */}
            <span aria-live="polite">
              <span key={copyMsg ?? '복사'} className="swap">
                {copyMsg ?? '복사'}
              </span>
            </span>
          </button>
        </div>
      )}
      <dl className="kv inline">
        <dt>세션</dt>
        <dd>{p.tmuxSession}</dd>
        <dt>생성 시각</dt>
        <dd>{dateTime(t.createdAt)}</dd>
        <dt>외부 터미널 연결</dt>
        <dd>{t.attached ? '예' : '아니오'}</dd>
        <dt>마지막 출력 변경</dt>
        <dd>
          {relTime(t.lastOutputChangeAt ?? t.lastActivityAt, now)}
          <span className="dim"> ({dateTime(t.lastOutputChangeAt ?? t.lastActivityAt)})</span>
        </dd>
      </dl>
    </div>
  );

  return (
    <>
      {!waitingBelow && waiting}
      {!pane && info}
      {t.error && <p className="err mono wrap">{t.error}</p>}
      <div className="term-wrap">
        {/* 터미널 틀 밖에 띄운다: 틀은 넘치는 것을 자르고 글자색을 어둡게 고정한다. 자리는 바 바로 아래 (바가 몇 줄이든) */}
        {pane && showInfo && info}
        <div className={full ? 'term-frame full' : 'term-frame'} ref={frameRef}>
          {pane && (
            <div className="term-bar" ref={barRef}>
              {(t.panes.length > 1 || lost || p.allowInput) && (
                <div className="panes" role="group" aria-label="pane 선택">
                  {t.panes.map((x) => (
                    <span key={x.id} className="pane-tab">
                      <button type="button" aria-pressed={!lost && x.id === pane.id} onClick={() => setPaneId(x.id)}>
                        <span className="dim">{paneNo(x, t.panes)}</span> {progName(x)}
                      </button>
                      {/* 마지막 하나는 닫으면 세션이 끝나므로 세션 종료 버튼에 맡긴다 */}
                      {t.panes.length > 1 && (
                        <button type="button" className="close" aria-label={`터미널 ${paneNo(x, t.panes)} 닫기`} title="이 터미널 닫기" onClick={() => closePane(x)}>
                          ✕
                        </button>
                      )}
                    </span>
                  ))}
                  {p.allowInput && (
                    <span className="new-term" ref={menuRef}>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        disabled={opening}
                        title="이 세션에 터미널을 하나 더 엽니다"
                        onClick={(e) => {
                          const frame = frameRef.current?.getBoundingClientRect();
                          setMenuRight(frame !== undefined && e.currentTarget.getBoundingClientRect().left + MENU_WIDTH > frame.right);
                          setMenuOpen(!menuOpen);
                        }}
                      >
                        {opening ? '여는 중…' : '+ 새 터미널'}
                      </button>
                      {menuOpen && (
                        <span className={menuRight ? 'menu right' : 'menu'} role="menu">
                          {AGENTS.map(([value, label]) => (
                            <button key={value} type="button" role="menuitem" onClick={() => openTerminal(value || undefined)}>
                              {label}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}
              {/* 누르는 순간 '바깥 누름'으로 닫히지 않게 */}
              <button type="button" className="more-rows info-toggle" aria-expanded={showInfo} onPointerDown={(e) => e.stopPropagation()} onClick={() => setShowInfo(!showInfo)}>
                세션 정보
              </button>
              {/* 붙어 있는 터미널이 없는 세션만: 이 화면 크기로 맞춘다 (붙어 있으면 그 터미널까지 바뀐다) */}
              {!splitOn && canFit && misfit && (
                <button type="button" className="more-rows" disabled={fitting} onClick={fit} title="tmux 화면을 이 터미널 영역 크기로 바꿉니다">
                  화면에 맞추기
                </button>
              )}
              {/* 크기를 못 바꾸는 세션에서 tmux 창이 화면보다 크면 글자가 작아진 까닭을 알린다 */}
              {!splitOn && !canFit && size && (size.cols > want.cols || size.rows > want.rows) && (
                <span className="dim" title="다른 터미널이 붙어 있는 세션이라 tmux 창 크기를 바꾸지 않습니다 (바꾸면 그 터미널 화면까지 바뀝니다)">
                  tmux 창 {size.cols}×{size.rows}이 화면보다 커서 글자를 줄여 보여 줍니다
                </span>
              )}
              {fitError && (
                <span className="err" role="alert">
                  {fitError}
                </span>
              )}
              {notice && (
                <span className="dim" role="status">
                  {notice}
                </span>
              )}
              {!splitOn && (
                <span className={live ? 'conn conn-live' : status === 'down' ? 'conn conn-down' : 'conn'} role="status">
                  <span className="dot" />
                  {statusLabel}
                </span>
              )}
              {t.panes.length > 1 && (
                <button
                  type="button"
                  className="more-rows split-toggle"
                  aria-pressed={splitOn}
                  onClick={() => {
                    // 하나씩 보기로 돌아가면 고른 터미널을 다시 이 화면 크기에 맞춘다
                    autoFitted.current = null;
                    setSplit(!splitOn);
                    try {
                      localStorage.setItem(splitKey, splitOn ? '0' : '1');
                    } catch {
                      // 기억하지 못해도 지금 화면은 바뀐다
                    }
                  }}
                >
                  나란히 보기
                </button>
              )}
              <button
                type="button"
                className="more-rows full-toggle"
                aria-pressed={full}
                onClick={() => {
                  const next = !full;
                  setFull(next);
                  // 바뀐 틀이 그려진 뒤에 재서 맞춘다
                  if (!splitOn && canFit && pane) requestAnimationFrame(() => void api.fitPane(p.id, pane.id, fitSize(viewRef.current, next)).catch((e: unknown) => setFitError(errorMessage(e))));
                }}
              >
                {full ? '전체 화면 끝내기' : '전체 화면'}
              </button>
              {!splitOn && status !== 'live' && status !== 'connecting' && (
                <button type="button" className="more-rows" onClick={() => setAttempt(attempt + 1)}>
                  다시 연결
                </button>
              )}
            </div>
          )}
          {splitOn ? (
            <div className="split" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
              {visible && !away ? (
                t.panes.map((x, i) => (
                  // 마지막 줄이 덜 차면 마지막 칸이 남은 자리를 채운다. 크기 맞추기는 윈도우 단위라, 한 윈도우를 나눈 pane 들은 맞추지 않는다
                  <SplitCell key={`${x.id}:${feedKey}`} project={p} pane={x} no={paneNo(x, t.panes)} selected={!lost && x.id === pane?.id} cols={grid.cols} share={1 / grid.rows} span={i === t.panes.length - 1 ? grid.cols * grid.rows - t.panes.length + 1 : 1} full={full} canFit={canFit && !t.panes.some((y) => y.window === x.window && y.id !== x.id)} feed={feed} onSelect={() => setPaneId(x.id)} onReconnect={() => setFeedAttempt(feedAttempt + 1)} onNotice={showNotice} />
                ))
              ) : (
                <p className="dim term-paused">{pausedText}</p>
              )}
            </div>
          ) : (
            <div ref={viewRef} className={picking ? 'term-view picking' : 'term-view'}>
              {pane ? (
                visible && !away ? (
                  <>
                    {/* 터미널은 숨겨 두기만 해서 돌아가도 다시 연결하지 않는다 */}
                    {picking && <PickText text={picked.text} cols={picked.cols} onDone={() => setPicked(null)} />}
                    <Term key={`${pane.id}:${attempt}`} projectId={p.id} pane={pane.id} canInput={p.allowInput && !lost} command={pane.command} full={full} onPick={(text, cols) => setPicked({ pane: pane.id, text, cols })} onNotice={showNotice} onStatus={setStatus} onSize={(cols, rows) => setSize({ cols, rows })} />
                  </>
                ) : (
                  <p className="dim term-paused">{pausedText}</p>
                )
              ) : (
                <pre className="terminal" tabIndex={0} aria-label="최근 터미널 출력">
                  {t.output.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
      {waitingBelow && waiting}
      {pane &&
        (p.allowInput ? (
          <InputBar projectId={p.id} pane={lost ? null : pane} targetNo={t.panes.length > 1 ? paneNo(pane, t.panes) : null} />
        ) : (
          <p className="hint">{p.id.startsWith('tmux:') ? '입력을 보내려면 먼저 위의 "프로젝트로 등록"으로 등록한 뒤, 설정에서 "터미널 입력 허용"을 켜세요.' : '입력을 보내려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.'}</p>
        ))}
    </>
  );
}

const COMMITS_SHOWN = 10;
function Commits({ commits, now, empty }: { commits: Commit[]; now: string; empty: string }) {
  const [all, setAll] = useState(false);
  if (commits.length === 0) return <p className="dim">{empty}</p>;
  const hidden = commits.length - COMMITS_SHOWN;
  return (
    <>
      <ul className="rows commits">
        {(all ? commits : commits.slice(0, COMMITS_SHOWN)).map((c) => (
          <li key={c.hash}>
            <span className="hash">{c.hash.slice(0, 7)}</span>
            <span className="grow wrap subject">{c.subject}</span>
            <span className="dim nowrap" title={dateTime(c.date)}>
              {c.author} · {relTime(c.date, now)}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="more-rows" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '접기' : `${hidden}개 더 보기`}
        </button>
      )}
    </>
  );
}

function FilePath({ file }: { file: { path: string; from?: string } }) {
  return (
    <span className="grow wrap">
      {file.from && <span className="dim">{file.from} → </span>}
      {file.path}
    </span>
  );
}

/** 변경 파일 목록은 이만큼만 먼저 보여 준다 (수십 개면 휴대폰에서 화면 수십 장이 된다) */
const FILES_SHOWN = 15;

function Stats({ files, additions, deletions, empty }: { files: FileStat[]; additions: number; deletions: number; empty: string }) {
  const [all, setAll] = useState(false);
  if (files.length === 0) return <p className="dim">{empty}</p>;
  const hidden = files.length - FILES_SHOWN;
  return (
    <>
      <ul className="rows">
        {(all ? files : files.slice(0, FILES_SHOWN)).map((f) => (
          <li key={f.path}>
            <FilePath file={f} />
            {f.untracked && <span className="new-mark">new</span>}
            <span className="add">+{f.additions}</span>
            <span className="del">−{f.deletions}</span>
          </li>
        ))}
        <li className="total">
          <span className="grow">합계 · 파일 {files.length}개</span>
          <span className="add">+{additions}</span>
          <span className="del">−{deletions}</span>
        </li>
      </ul>
      {hidden > 0 && (
        <button type="button" className="more-rows" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '접기' : `파일 ${hidden}개 더 보기`}
        </button>
      )}
    </>
  );
}

export function GitTab({ project: p, now }: Props) {
  // 실시간 스냅샷의 기준점 정보는 목록이 빠진 요약이고 (partial), 변경 파일이 많으면 그 목록도 잘려 있다 (cut).
  // 탭을 열거나 Git 이나 잘린 목록이 바뀌면 전체를 받는다
  const cut = p.git.cut?.key;
  const [full, setFull] = useState<ProjectSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!p.since?.partial && !cut) return;
    let live = true;
    api.project(p.id).then(
      (x) => {
        if (!live) return;
        setFull(x);
        setLoadError(null);
      },
      (e: unknown) => live && setLoadError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [p.id, p.lastGitChangeAt, p.since?.partial, p.since?.baseline.at, cut, retry]);
  const since = p.since?.partial ? (full?.since ?? null) : p.since;
  // 받은 것에서는 잘린 목록만 쓴다 (나머지는 실시간 스냅샷이 더 새롭다: 자정이 지나면 바뀌는 오늘 커밋 등)
  const git = cut && full ? { ...p.git, changedFiles: full.git.changedFiles, diffStat: full.git.diffStat } : p.git;
  return (
    <>
      {git.ok ? (
        <>
          <dl className="kv inline">
            <dt>브랜치</dt>
            <dd>{git.branch}</dd>
            <dt>HEAD</dt>
            <dd>{git.head?.slice(0, 7) ?? '—'}</dd>
            <dt>작업 트리</dt>
            <dd className={git.clean ? 'ok' : 'warn'}>{git.clean ? '변경 없음 (clean)' : '변경 있음 (dirty)'}</dd>
            <dt>마지막 Git 변경</dt>
            <dd>{relTime(p.lastGitChangeAt, now)}</dd>
          </dl>

          <section>
            <h3>변경된 파일 ({git.cut?.total ?? git.changedFiles.length})</h3>
            {git.changedFiles.length === 0 ? (
              <p className="dim">변경된 파일이 없습니다.</p>
            ) : (
              <ul className="rows">
                {git.changedFiles.map((f) => (
                  <li key={f.path}>
                    <span className="xy">{f.status}</span>
                    <FilePath file={f} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Diff stat (HEAD 대비)</h3>
            <Stats files={git.diffStat} additions={git.additions} deletions={git.deletions} empty="diff 가 없습니다." />
          </section>

          <section>
            <h3>최근 커밋</h3>
            <Commits commits={git.recentCommits.slice(0, 10)} now={now} empty="커밋이 없습니다." />
          </section>

          <section>
            <h3>오늘 커밋 ({git.todayCommits.length})</h3>
            <Commits commits={git.todayCommits} now={now} empty="오늘 커밋이 없습니다." />
          </section>
        </>
      ) : git.error === NOT_A_REPO ? (
        // tmux 만 감시하는 프로젝트도 있다. 오류가 아니다
        <div className="notice">
          <strong>연결된 Git 저장소가 없습니다.</strong>
          <p>터미널 감시는 계속됩니다.</p>
        </div>
      ) : (
        <div className="notice error">
          <strong>Git 정보를 읽을 수 없습니다.</strong>
          <p className="mono wrap">{git.error ?? '알 수 없는 오류'}</p>
        </div>
      )}

      {loadError && (
        <p className="err" role="alert">
          전체 목록을 불러오지 못했습니다: {loadError}{' '}
          <button type="button" className="more-rows" onClick={() => setRetry(retry + 1)}>
            다시 불러오기
          </button>
        </p>
      )}
      {since && (
        <section>
          <h3>모니터링 시작 이후</h3>
          <dl className="kv inline">
            <dt>기준 시각</dt>
            <dd>{dateTime(since.baseline.at)}</dd>
            <dt>기준 브랜치</dt>
            <dd>{since.baseline.branch}</dd>
            <dt>기준 HEAD</dt>
            <dd>{since.baseline.head?.slice(0, 7) ?? '—'}</dd>
          </dl>
          <h4>커밋 ({since.commits.length})</h4>
          <Commits commits={since.commits} now={now} empty="기준점 이후 커밋이 없습니다." />
          <h4>변경 파일</h4>
          <Stats files={since.files} additions={since.additions} deletions={since.deletions} empty="기준점 이후 변경된 파일이 없습니다." />
        </section>
      )}

      {p.logErrors.length > 0 && (
        <section id="log-errors">
          <h3 className="err">로그 오류 ({p.logErrors.length})</h3>
          <p className="hint">확인 처리는 화면 위쪽의 "로그 오류 확인 완료"에서 합니다.</p>
          {p.logFile && <p className="mono dim wrap">{p.logFile}</p>}
          <pre className="output err-output">{p.logErrors.join('\n')}</pre>
        </section>
      )}
    </>
  );
}

function Verdict({ run }: { run: RunSummary }) {
  if (run.canceled) return <span className="dim">취소됨</span>;
  if (run.timedOut) return <span className="err">시간 초과</span>;
  return run.exitCode === 0 ? <span className="ok">성공</span> : <span className="err">실패</span>;
}

export function RunPanel({ project: p, kind, title }: { project: ProjectSnapshot; kind: RunKind; title: string }) {
  const command = kind === 'test' ? p.testCommand : p.buildCommand;
  const run = p.runs[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run?.running ?? false;
  // 요청이 받아들여진 뒤 다음 스냅샷이 오기 전까지의 표시. 실행 상태가 바뀌면(또는 10초 뒤) 지운다
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => setPending(null), [running, run?.startedAt]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 10_000);
    return () => clearTimeout(timer);
  }, [pending]);

  const history = p.history[kind];
  // 스냅샷에는 출력의 끝부분만 온다. 펼치면 전체를 받아 같은 실행인 동안 보여 준다
  const [full, setFull] = useState<RunResult | null>(null);
  const shown = full && run && full.startedAt === run.startedAt ? full : run;
  const loadFull = () => {
    setBusy(true);
    setError(null);
    api
      .runOutput(p.id, kind)
      .then(setFull, (e: unknown) => setError(`전체 출력을 불러오지 못했습니다: ${errorMessage(e)}`))
      .finally(() => setBusy(false));
  };

  const request = (action: typeof api.run, label: string) => {
    setBusy(true);
    setError(null);
    action(p.id, kind)
      .then(
        () => setPending(`${label} 요청함…`),
        (e: unknown) => setError(`${label} 요청 실패: ${errorMessage(e)}`),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="run">
      <h3>{title}</h3>
      <div className="cmdline">
        {command ? <code>{command}</code> : <span className="dim grow">명령이 설정되지 않았습니다</span>}
        <button type="button" onClick={() => request(api.run, '실행')} disabled={!command || busy || running || pending !== null}>
          {running ? '실행 중…' : '실행'}
        </button>
        {running && (
          <button type="button" onClick={() => request(api.cancelRun, '취소')} disabled={busy || pending !== null}>
            취소
          </button>
        )}
      </div>
      {(busy || pending) && (
        <p className="hint" role="status">
          {pending ?? '요청 보내는 중…'}
        </p>
      )}
      {!command && <p className="hint">설정 파일에 이 프로젝트의 {title} 명령을 등록하면 실행할 수 있습니다.</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {!run ? (
        <p className="dim">아직 실행 기록이 없습니다.</p>
      ) : (
        <>
          <dl className="kv inline">
            <dt>결과</dt>
            <dd>{run.running ? <span className="warn">실행 중…</span> : <Verdict run={run} />}</dd>
            <dt>종료 코드</dt>
            <dd>{run.exitCode ?? '—'}</dd>
            <dt>소요 시간</dt>
            <dd>{duration(run.durationMs)}</dd>
            <dt>시작 시각</dt>
            <dd>{dateTime(run.startedAt)}</dd>
            <dt>실행한 명령</dt>
            <dd className="wrap">{run.command}</dd>
          </dl>
          {shown?.truncated && (
            <p className="hint">
              출력이 길어 끝부분만 보여 줍니다.{' '}
              <button type="button" onClick={loadFull} disabled={busy}>
                전체 출력 보기
              </button>
            </p>
          )}
          <h4>stdout</h4>
          <pre className="output" tabIndex={0}>
            {shown?.stdout ? <AnsiText text={shown.stdout} /> : '(비어 있음)'}
          </pre>
          <h4>stderr</h4>
          <pre className="output err-output" tabIndex={0}>
            {shown?.stderr ? <AnsiText text={shown.stderr} /> : '(비어 있음)'}
          </pre>
        </>
      )}
      {history.length > 0 && (
        <>
          <h4>실행 이력 ({history.length})</h4>
          <table className="history">
            <thead>
              <tr>
                <th>시작 시각</th>
                <th>결과</th>
                <th>종료 코드</th>
                <th>소요 시간</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.startedAt}-${i}`}>
                  <td>{dateTime(h.startedAt)}</td>
                  <td>
                    <Verdict run={h} />
                  </td>
                  <td>{h.exitCode ?? '—'}</td>
                  <td>{duration(h.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
