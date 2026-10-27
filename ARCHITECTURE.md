# NightShift 아키텍처

tmux에서 돌아가는 AI 코딩 에이전트(Claude Code, Codex)를 휴대폰·다른 컴퓨터에서 실시간으로 보고 조종하는 **로컬** 대시보드. 서버는 Mac에서 돌고, 원격 접속은 Tailscale을 거친다.

## 원칙

- 프로세스 하나, 포트 하나. Express가 API와 프론트엔드(개발: Vite 미들웨어, 프로덕션: `dist/web` 정적 파일)를 함께 서빙한다.
- 서버는 Node의 TypeScript 네이티브 실행(type stripping, Node ≥ 22.18)으로 바로 돌린다. 서버용 빌드 단계·`tsx`·`concurrently` 없음.
- DB 없음. 설정은 JSON/YAML, 세션 상태는 JSON 파일 하나.
- 의존성 최소: 런타임은 `express`, `react`, `react-dom`, `yaml`, `@xterm/xterm`(터미널), `codemirror`(파일 편집기, 파일을 열 때만 받음. 언어별 문법도 그때그때), `markdown-it`(Markdown 미리보기, 켤 때만 받음), 아이콘·글꼴뿐. 라우터·UI 킷·ANSI·검증 라이브러리 없음.

## 디렉터리

```
shared/types.ts        서버·UI가 공유하는 API 타입 (type-only)
scripts/setup.ts       npm run setup: 도구 확인·빌드·Tailscale serve·launchd/systemd 등록 (설치할 때만 돈다)
scripts/nightshift.ts  nightshift 명령 (setup 이 npm link): status·open·logs·restart·stop·start·setup·update
server/
  index.ts             진입점: 인자 파싱, config 로드, 상태 복원, 알림·감시 연결, listen(127.0.0.1)
  config.ts            JSON/YAML config 로드·검증·기본값
  exec.ts              ★ 명령 실행 (git/tmux/osascript allowlist, 등록 명령 실행)
  git.ts               git 정보 수집 (-z 파싱, untracked 줄 수, 활동 지문)
  tmux.ts              tmux 세션·pane 수집 (색상 SGR 유지)
  control.ts           tmux 컨트롤 모드 프로토콜 파서 (%output 이스케이프 해제)
  termstream.ts        세션마다 `tmux -C attach` 하나를 띄워 pane 출력을 구독자에게 흘려보냄
  upload.ts            터미널에 붙여넣은 이미지 저장 (.nightshift/uploads)
  files.ts             파일 탭: Git 이 아는 파일만 목록·읽기·저장 (연 뒤 바뀌었으면 409), 그림 미리보기 바이트. 저장소가 아닌 폴더는 .nightshift/shadow 의 빈 저장소로
  logs.ts              로그 위치 추적 스캔, 패턴 매처, ANSI 처리, 프롬프트·스피너 판별
  status.ts            상태 판정 (순수 함수)
  monitor.ts           폴링 루프, 기준점·변경 시각·로그 위치 추적, 구독자 알림
  runner.ts            등록된 test/build 실행, 취소, 이력
  state.ts             세션 상태의 디스크 저장·복원 (.nightshift/state.json)
  reload.ts            config hot reload
  input.ts             UI → tmux 키 입력: 요청 검증, 허용 키 목록, 기록
  configEdit.ts        UI 설정 편집: 편집 가능 필드만 병합·검증·원자적 저장 (YAML 주석 보존)
  push.ts              휴대폰 푸시 (ntfy) 전송. 설정했을 때만 외부로 요청
  notify.ts            상태 전환 알림 판정 ("작업 끝남" 포함, 반복 억제) (순수 함수)
  demo.ts              demo mode용 가짜 수집기
  app.ts               Express 라우트, SSE, 보안 미들웨어
  *.test.ts            vitest 단위 테스트
web/
  index.html
  src/                 React UI (해시 라우팅, 순수 CSS)
    ansi.ts            SGR → 스타일 span 파서 (카드의 출력 미리보기)
    Term.tsx           xterm.js 터미널: 출력 스트림, 키·붙여넣기·휠 전달, 복사(OSC 52)
    *.test.ts(x)       파서·컴포넌트 테스트 (jsdom)
config/nightshift.example.{json,yaml}
.nightshift/           runs/ (마지막 실행 로그), state.json (세션 상태), input.log (보낸 입력), uploads/ (올린 이미지)
```

