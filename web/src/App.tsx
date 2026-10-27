import { useEffect, useState, useSyncExternalStore } from 'react';
import { GearSix, GitBranch, GitCommit, MoonStars, SquaresFour, Sun, TerminalWindow } from '@phosphor-icons/react';
import type { ProjectSnapshot, Snapshot } from '../../shared/types.ts';
import { NOT_A_REPO } from '../../shared/types.ts';
import { api, DOWN_GRACE_MS, errorMessage } from './api.ts';
import { dateTime, relTime, STATE_LABEL } from './format.ts';
import { Badge, ProjectDetail, QuickAnswers, Reasons } from './ProjectDetail.tsx';
import { NewSession } from './NewSession.tsx';
import { Settings } from './Settings.tsx';

type Conn = 'connecting' | 'live' | 'down';

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
const getHash = () => window.location.hash;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 마지막으로 일한 시각: 화면 출력과 Git(파일 변경·커밋) 중 늦게 바뀐 것. 둘 다 모르면 tmux 의 활동 시각.
 * 에이전트 세션은 화면 대신 작업 중 표시를 마지막으로 띄운 때를 본다 (스크롤해 보기만 해도 화면은 바뀐다)
 */
const lastActivity = (p: ProjectSnapshot): string | null => {
  const out = p.tmux.lastBusyAt ?? p.tmux.lastOutputChangeAt;
  const git = p.lastGitChangeAt;
  if (out && git) return Date.parse(git) > Date.parse(out) ? git : out;
  return out ?? git ?? p.tmux.lastActivityAt;
};
const URGENCY: Record<ProjectSnapshot['status']['state'], number> = { error: 0, waiting: 1, stalled: 2, running: 3, idle: 4 };
// 일하는 중인 것끼리는 시각이 갱신마다 앞서거니 뒤서거니 해 자리가 뒤섞이므로 같게 보고 설정 순서 그대로 둔다
const recency = (p: ProjectSnapshot) => (p.status.state === 'running' ? 0 : Date.parse(lastActivity(p) ?? '') || 0);
/** 봐야 할 것부터(오류·입력 대기·정지 의심 → 작업 중 → 유휴), 같은 상태끼리는 최근에 일한 것부터 */
const byAttention = (projects: ProjectSnapshot[]) => projects.toSorted((a, b) => URGENCY[a.status.state] - URGENCY[b.status.state] || recency(b) - recency(a));

