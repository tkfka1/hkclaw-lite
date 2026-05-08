# hkclaw-lite

`hkclaw-lite`는 Discord/Telegram/KakaoTalk 에이전트를 웹 어드민 중심으로 운영하는 경량 런타임이다.
**npm으로 설치해서 로컬에서 직접 실행하는 것**이 유일한 운영 형태다.

- 기본 진입점은 웹 어드민(`http://127.0.0.1:5687`)이다.
- 에이전트는 Codex/Claude/Gemini/local LLM/command 같은 **AI 실행 주체**다.
- 채널은 **대화가 들어갈 라우팅 단위**다. Discord/Telegram 토큰은 에이전트 설정에 두고, KakaoTalk은 Admin 내장 릴레이 + KakaoTalk 채널로 운영한다.
- 반복 작업은 Admin의 **예약** 화면이나 `hkclaw-lite schedule` 명령으로 채널에 붙여 실행할 수 있다.

## 요구 사항

- Node.js 24+
- 시스템 `PATH`에 있는 `codex`/`gemini`로 자동 fallback하지 않는다. 내부 번들만 사용한다.
- Claude는 기본적으로 내부 번들을 쓰고, 필요하면 `HKCLAW_LITE_CLAUDE_CLI=claude` 같은 환경 변수로 외부 CLI를 명시적으로 지정할 수 있다.

기본 번들 버전:

- `@openai/codex@0.125.0`
- `@anthropic-ai/claude-agent-sdk@0.2.119`
- `@google/gemini-cli@0.39.1`

웹 어드민의 **AI 관리 → 번들 업데이트** 또는 CLI 명령으로 프로젝트별 최신 번들을 받을 수 있다. 업데이트는 설치된 hkclaw-lite 패키지를 직접 고치지 않고 `.hkclaw-lite/bundled-clis` 아래에 overlay로 설치한다.

```bash
hkclaw-lite bundles status
hkclaw-lite bundles update all
hkclaw-lite bundles update codex --version latest
```

에이전트별 접근 범위는 `read-only`, `workspace-write`, `danger-full-access` 중에서 고를 수 있다. Codex는 sandbox/approval 플래그로, Gemini CLI는 approval mode(`plan`/`auto_edit`/`yolo`)로, local LLM은 런타임 컨텍스트로, command 에이전트는 `HKCLAW_LITE_AGENT_ACCESS_MODE` 환경 변수로 전달된다. Claude Code는 `bypassPermissions` 권한 모드가 전체 권한에 해당한다.

외부 Claude CLI를 쓰려면:

```bash
export HKCLAW_LITE_CLAUDE_CLI=claude
hkclaw-lite admin
```

## 설치 / 실행

전역 설치:

```bash
npm install -g hkclaw-lite
hkclaw-lite admin
```

프로젝트 로컬 설치:

```bash
npm install hkclaw-lite
npx hkclaw-lite admin
```

설치 후:

- 웹 어드민은 `127.0.0.1:5687` 에서 뜬다. 외부 노출이 필요하면 `--host 0.0.0.0`을 명시한다.
- 에이전트/채널/AI 로그인은 모두 웹에서 관리한다.
- Discord/Telegram은 채널이 있으면 필요한 수신 워커가 자동으로 켜진다. KakaoTalk은 KakaoTalk 채널/플랫폼 에이전트가 있으면 하나의 릴레이 수신 워커가 켜진다.

### 서비스로 등록 (Linux/systemd)

`hkclaw-lite admin` 을 systemd user unit 으로 등록해서 백그라운드에서 항상 띄울 수 있다.

```bash
cd ~/hkclaw-lite               # state 가 살 프로젝트 루트
hkclaw-lite start               # ~/.config/systemd/user/hkclaw-lite.service 작성 + enable + start
hkclaw-lite service status     # systemctl --user status hkclaw-lite
hkclaw-lite service logs -f    # journalctl --user -u hkclaw-lite -f
hkclaw-lite stop               # 정지
hkclaw-lite restart            # 재시작
hkclaw-lite service uninstall  # disable + unit 파일 삭제
```