## 데이터 흐름

```
config ──> Monitor ──(refreshIntervalSec 마다)──> Collector(project)
   ▲           │                                    ├─ git.ts   ─┐
   │ watch     │                                    ├─ tmux.ts  ─┼─> exec.ts ─> git / tmux
reload.ts      │                                    └─ logs.ts  ─┘ (fs)
               ├─ status.ts 로 상태 판정
               └─ Snapshot ─┬─> SSE(/api/events) ──> React
                            ├─> state.ts (바뀌었을 때만 저장)
                            └─> notify.ts ─> exec.notify / push.ts (상태 전환 시)

tmux ──(-C attach, %output)──> termstream.ts ──SSE(/term/:paneId)──> xterm.js
xterm.js ──(키·붙여넣기 바이트)──> POST /raw ──> tmux send-keys
```

- `Monitor`는 `Collector` 인터페이스(실제/데모)만 안다. demo mode는 가짜 Collector를 꽂는 것뿐이므로 상태 판정·UI는 실제 코드 그대로 동작한다.
- 스냅샷 하나에 화면에 필요한 모든 것(pane 출력 포함)을 담는다. UI는 SSE로 받은 최신 스냅샷만 그린다. 느린 클라이언트에는 쌓지 않고 건너뛴다.
- tick, hot reload, 세션 초기화는 `Monitor` 안의 한 줄 큐로 직렬화된다. 이전 설정으로 돌던 수집이 새 설정의 상태를 덮어쓰지 못한다.
- 알림·저장은 모두 "스냅샷 구독자"다. `Monitor`는 이들을 모른다.
- 휴대폰 푸시(`push.ts`)는 이 도구가 외부로 요청을 보내는 유일한 경로다. `ntfyUrl`을 설정했을 때만 동작하고, 보내는 내용은 프로젝트 이름·상태·판정 사유·대시보드 주소뿐이다. 한글 제목 때문에 헤더 대신 JSON 본문으로 보내며, 실패는 로그만 남긴다.

## 상태 판정 (`status.ts`)

우선순위: 오류 > 입력 대기 > 정지 의심 > 유휴 > 정상.

| 상태 | 조건 |
| --- | --- |
| error | 저장소 경로 없음/Git 저장소 아님, 등록된 tmux 세션 없음, 로그에서 오류 패턴 발견, 마지막 test/build 실패(취소 제외) |
| waiting | 어느 pane이든 마지막 15줄에 `promptPatterns`가 걸림 |
| stalled | 출력 변화 없음 ≥ `stalledMinutes` **그리고** Git 변화 없음 ≥ `noCommitMinutes` |
| idle | 출력 변화 없음 ≥ `idleMinutes` |
| running | 그 외 |