type Theme = 'dark' | 'light';
const storedTheme = (): Theme => (localStorage.getItem('theme') === 'light' ? 'light' : 'dark');
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function App() {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(storedTheme);

  // 테마는 <html data-theme> 로 적용하고 기억한다. 바꾸는 0.6초 동안만 .theming 으로 색 전환을 켠다
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  const toggleTheme = () => {
    const root = document.documentElement;
    root.classList.add('theming');
    setTimeout(() => root.classList.remove('theming'), 650);
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  // 탭 제목에 봐야 할 프로젝트 수: 다른 탭에 있어도 "(2) NightShift" 로 보인다
  const attention = snapshot ? snapshot.summary.waiting + snapshot.summary.error + snapshot.summary.stalled : 0;
  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) NightShift` : 'NightShift';
  }, [attention]);

  // 배경의 빛이 마우스를 살짝 따라온다 (움직임 줄이기면 끈다)
  useEffect(() => {
    if (reduceMotion()) return;
    const onMove = (e: PointerEvent) => {
      const root = document.documentElement.style;
      root.setProperty('--mx', ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      root.setProperty('--my', ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let downTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(downTimer);
      downTimer = undefined;
    };
    // 잠깐의 끊김은 알리지 않는다. 이만큼 지나도 다시 붙지 못할 때만 끊김을 띄운다
    const arm = () => (downTimer ??= setTimeout(() => setConn('down'), DOWN_GRACE_MS));

    api.snapshot().then(
      (s) => {
        if (alive) setSnapshot((prev) => prev ?? s);
      },
      (e: unknown) => {
        if (alive) setLoadError(errorMessage(e));
      },
    );

    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        settle();
        setConn('live');
      };
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          setSnapshot(JSON.parse(ev.data) as Snapshot);
          setLoadError(null);
        } catch {
          // 깨진 메시지는 버리고 다음 스냅샷을 기다린다
        }
      };
      es.onerror = () => {
        arm();
        // EventSource 는 네트워크 오류면 스스로 재연결하지만, HTTP 오류 응답이면 영구히 닫힌다
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();
    // 브라우저로 돌아왔는데 연결이 살아 있지 않으면 브라우저의 재연결(몇 초 뒤)을 기다리지 않고 바로 다시 붙는다.
    // 숨어 있는 동안 띄운 끊김은 거두고 처음부터 다시 기다린다 (숨은 동안은 연결이 끊기는 게 정상이다)
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || es?.readyState === EventSource.OPEN) return;
      clearTimeout(retry);
      settle();
      arm();
      setConn((c) => (c === 'down' ? 'connecting' : c));
      es?.close();
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      clearTimeout(retry);
      settle();
      document.removeEventListener('visibilitychange', onVisible);
      es?.close();
    };
  }, []);

  const path = hash.replace(/^#/, '') || '/';
  const isSettings = path === '/settings';
  // #/project/<id>/<탭>: 탭은 ProjectDetail 이 읽는다
  const projectId = path.startsWith('/project/') ? safeDecode(path.slice('/project/'.length).split('/')[0]!) : null;

  let page;
  if (isSettings) {
    page = <Settings />;
  } else if (!snapshot) {
    page = loadError ? (
      <div className="notice error" role="alert">
        <strong>서버에서 상태를 가져오지 못했습니다.</strong>
        <p>{loadError}</p>
        <p className="dim">NightShift 서버가 실행 중인지 확인하세요. 연결되면 자동으로 표시됩니다.</p>
      </div>
    ) : (
      <div className="notice">불러오는 중…</div>
    );
  } else if (projectId !== null) {
    const project = snapshot.projects.find((p) => p.id === projectId);
    page = project ? (
      <ProjectDetail key={project.id} project={project} now={snapshot.generatedAt} refreshSec={snapshot.refreshIntervalSec} />
    ) : (
      <div className="notice error">
        <strong>프로젝트를 찾을 수 없습니다.</strong>
        <p className="mono">{projectId}</p>
        <p>
          <a href="#/">← 대시보드로</a>
        </p>
      </div>
    );
  } else {
    page = <Dashboard snapshot={snapshot} />;
  }

  return (
    <div className="shell">
      <div className="sky" aria-hidden="true">
        <i />
        <i />
      </div>
      <div className="hud" aria-hidden="true">
        <span className="hud-tag">NIGHTSHIFT // v{__APP_VERSION__}</span>
      </div>
      <aside className="side">
        <a className="wordmark" href="#/">
          <MoonStars size={20} weight="fill" aria-hidden="true" />
          NightShift
          {snapshot?.demo && <span className="demo-badge">DEMO</span>}
        </a>
        <nav aria-label="주 메뉴">
          <a href="#/" aria-current={!isSettings && projectId === null ? 'page' : undefined}>
            <SquaresFour size={16} aria-hidden="true" />
            대시보드
          </a>
          <a href="#/settings" aria-current={isSettings ? 'page' : undefined}>
            <GearSix size={16} aria-hidden="true" />
            설정
          </a>
        </nav>
        {/* 어느 화면에서든 바로 넘어갈 수 있는 프로젝트 목록. 상태 점으로 한눈에 훑고, 정상이 아니면 글자로도 적는다 */}
        {snapshot && snapshot.projects.length > 0 && (
          <div className="side-list" role="navigation" aria-label="프로젝트">
            <h4>프로젝트</h4>
            {byAttention(snapshot.projects).map((p) => (
              <a key={p.id} className={`side-item state-${p.status.state}`} href={`#/project/${encodeURIComponent(p.id)}`} aria-current={p.id === projectId ? 'page' : undefined} title={p.status.reasons[0]}>
                <span className="dot" aria-hidden="true" />
                <span className="clip">{p.name}</span>
                <span className={p.status.state === 'running' ? 'sr-only' : 'side-state'}>{STATE_LABEL[p.status.state]}</span>
                <span className="end">{relTime(lastActivity(p), snapshot.generatedAt)}</span>
              </a>
            ))}
          </div>
        )}
        <div className="side-foot">
          <span className={`conn conn-${conn}`} role="status">
            <span className="dot" aria-hidden="true" />
            {conn === 'live' ? '서버 연결됨' : conn === 'down' ? '연결 끊김 · 재연결 중' : '연결 중'}
          </span>
          {snapshot && <span>마지막 갱신 {dateTime(snapshot.generatedAt)}</span>}
          <button type="button" className="theme" onClick={toggleTheme} aria-label={theme === 'dark' ? '밝은 테마로' : '어두운 테마로'}>
            {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <MoonStars size={14} aria-hidden="true" />}
            {theme === 'dark' ? '밝게' : '어둡게'}
          </button>
        </div>
      </aside>
      <main>
        <div className="page">
          {snapshot?.configError != null && <ConfigErrorBanner message={snapshot.configError} />}
          {/* 끊긴 동안의 화면은 멈춘 사진이다. 가장 작은 글씨로만 알리지 않고 본문 위에 크게 적는다 */}
          {conn === 'down' && (
            <div className="notice error banner" role="alert">
              <strong>서버와 연결이 끊겼습니다. 다시 연결하는 중…</strong>
              {snapshot && <p>지금 보이는 내용은 {dateTime(snapshot.generatedAt)} 기준이며 더 갱신되지 않았습니다.</p>}
            </div>
          )}
          {page}
        </div>
      </main>
    </div>
  );
}