- 기본 bind 는 `0.0.0.0:5687` 이다. `--host`/`--port` 로 바꿀 수 있다.
- 재부팅 자동 기동을 원하면 `loginctl enable-linger $USER` 을 한 번 켜둔다.
- 비밀이나 환경 변수를 추가로 주입하려면 `<root>/.hkclaw-lite/service.env` 를 만들어 두면 unit 의 `EnvironmentFile=-` 로 자동 로드된다.

## 기본 흐름

1. `hkclaw-lite admin` 으로 웹 어드민을 띄운다.
2. 웹에서 AI 로그인부터 끝낸다.
3. 에이전트를 만든다.
4. KakaoTalk을 쓸 때는 세션을 따로 만들지 말고 KakaoTalk 채널을 만든다. 채널 저장 시 pairing/relay용 내부 연결이 자동 생성된다. Discord/Telegram은 에이전트에 토큰을 둔다.
5. 대화 대상을 만든다. Discord/Telegram은 서버/그룹 채널 또는 개인 대화/DM 중 하나를 고르고, Kakao는 채널 카드에서 pairing code와 연결 상태를 확인한다.
6. 해당 플랫폼 워커를 실행한다. Discord/Telegram은 에이전트 카드에서, Kakao는 채널 화면의 KakaoTalk 릴레이 서버 영역에서 관리한다.

웹 어드민은 채널 설정을 보고 필요한 에이전트 수신 워커와 Kakao 릴레이 수신 워커를 자동 시작한다. 자동 시작을 끄려면 `HKCLAW_LITE_CHANNEL_AUTOSTART=0`을 지정한다.

Telegram `chat_id`를 모를 때는 에이전트 카드에서 Telegram 연결을 시작한 뒤, Telegram 앱에서 해당 봇에게 `/id`를 보내면 된다. 워커가 수신한 최근 채팅/스레드 ID는 웹 어드민의 Telegram 채널 추가 화면에 “최근 발견된 Telegram 채팅”으로 표시되어 바로 적용할 수 있다.

## 주요 명령

```bash
hkclaw-lite admin
hkclaw-lite add connector  # 고급/호환: 내부 KakaoTalk 연결 직접 관리
hkclaw-lite add channel --platform discord --target-type direct --discord-user-id <user-id>
hkclaw-lite add channel --platform telegram --target-type direct --telegram-chat-id <chat-id>
hkclaw-lite run --channel <name> --message "hello"
hkclaw-lite schedule add daily-ops --channel <name> --daily 09:00 --timezone Asia/Seoul --message "daily ops check"
hkclaw-lite schedule add repo-watch --channel <name> --every 30m --message "check actionable repo updates"
hkclaw-lite schedule list
hkclaw-lite schedule run daily-ops
hkclaw-lite discord serve --agent <agent-name>
hkclaw-lite telegram serve --agent <agent-name>
hkclaw-lite kakao serve --connector <kakao-connector-name>
```

`admin`은 웹 어드민, `run`은 one-shot 실행, `schedule`은 저장된 채널 프롬프트를 주기적으로 실행하는 예약 명령, `add connector`는 KakaoTalk 내부 연결 직접 관리, `discord/telegram/kakao serve`는 플랫폼 워커를 직접 띄우는 명령이다.

### 예약 실행

예약은 외부 cron이 아니라 Admin 프로세스가 runtime SQLite DB를 폴링해 due schedule을 실행한다. 채널 history, role messages, token usage, outbox 기록이 일반 채널 실행과 같은 경로에 남는다.

```bash
# 30분마다 채널 실행
hkclaw-lite schedule add repo-watch \
  --channel ops \
  --every 30m \
  --message "최근 변경과 운영 알림을 보고 액션이 필요한 것만 정리해줘"

# 매일 한국 시간 09:00 실행
hkclaw-lite schedule add daily-ops \
  --channel ops \
  --daily 09:00 \
  --timezone Asia/Seoul \
  --message "일일 운영 점검을 실행해줘"

# 수동 실행과 due schedule 1회 처리
hkclaw-lite schedule run daily-ops
hkclaw-lite schedule tick
```