- **출력 변경 시각**: 모든 pane의 출력을 합쳐 이전 폴링과 비교한다. `ignoreSpinnerChanges`가 켜져 있으면 숫자·스피너 글리프를 지운 뒤 비교하므로, 경과 시간과 스피너만 도는 화면은 "변화 없음"이다. tmux가 보고하는 활동 시각은 스피너에도 갱신되므로 최초 관측의 초기값으로만 쓴다.
- **Git 변경 시각**: 마지막 커밋 시각과, 활동 지문이 달라진 시각 중 늦은 쪽. 지문은 HEAD·브랜치·변경 파일 목록과 각 파일의 크기·수정 시각이라, 줄 수가 같은 수정이나 untracked 파일의 추가 수정도 잡힌다.
- **로그 오류**: 프로젝트마다 `{offset, inode}` 위치를 기억하고 그 뒤에 추가된 줄만 검사한다. 최초 관측 시 기존 내용은 건너뛴다. inode가 바뀌거나 파일이 줄어들면 처음부터 다시 읽는다. "확인 처리"는 위치를 파일 끝으로 옮기는 것이다.
- tmux 세션이 등록되지 않은 프로젝트는 Git 활동만으로 판정한다.
- **에이전트 세션**: pane에서 Claude Code·Codex가 돌고 있거나(포그라운드 명령줄) 작업 중 표시(`busyPatterns`, 기본 `esc to interrupt`)를 한 번이라도 띄운 세션. 이런 세션은 화면 변화 대신 작업 중 표시로 판정한다: 표시가 있으면 running(화면이 `stalledMinutes` 이상 그대로면 stalled), 없으면 idle. 표시가 잠깐 끊기는 것은 무시한다. 일하다가 idle이 되면 알림 제목이 "작업 끝남"이 된다.
- **바로 답하기**: 입력 대기 프롬프트 아래의 번호 선택지(`1. Yes` 등)를 뽑아 스냅샷의 `waitingChoices`에 싣는다. UI는 버튼으로 그 번호 키를 일반 입력 경로로 보낸다.

## 세션 상태와 hot reload

- **저장 (`state.ts`)**: 모니터링 시작 시각, 프로젝트별 기준점·Git 변경 시각·로그 위치, 실행 결과(출력은 끝 64KB)와 이력을 JSON 하나로 저장한다. 내용이 바뀐 스냅샷에서만 쓰고, 임시 파일 + rename으로 원자적으로 교체한다. 읽을 수 없으면 경고 후 새 세션으로 시작한다.
- **복원**: 프로젝트 id와 저장소 경로가 모두 같을 때만 기준점을 이어 쓴다. 저장 당시 실행 중이던 test/build는 "재시작으로 중단됨(취소)"으로 기록한다.
- **hot reload (`reload.ts`)**: `fs.watchFile`(polling, 에디터의 rename 저장에도 안전)로 config의 mtime 변화를 감지한다. 검증에 통과하면 교체하고, 실패하면 이전 설정을 유지한 채 `snapshot.configError`로 알린다. id와 저장소 경로가 같은 프로젝트의 추적 상태는 유지하고, 사라지거나 경로가 바뀐 프로젝트는 추적 상태와 실행 결과를 버린다. `host`·`port`는 이미 listen 중이라 무시한다.

## 실시간 보기와 터미널 입력 (`input.ts`)

v1의 원칙은 "웹에서 임의 명령을 실행할 수 없다"였다. 터미널 입력은 사용자의 명시적 요청으로 이 원칙에 **선택적 예외**를 둔 것이므로, 기본은 꺼져 있고 여러 조건을 모두 통과해야 동작한다.