export function ConfigErrorBanner({ message }: { message: string }) {
  return (
    <div className="notice error banner" role="alert">
      <strong>config 를 다시 읽지 못했습니다. 이전 설정으로 동작 중입니다.</strong>
      <p className="mono pre-wrap">{message}</p>
    </div>
  );
}

export function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.summary;
  // 상태 타일을 누르면 그 상태의 줄만 남는다. 다시 누르거나 "전체 보기"를 누르면 전체.
  const [filter, setFilter] = useState<string | null>(null);
  // 방금 숨긴 미등록 세션. 몇 초 동안 "실행 취소"를 띄운다
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (hidden === null) return;
    const t = setTimeout(() => setHidden(null), 8000);
    return () => clearTimeout(t);
  }, [hidden]);
  const undoHide = (name: string) => {
    setHidden(null);
    api.unhideSession(name).catch((e: unknown) => window.alert(`숨김 취소 실패: ${errorMessage(e)}`));
  };
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = () => {
    if (!window.confirm('새 모니터링 세션을 시작할까요?\n"모니터링 시작 이후" 기준점(커밋·변경 기준점)이 지금 시점으로 초기화됩니다.')) return;
    setResetting(true);
    setResetError(null);
    api
      .resetSession()
      .catch((e: unknown) => setResetError(errorMessage(e)))
      .finally(() => setResetting(false));
  };
  // 0 인 상태는 보여 주지 않는다. 문제가 있을 때만 그 상태가 줄에 나타난다. 고른 타일은 0 이 되어도 남겨 둔다.
  const states: [string, number, string][] = [
    ['정상 실행', s.running, 'running'],
    ['입력 대기', s.waiting, 'waiting'],
    ['유휴', s.idle, 'idle'],
    ['정지 의심', s.stalled, 'stalled'],
    ['오류', s.error, 'error'],
  ];
  const active = states.filter(([, value, state]) => value > 0 || state === filter);
  const filterLabel = states.find(([, , state]) => state === filter)?.[0];
  const shown = byAttention(filter ? snapshot.projects.filter((p) => p.status.state === filter) : snapshot.projects);
  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">SYS.MONITOR // OVERVIEW</span>
          <h1>대시보드</h1>
          <div className="meta">
            <span>
              모니터링 시작 {dateTime(snapshot.startedAt)} ({relTime(snapshot.startedAt, snapshot.generatedAt)})
            </span>
            <span>갱신 주기 {snapshot.refreshIntervalSec}초</span>
            <button type="button" onClick={reset} disabled={resetting} title="모니터링 시작 이후 기준점(커밋·변경)을 지금으로 초기화합니다">
              모니터링 새로 시작
            </button>
            {resetError && (
              <span className="err" role="alert">
                세션 초기화 실패: {resetError}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="overview">
        <span className="stat">
          프로젝트 <span className="num">{s.total}</span>
        </span>
        <span className="stat">
          실행 중인 세션 <span className="num">{s.sessionsRunning}</span>
        </span>
        {active.map(([label, value, state]) => (
          <button key={state} type="button" className={`stat state-${state}`} aria-pressed={filter === state} title={filter === state ? '전체 보기' : `${label} 프로젝트만 보기`} onClick={() => setFilter(filter === state ? null : state)}>
            {label}
            <span className="num">{value}</span>
          </button>
        ))}
        {filter && (
          <button type="button" className="show-all" onClick={() => setFilter(null)}>
            전체 보기
          </button>
        )}
        {/* 새 세션은 대시보드의 주 동작이라 요약 줄 오른쪽 끝에 둔다 */}
        {!snapshot.demo && (
          <div className="dash-new">
            <NewSession />
          </div>
        )}
      </div>
      {snapshot.projects.length === 0 ? (
        <div className="notice board-empty">
          <strong>등록된 프로젝트가 없습니다.</strong>
          {snapshot.configMissing && (
            <p className="warn">
              설정 파일이 없습니다: <code>{snapshot.configPath}</code>
            </p>
          )}
          <p>돌고 있는 tmux 세션은 여기에 자동으로 나타납니다. "등록"을 누르면 프로젝트가 되고 설정 파일이 만들어집니다.</p>
          <p>
            아직 세션이 없으면 위의 "+ tmux 세션 만들기"로 시작하세요. 먼저 둘러보려면 <code>npm run demo</code> 로 데모 모드를 실행할 수 있습니다.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <div className="notice board-empty">현재 {filterLabel} 프로젝트가 없습니다.</div>
      ) : (
        <div className="board">
          {shown.map((p) => (
            <ProjectCard key={p.id} p={p} now={snapshot.generatedAt} onHidden={setHidden} />
          ))}
        </div>
      )}
      {hidden !== null && (
        <div className="toast" role="status">
          <span>
            <span className="mono">{hidden}</span> 세션을 숨겼습니다
          </span>
          <button type="button" onClick={() => undoHide(hidden)}>
            실행 취소
          </button>
        </div>
      )}
    </>
  );
}