- 지원 방식은 `interval`과 `daily`다.
- `daily`는 IANA timezone 이름(예: `Asia/Seoul`) 기준으로 다음 실행 시각을 계산한다.
- 예약은 `runtime_schedules`에, 개별 실행은 `runtime_schedule_runs`에 남는다.
- 실행 중에는 SQLite lease와 heartbeat가 잡혀 같은 예약이 동시에 두 번 돌지 않는다.
- `HKCLAW_LITE_SCHEDULER=0` 으로 Admin 내장 스케줄러 폴링을 끌 수 있다. 외부 워커는 `hkclaw-lite schedule tick` 으로 호출하면 된다.

## KakaoTalk 채널

KakaoTalk 연동은 **Admin 내장 릴레이 서버 1개 + KakaoTalk 채널 + 에이전트** 3개로 운영한다. `connector`/session은 설정 파일과 기존 CLI 호환을 위한 내부 계층이며, 일반 운영자는 채널 카드에서 pairing code와 연결 상태만 보면 된다.

### 필요한 것

- 외부에서 접근 가능한 hkclaw-lite Admin URL (예: `https://your-domain.example`)
- Kakao i OpenBuilder Skill URL: `https://your-domain.example/kakao-talkchannel/webhook`
- 응답을 만들 AI Agent (Codex/Claude/Gemini/local LLM/command 중 하나)
- KakaoTalk Channel — pairing code/연결 상태와 라우팅 규칙
- Kakao relay receiving worker — 채널 화면의 KakaoTalk 릴레이 서버 영역에서 시작/재시작. 직접 실행은 `hkclaw-lite kakao serve`.

### 웹 어드민 설정 순서

1. Admin을 외부에서 접근 가능하게 띄운다.

   ```bash
   hkclaw-lite admin --host 0.0.0.0 --port 5687
   ```

2. Kakao i OpenBuilder의 Skill URL에 다음 주소를 등록한다.

   ```txt
   https://your-domain.example/kakao-talkchannel/webhook
   ```

3. 웹 어드민에서 AI 로그인 후 Agent를 만든다.
4. **채널** 화면에서 KakaoTalk Channel을 만든다.
   - 플랫폼: KakaoTalk
   - Agent/workspace/single 또는 tribunal mode 설정
   - `Kakao 수신 channelId 필터`: 보통 `*`
   - `Kakao 사용자 ID 필터`: 특정 사용자만 받을 때만 입력
   - 저장하면 pairing/relay용 내부 연결이 자동 생성된다.
5. KakaoTalk 릴레이 서버 영역에서 워커 상태를 확인한다. 자동 시작이 꺼져 있으면 릴레이 수신 워커를 시작/재시작한다.
6. KakaoTalk 채널 카드에 pairing code가 보이면 카카오톡에서 입력한다.

   ```txt
   /pair <code>
   ```

   `/pair` 를 포함한 전체 명령어를 보내야 한다. pairing code가 만료되면 워커가 새 code를 다시 만들고 채널 카드가 갱신된다.

7. 이후 카카오톡 메시지는 Channel 규칙에 따라 Agent로 전달되고, 응답은 Kakao SkillResponse로 돌아간다.

   KakaoTalk에는 Discord/Telegram처럼 입력 중 표시가 없으므로, hkclaw-lite는 콜백 대기 응답에 `data.text`를 같이 보낸다. OpenBuilder 콜백 블록의 응답 설정에서 Skill data의 `text` 값을 사용하면 사용자는 최종 답변 전까지 “서버에 도착했고 답변 준비 중” 상태를 볼 수 있다.

### CLI와 운영 명령

```bash
hkclaw-lite add channel
hkclaw-lite kakao serve
hkclaw-lite add connector
hkclaw-lite kakao serve --connector kakao-main
```