- **실시간 보기**: `GET /projects/:id/term/:paneId`는 SSE로 pane 출력 바이트를 그대로 흘려보낸다. 세션마다 tmux 컨트롤 모드 클라이언트 하나(`termstream.ts`)가 `%output`을 받고, 첫 화면(스크롤백 포함)은 같은 채널의 `capture-pane` 응답으로 보낸다. 출력은 건너뛸 수 없으므로 느린 클라이언트에 너무 쌓이면 끊고, 브라우저가 다시 붙으면 첫 화면부터 새로 받는다. 읽기 전용이라 모든 프로젝트에서 동작한다.
- **입력**: `POST /projects/:id/input`(휴대폰 입력 줄, 바로 답하기)은 `tmux send-keys -t <pane> -l -- <text>`(글자 그대로, 키 이름·옵션 해석 없음)와 `send-keys <key>`(허용 목록 15개 중 하나)만 실행한다. `POST /projects/:id/raw`는 xterm.js가 만든 바이트(키·붙여넣기·마우스 보고)를 그대로 넣는다. 둘 다 `execFile`이라 셸 해석이 없다.
- **이미지**: `POST /projects/:id/upload`는 이미지를 `.nightshift/uploads/`에 저장하고 경로만 돌려준다. 경로를 프롬프트에 넣는 것은 일반 입력 경로를 탄다.
- **허용 조건** (모두 만족해야 함): ① 그 프로젝트의 `allowInput`이 켜짐 ② 서버가 loopback 또는 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)에 바인딩 — `0.0.0.0`·LAN 주소는 거부 ③ pane id가 현재 스냅샷에서 그 프로젝트 세션의 pane 목록에 있음 ④ Host·Origin 검사 통과 ⑤ JSON 본문 검증 통과(20,000자 이하, NUL 없음). 이미지 올리기도 같은 조건. demo mode에서는 항상 거부.
- `allowInput`은 처음에는 파일 전용이었으나, 사용자의 결정으로 설정 화면에서도 켜고 끌 수 있게 했다(켤 때 확인 창). 따라서 **대시보드에 닿을 수 있는 범위가 곧 보안 경계**다. 노출은 loopback, `tailscale serve`(+ `allowedHosts`), Tailscale 주소 바인딩 중 하나로만 한다.
- `allowedHosts`(파일 전용): loopback 바인딩일 때 Host·Origin 검사에서 추가로 받아들일 호스트 이름. 프록시가 원래 이름을 Host로 넘기든 `127.0.0.1`로 바꿔 넘기든 Origin이 `https://<이름>`(443)이면 변경 요청을 받는다. 그 밖의 변경 요청은 Origin이 `http://<Host 헤더>`이고 그 포트가 서버가 받은 포트일 때만 받는다(같은 기기의 다른 포트에서 띄운 페이지 차단).
- 모든 입력은 보내기 전에 `.nightshift/input.log`에 JSON 한 줄로 남긴다(마우스 보고만 있는 바이트는 제외).
- **세션 만들기**: `tmux new-session -d -s <이름> -c <경로>`만 실행한다. 실행할 명령은 받지 않아 항상 기본 셸이 뜬다. 이름은 config와 같은 규칙으로 검증하고 경로는 존재하는 디렉터리여야 한다. 세션을 먼저 만들고(이미 있으면 그대로) 설정 편집 경로(`configEdit`)로 프로젝트를 추가하므로 기존 프로젝트의 명령은 건드리지 않는다. 입력과 같은 바인딩 조건(loopback·Tailscale)을 적용하고 demo에서는 거부한다.

## 설정 편집 (`configEdit.ts`)

"UI에서 명령을 입력할 수 없다"는 원칙을 유지하면서 설정을 UI에서 고칠 수 있게 한다.

- `PUT /api/config`는 본문을 읽는 유일한 경로다. 본문에서 **허용 목록에 있는 키만** 골라 파일의 원본 객체에 병합한다. `testCommand`/`buildCommand`/`host`/`port`는 본문에 있어도 읽지 않는다.
- 기존 프로젝트는 id로 파일의 원본 항목을 찾아 그 위에 이름·경로·세션·로그 파일만 덮어쓰므로 명령은 파일의 값이 그대로 남는다. 새 프로젝트는 명령 없이 만들어진다.
- 명령이 등록된 프로젝트의 `repoPath`가 달라지면(정규화한 경로 기준) 거부한다. 등록된 명령이 다른 디렉터리에서 실행되는 것을 막기 위함이다.
- 병합 결과를 `parseConfig`로 전체 검증한 뒤에만 쓴다(임시 파일 + rename). 실패하면 파일은 그대로다.
- 파일에 없던 키는 값이 실제로 바뀐 경우에만 쓴다(기본값으로 파일을 채우지 않는다). 모르는 키(예: 없어진 `autoReportTime`·`reportsDir`)는 읽을 때 무시하고 저장할 때 그대로 둔다. YAML은 `Document`의 바뀐 최상위 키만 교체해 주석을 보존한다.
- 동시 수정 감지: 뷰에 파일 내용의 해시(`version`)를 실어 보내고 저장 요청이 그 값을 돌려준다. 현재 파일의 해시와 다르면 409로 거부한다. 확인부터 쓰기까지 동기 코드라 한 요청 안에서 끼어들 틈이 없다.
- 저장 직후 `reloadConfig`를 호출해 즉시 적용한다. demo mode는 읽기 전용 뷰만 제공한다.