/** 설정에 없는 tmux 세션 줄의 "미등록 세션" 표시와 등록·숨김 버튼. 카드 링크 위에 떠 있는 형제라 클릭이 링크로 새지 않는다. */
function DiscoveredActions({ p, onHidden }: { p: ProjectSnapshot; onHidden?: (session: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const session = p.tmuxSession ?? p.name;
  return (
    <span className="discovered">
      <span className="dim" title="설정에 없는 tmux 세션. 세션이 닫히면 이 줄도 사라집니다">
        미등록 세션
      </span>
      <button type="button" disabled={busy} title="이 세션을 지금 경로로 프로젝트에 등록합니다" onClick={act(() => api.createSession({ name: session, repoPath: p.repoPath, tmuxSession: session, allowInput: false }))}>
        등록
      </button>
      <button type="button" disabled={busy} title="대시보드에서 숨깁니다. 설정 화면의 숨긴 세션 목록에서도 되돌릴 수 있습니다" onClick={act(() => api.hideSession(session).then(() => onHidden?.(session)))}>
        숨김
      </button>
    </span>
  );
}

/** 카드 안 줄의 이름표: 눈에는 아이콘만, 낭독기에는 글자 */
const Lbl = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <span className="lbl" title={text}>
    <span aria-hidden="true">{icon}</span>
    <span className="sr-only">{text}</span>
  </span>
);

/**
 * 대시보드의 프로젝트 한 줄: 이름·상태 | 브랜치·변경 | 마지막 커밋 | 세션.
 * 이름 링크가 ::after 로 줄 전체를 덮어 어디를 눌러도 상세 화면으로 간다. 버튼은 링크 밖의 형제로 그 위에 뜬다.
 */
export function ProjectCard({ p, now, onHidden }: { p: ProjectSnapshot; now: string; onHidden?: (session: string) => void }) {
  const { git, tmux, status } = p;
  const last = git.recentCommits[0];
  return (
    <div className={`row card state-${status.state}`}>
      <div className="row-main">
        <div className="row-title">
          <h2>
            <a className="card-link" href={`#/project/${encodeURIComponent(p.id)}`} title={p.repoPath}>
              {p.name}
            </a>
          </h2>
          <Badge state={status.state} />
          {p.id.startsWith('tmux:') && <DiscoveredActions p={p} onHidden={onHidden} />}
        </div>
        <Reasons reasons={status.reasons} />
        {/* 입력 대기면 카드에서 바로 답한다 (버튼은 카드 링크 위에 뜬다) */}
        <QuickAnswers project={p} />
      </div>
      <div className="row-col">
        <Lbl icon={<GitBranch size={14} />} text="브랜치 · 변경" />
        {git.ok ? (
          <span className="val">
            <span className="mono clip branch" title={`브랜치: ${git.branch}`}>
              {git.branch}
            </span>
            <span className="sub" title="커밋되지 않은 변경">
              {git.clean ? (
                '변경 없음'
              ) : (
                <>
                  파일 {git.cut?.total ?? git.changedFiles.length}개 <span className="add">+{git.additions}</span> <span className="del">−{git.deletions}</span>
                </>
              )}
            </span>
          </span>
        ) : git.error === NOT_A_REPO ? (
          <span className="val dim">{git.error}</span>
        ) : (
          <span className="val err wrap">{git.error ?? 'Git 정보를 읽을 수 없습니다'}</span>
        )}
      </div>
      <div className="row-col">
        <Lbl icon={<GitCommit size={14} />} text="마지막 커밋" />
        <span className="val">
          <span className="clip" title={last?.subject}>
            {last ? last.subject : <span className="dim">커밋 없음</span>}
          </span>
          {last && <span className="sub">{relTime(last.date, now)}</span>}
        </span>
      </div>
      <div className="row-col">
        <Lbl icon={<TerminalWindow size={14} />} text="tmux 세션" />
        {!tmux.configured ? (
          <span className="val dim">지정 안 됨</span>
        ) : (
          <span className="val">
            <span className="mono clip" title={`tmux 세션: ${p.tmuxSession}`}>
              {p.tmuxSession}
            </span>
            {tmux.exists ? <span className="sub">{relTime(tmux.lastOutputChangeAt ?? tmux.lastActivityAt, now)}</span> : <span className="sub err">세션 없음</span>}
          </span>
        )}
      </div>
    </div>
  );
}