- 기본 운영은 `hkclaw-lite kakao serve` 하나가 설정된 모든 KakaoTalk 채널 라우팅을 처리한다.
- `add connector` 와 `--connector <name>` 은 기존 자동화/분리 운영을 위한 호환 표면이다.

### 릴레이 서버 URL과 엔드포인트

릴레이 서버 URL은 Kakao 릴레이 수신 워커가 붙을 Admin 내장 relay 주소다. 보통 Admin 외부 URL을 그대로 쓴다.

환경 변수로 기본값을 지정할 수도 있다.

```bash
OPENCLAW_TALKCHANNEL_RELAY_URL=https://your-domain.example/
# 또는
KAKAO_TALKCHANNEL_RELAY_URL=https://your-domain.example/
```

내장 릴레이는 Admin 서버에서 다음 엔드포인트를 제공한다.

- `POST /kakao-talkchannel/webhook`: Kakao i OpenBuilder Skill URL
- `GET /v1/healthz` 또는 `/kakao-talkchannel/healthz`: health check
- `POST /v1/sessions/create`: pairing session 생성
- `GET /v1/events`: Kakao 릴레이 수신 워커 SSE 수신
- `POST /openclaw/reply`: Kakao 응답 전송
- `GET /v1/sessions/{sessionToken}/status`: pairing 상태 확인

## 채널, 에이전트, 하네스 관리 모델

`hkclaw-lite` 의 대화 하네스와 세션 경계는 **에이전트 단독 기준이 아니라 채널 + 역할(role) 기준**이다.

```txt
session_key = <channel.name>:<role>
```

같은 에이전트를 여러 채널에 붙여도 각 채널은 별도 세션 컨텍스트를 가진다.

### 용어

- **Agent**: Codex, Claude, Gemini, local LLM, command runner 같은 실제 실행 주체. 모델, 명령, fallback 을 가진다. Discord/Telegram 토큰은 에이전트 플랫폼 설정에 둔다.
- **KakaoTalk 내부 연결 / Connector**: KakaoTalk 전용 pairing/relay 상태를 보존하는 내부 호환 계층. 일반 운영자는 직접 만들지 않고 KakaoTalk Channel이 자동으로 소유한다.
- **Channel**: Discord/Telegram/KakaoTalk 대상, KakaoTalk pairing 상태 또는 에이전트 플랫폼 설정, 기본 워크스페이스, 실행 모드, role 매핑을 가진 라우팅 단위.
- **Direct Channel**: Discord DM 또는 Telegram 봇 1:1 대화. 사용자에게는 “직접 사용” 처럼 보이지만, 내부적으로는 세션/워크스페이스/outbox 를 보존하기 위해 Channel 로 저장한다.
- **Messaging worker**: Discord/Telegram/KakaoTalk 플랫폼 수신 프로세스.
- **Role**: 한 turn 안에서 에이전트가 맡는 역할. 기본은 `owner`, tribunal 모드에서는 `owner`, `reviewer`, `arbiter`.
- **Harness / runtime session**: 채널 turn 을 실행하고 role별 메시지/세션/사용량/outbox 를 기록하는 런타임 상태.

런타임 DB에는 주로 다음 상태가 남는다.

- `runtime_runs`: 채널 turn 1회의 상태, active role, round, 최종 disposition
- `runtime_role_messages`: owner/reviewer/arbiter 가 낸 메시지
- `runtime_role_sessions`: `channel.name + role` 기준의 세션 매핑
- `runtime_schedules`: 채널에 붙은 interval/daily 예약 설정과 다음 실행 시각
- `runtime_schedule_runs`: 예약/수동 실행의 lease, heartbeat, 성공/실패 결과
- `runtime_usage_events`: Codex/Claude/Gemini/local LLM 토큰 사용량
- `runtime_outbox_events`: 메시징 플랫폼으로 내보낼 role 메시지 이벤트

### Single 채널

Single 모드에서는 채널의 기본 에이전트가 owner 로 실행된다.

```txt
channel.agent -> owner
```