## 명령 실행과 보안 (`exec.ts`)

- `run(bin, args)`: `git`, `tmux`, `osascript`만 허용하는 allowlist + `execFile`(셸 미경유) → 인자 escaping 문제가 구조적으로 없다. 타임아웃·출력 상한 있음. 절대 throw하지 않고 `{code, stdout, stderr}`를 돌려준다.
- `notify(title, message)`: 문구를 AppleScript 소스에 끼워 넣지 않고 `on run argv`의 인자로 넘긴다.
- `runConfigured(command, cwd, timeout, signal)`: config의 test/build 명령 전용. 셸로 실행하되 명령 문자열은 **config 파일에서만** 온다. 실행 API는 프로젝트 id와 `test|build`만 받고 본문은 읽지 않으며, 설정 편집 API도 명령은 받지 않는다. cwd는 등록된 저장소 경로로 고정, 타임아웃·취소 시 프로세스 그룹째 종료, stdout/stderr 분리 저장.
- 서버는 `127.0.0.1` 바인딩. Host 헤더가 loopback도 `allowedHosts`도 아니면 거부(DNS rebinding 방어), 변경 요청은 Origin이 자기 자신이나 `allowedHosts`가 아니면 거부(CSRF 방어).
- tmux 세션 이름은 config 로드 시 검증(`:`·`.`·공백, 선행 `-` `$` `=` `@` `%` 금지). pane은 tmux가 준 pane id(`%숫자`)로만 지정한다.
- untracked 파일 줄 수 세기와 로그 읽기는 일반 파일만 연다(FIFO 등에서 멈추지 않게).
- tmux 컨트롤 모드 클라이언트(`termstream.ts`)도 셸 없이 `spawn`으로 `tmux -C attach-session -E -t =<세션>`만 띄운다.
- 터미널 출력은 서버에서 SGR 이외의 제어 시퀀스를 제거하고, 카드의 출력 미리보기는 React 텍스트/스타일로만 그린다(HTML 주입 없음). 터미널 탭은 xterm.js가 바이트를 해석한다.

## API