세션 재사용도 `agent.name` 단독이 아니라 `channel.name:owner` 기준이다. 저장된 세션의 `agentName` 이 현재 `channel.agent` 와 다르면 기존 세션은 무시된다.

### Tribunal 모드

대화에서 `tribu` 라고 부르는 흐름은 코드와 설정에서는 `tribunal` 모드다. 한 채널 안에서 세 역할이 협업한다.

```txt
channel.agent    -> owner
channel.reviewer -> reviewer
channel.arbiter  -> arbiter
```

활성 조건은 `channel.mode = tribunal`. legacy/호환 구성에서 `reviewer` 와 `arbiter` 가 둘 다 있으면 tribunal 로 처리된다.

실행 흐름:

```txt
owner 초안 작성
  ↓
reviewer 검토
  ↓
APPROVED 면 owner 답변을 최종 전송
BLOCKED 면 owner 가 reviewer 피드백으로 재수정
  ↓
reviewRounds 를 다 써도 BLOCKED 면 arbiter 가 최종 응답 작성
```

`reviewer` 는 반드시 다음 둘 중 하나로 시작하는 판정을 내야 한다.

```txt
APPROVED
BLOCKED: <reason>
```

판정이 이 형식을 지키지 않으면 invalid verdict 로 보고 바로 `arbiter` 가 최종 응답을 만든다. 기본 review round 는 2회(`reviewRounds || 2`).

### Role별 세션 정책

```txt
owner    sticky
reviewer sticky
arbiter  ephemeral
```

owner/reviewer 는 이전 turn 의 맥락을 이어갈 수 있게 `channel.name:role` 기준으로 세션을 재사용한다. arbiter 는 최종 판정자라 일회성 세션으로 본다.

### 워크스페이스 기준

채널의 기본 작업 디렉터리는 `channel.workspace` 또는 `channel.workdir` 이고 tribunal 에서는 `ownerWorkspace`/`reviewerWorkspace`/`arbiterWorkspace` 로 role별 override 를 둘 수 있다. 지정하지 않으면 기본 채널 workspace 를 쓴다.

`~` 는 `HOME` 으로 해석되고, 기본값은 `~/workspace` 가 있으면 그 경로, 없으면 `~` 이다.

### 세션 초기화

채널 카드에 Claude 세션이 있으면 웹 어드민에서 `세션 초기화` 버튼이 보인다. 이 동작은 해당 채널의 저장된 runtime session 매핑을 지운다.

```bash
curl -X DELETE \
  http://127.0.0.1:5687/api/channels/<channel-name>/runtime-sessions
```

초기화 후 다음 실행은 새 runtime session 으로 시작한다.

## 보안

- 관리자 암호는 선택 사항이다. `HKCLAW_LITE_ADMIN_PASSWORD` 가 없으면 `hkclaw-lite admin` 은 로그인 없이 바로 뜬다.
- 첫 시작 때 `HKCLAW_LITE_ADMIN_PASSWORD` 가 있으면 SQLite 런타임 DB로 이관된다. 이후에는 웹 어드민에서 바꾼 암호가 기준이고, 세션 쿠키 이름은 `hkclaw_lite_admin_session`, 기본 TTL 은 7일.
- 어드민 서버는 기본 보안 헤더(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`)를 응답에 붙인다. HTTPS 요청에서는 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` 도 추가한다.
- 로그인 세션 쿠키의 `Secure` 속성은 기본값 `auto` 로, `X-Forwarded-Proto: https` 또는 HTTPS 소켓이면 자동 활성화된다. 프록시 구성이 특수하면 `HKCLAW_LITE_ADMIN_COOKIE_SECURE=always|never|auto` 로 강제할 수 있다.

## 백업 / 복구

```bash
hkclaw-lite backup export backup.tar.gz
hkclaw-lite backup import backup.tar.gz --force
```

- 기본은 `.hkclaw-lite/` 의 config, runtime SQLite DB, watcher state 를 같이 묶는다.
- 다른 머신/디렉터리로 옮겨갈 때는 `hkclaw-lite migrate --from <project-root>` 로 가져온다.

## 라이선스

MIT