스냅샷·프로젝트 JSON 과 `/api/events` 는 받는 쪽이 받으면 gzip 으로 보낸다 (스트림은 스냅샷마다 비워 보낸다). 빌드한 js·css·svg 도 gzip 으로 보내고, 이름에 해시가 붙은 `/assets` 는 오래 캐시한다(`immutable`).

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/snapshot` | 현재 스냅샷 (`/api/events` 와 같은 요약) |
| GET | `/api/events` | SSE, 폴링마다·실행 상태 변경 시 스냅샷 푸시 (pane 화면 사본·기준점 이후 목록·Git 지문을 빼고, 변경 파일 목록은 300개까지 자른 요약. 잘랐으면 `git.cut` 에 실제 수와 전체 목록의 지문) |
| GET | `/api/projects/:id` | 한 프로젝트의 전체 상태 (Git·파일 탭이 기준점 이후 목록이나 잘린 변경 파일 목록을 받을 때) |
| GET | `/api/projects/:id/files` | Git 이 아는 파일 목록 (`ls-files --cached --others --exclude-standard`). `ignored`: 입력 허용 프로젝트만, 무시된 파일(무시된 폴더 안은 제외) |
| GET | `/api/projects/:id/file?path=` | 글 파일 내용과 지문(sha1). 400 / 404 / 413 / 415 |
| GET | `/api/projects/:id/raw?path=` | 그림 파일 바이트(png·jpg·gif·webp·svg·ico·bmp·avif, 20MB까지). 여는 규칙은 `/file` 과 같다. `nosniff`, `no-store`, CSP `sandbox` (SVG 를 바로 열어도 스크립트가 돌지 않게). 400 / 404 / 413 / 415 |
| POST | `/api/projects/:id/fs` | `{op, path, to?}` 파일 다루기: newFile·newDir·move·copy·delete(.git/nightshift-trash 로, 저장소가 아닌 폴더는 .nightshift/shadow 의 빈 저장소 안). 입력과 같은 조건, 저장소 안·.git 밖만, 저장소마다 하나씩. 400 / 403 / 404 / 409 |
| PUT | `/api/projects/:id/file` | `{path, content, version}` 저장 (입력과 같은 조건). 지문이 다르면 409 |
| POST | `/api/projects/:id/run/:kind` | `kind` = `test` \| `build`. 202 / 400 / 404 / 409 |
| DELETE | `/api/projects/:id/run/:kind` | 실행 취소. 202 / 400 / 409 |
| GET | `/api/projects/:id/run/:kind` | 마지막 실행의 전체 출력 |
| GET | `/api/projects/:id/term/:paneId` | SSE, pane 출력 바이트 스트림 (xterm.js) |
| GET | `/api/projects/:id/terms?panes=%1,%2` | 나란히 보기: 여러 pane 의 스트림을 SSE 하나로 (이벤트에 `pane`). http/1.1 의 주소당 연결 6개 제한 때문 |
| POST | `/api/projects/:id/input` | pane 에 글자 또는 허용된 특수 키 전송. 200 / 400 / 403 / 404 |
| POST | `/api/projects/:id/raw` | 터미널 에뮬레이터의 바이트를 그대로 전송. 200 / 400 / 403 / 404 |
| POST | `/api/projects/:id/upload` | 이미지 저장 후 경로 반환. 200 / 400 / 403 / 404 |
| POST | `/api/sessions` | 새 tmux 세션을 만들고(고르면 `agent`: claude·codex 를 띄움) 프로젝트로 등록. 200 `{id}` / 400 / 403 / 409 |
| POST | `/api/projects/:id/panes/:paneId/fit` | 터미널이 붙어 있지 않은 세션의 화면 크기를 보는 화면에 맞춤. 200 / 403 / 404 / 409 |
| POST | `/api/projects/:id/session` | 등록된 프로젝트의 꺼진 세션을 같은 이름으로 다시 만들기 |
| DELETE | `/api/projects/:id/session` | 세션 끝내기 (입력과 같은 조건). 200 / 400 / 403 / 404 |
| DELETE | `/api/projects/:id/panes/:paneId` | 터미널(pane) 닫기 (입력과 같은 조건). 200 / 400 / 403 / 404 |
| POST | `/api/projects/:id/windows` | 같은 세션에 셸 윈도우를 하나 더 열기 (입력과 같은 조건, 세션당 8개). `agent`: claude·codex 를 주면 그 셸에서 띄움. 200 `{pane}` / 400 / 403 / 404 / 409 |
| POST | `/api/projects/:id/ack-errors` | 로그 오류 확인 처리 |
| POST | `/api/session/reset` | 새 모니터링 세션 (기준점 초기화) |
| POST | `/api/notify/test` | 저장된 ntfy 주소로 시험 알림 전송 |
| GET | `/api/config` | 설정 편집 화면용 뷰 (파일의 원문 경로, 잠금 여부) |
| PUT | `/api/config` | 설정 저장 후 즉시 적용. 200 / 400(`issues`) / 403(demo) / 409(동시 수정) |

## 구현 이력

1. v1: 스캐폴드 → config → git/tmux 수집 → 상태 판정 → API·SSE → 대시보드 → runner → demo.
2. v2: Git 정확도(-z, untracked, 지문) → 다중 pane·색상·입력 대기·스피너 무시 → 실행 취소·이력 → 세션 저장·초기화·로그 위치 → hot reload·YAML·알림 → UI·컴포넌트 테스트.
3. 원격 개발로 방향 전환: 터미널 입력·Tailscale → 휴대폰 푸시(ntfy) → 세션 만들기·clone → xterm.js·컨트롤 모드 스트림 → 이미지 붙여넣기·복사 → 바로 답하기 → 작업 중 표시 기반 판정·"작업 끝남" → 한 화면 카드 그리드. 밤샘 감시용 Morning Report는 제거했다.
