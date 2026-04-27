# hkclaw-lite

`hkclaw-lite`는 Discord/Telegram/KakaoTalk 에이전트를 웹 어드민 중심으로 운영하는 경량 런타임이다.

- 기본 진입점은 웹 어드민이다.
- 에이전트는 Codex/Claude/Gemini/local LLM/command 같은 **AI 실행 주체**다.
- 커넥터는 Discord/Telegram/KakaoTalk 같은 **플랫폼 연결 계정/세션**이다. 타입은 `discord`/`telegram`/`kakao`로 고정되어 있고, 인스턴스는 여러 개 만들 수 있다.
- 채널은 **대화가 들어갈 논리 단위**다. 커넥터, 대상 방/사용자 필터, 워크스페이스, 실행 모드, role 매핑, 하네스 세션 경계를 가진다.
- 메시징 워커는 커넥터/legacy 에이전트 연결을 열고, 들어온 메시지는 채널이 정한 하네스로 라우팅한다. 웹 어드민에서는 **채널 → 채널 워커**에서 플랫폼별 워커를 관리한다.
- 기본 웹 주소는 `http://127.0.0.1:5687` 이다.

## 요구 사항

- Node.js 24+
- 기본 설치 시 내부 번들만 사용한다.
- 시스템 `PATH`에 있는 `codex` / `gemini`로 자동 fallback하지 않는다.
- Claude는 기본적으로 내부 번들을 쓰지만, 필요하면 `HKCLAW_LITE_CLAUDE_CLI=claude` 같은 환경 변수로 외부 CLI를 명시적으로 지정할 수 있다.

기본 번들 버전:

- `@openai/codex@0.120.0`
- `@anthropic-ai/claude-agent-sdk@0.2.105`
- `@google/gemini-cli@0.37.1`

Claude 외부 CLI를 쓰고 싶다면:

```bash
export HKCLAW_LITE_CLAUDE_CLI=claude
hkclaw-lite admin
```

- 이 경우 Claude 실행/상태 확인/로그아웃은 외부 `claude` CLI를 사용한다.
- 로그인 상태는 같은 머신/같은 환경의 로컬 Claude CLI 로그인 상태를 그대로 공유한다.
- 웹 어드민의 Claude 브라우저 로그인은 번들 런타임용 흐름이고, 외부 CLI 모드에서는 터미널에서 `claude auth login` 후 상태 확인을 누르면 된다.

## 1. npm 설치

가장 단순한 방법이다.

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

- 웹 어드민은 `5687` 포트에서 뜬다.
- 에이전트/채널/AI 로그인은 웹에서 관리한다.
- 실제 Discord/Telegram/KakaoTalk 연결은 커넥터 또는 legacy 에이전트 연결 기준으로 제어한다.

## 2. Docker

퍼블릭 이미지:

```bash
docker pull ghcr.io/tkfka1/hkclaw-lite:latest
```

웹 어드민 실행:

```bash
docker run --rm \
  -p 5687:5687 \
  -v hkclaw-lite-data:/home/hkclaw \
  -v $(pwd):/workspace \
  ghcr.io/tkfka1/hkclaw-lite:latest \
  admin --host 0.0.0.0 --port 5687
```

운영 메모:

- `/home/hkclaw`는 로그인 상태와 런타임 상태를 유지하는 용도다.
- `/workspace`는 Docker 실행 예시에서 실제 작업 디렉터리를 붙이는 용도다.
- 기본 Helm 배포는 단일 웹 어드민 Pod다. 웹 어드민에서 워커를 시작하면 같은 컨테이너 안에서 child process로 실행된다.
- 컨테이너 이미지 기준 기본 채널 워크스페이스는 `/workspace` 다. `~` 는 명시적으로 썼을 때만 `HOME` 으로 해석된다.
- 컨테이너는 자동으로 역할을 추측하지 않는다. `admin`, `run`, `discord serve`, `telegram serve`, `kakao serve` 중 어떤 명령을 띄울지 직접 넘겨야 한다.
- 컨테이너에는 운영용 기본 도구로 `ssh`, `kubectl`, `argocd`, `git`, `ripgrep`가 같이 들어간다.

## 3. Helm

기본 차트는 웹 어드민을 띄운다.

```bash
helm upgrade --install hkclaw-lite ./charts/hkclaw-lite \
  --set image.repository=ghcr.io/tkfka1/hkclaw-lite \
  --set image.tag=latest
```

접속:

```bash
kubectl port-forward svc/hkclaw-lite 5687:5687
```

기본값:

- `admin --host 0.0.0.0 --port 5687`
- `HOME=/home/hkclaw`
- 상태 저장용 PVC 사용
- 기본 채널 워크스페이스는 `/home/hkclaw/workspace`
- 별도 workspace PVC는 기본 비활성화
- KakaoTalk 상시 수신은 `workers.kakao.enabled=true` 로 같은 Pod 안의 `kakao serve` sidecar를 켤 수 있다.
- 기본 Deployment 전략은 `Recreate` 다. state/workspace PVC가 `ReadWriteOnce` 이고 runtime SQLite DB와 플랫폼 워커 상태를 한 Pod가 소유해야 하므로 배포 중에도 중복 Pod를 만들지 않는다.

운영 주의:

- 기본 동작은 단일 Pod 운영이다. 웹 어드민이 Discord/Telegram/KakaoTalk 워커를 같은 컨테이너 안에서 child process로 띄운다.
- `READY 2/2` 는 Pod 두 개가 아니라 한 Pod 안의 웹 어드민 컨테이너와 Kakao sidecar 두 컨테이너가 모두 Ready라는 뜻이다.
- GitOps로 KakaoTalk 수신을 항상 켜두려면 별도 Deployment보다 `workers.kakao.enabled=true` sidecar를 권장한다. 같은 Pod라서 state/workspace PVC를 안전하게 공유하고, `kakao serve` 하나가 설정된 Kakao 커넥터/legacy 에이전트 연결과 채널을 모두 처리한다.
- RollingUpdate의 `maxSurge=1` 처럼 새 Pod와 기존 Pod가 동시에 뜨는 전략은 이 차트의 기본 운영 형태와 맞지 않는다. 정말 여러 Pod/Deployment로 분리하려면 각 Pod가 별도 state를 쓰거나, 워커별 소유 범위와 PVC 접근 방식을 명시적으로 설계해야 한다.
- worker 재기동 복구는 runtime SQLite DB에 저장된 서비스 런타임 스냅샷을 우선 사용한다. sidecar worker는 Pod 재시작 시 Kubernetes가 직접 살린다. 웹 어드민 child-process worker를 새 배포 환경에 맞춰 반영하려면 웹 어드민에서 해당 워커를 한 번 다시 실행하거나 재시작하면 된다.
- Helm 기본 배포는 단일 state PVC 안의 `/home/hkclaw/workspace` 를 채널 기본 workdir 로 사용한다.
- 별도 작업용 볼륨을 쓰고 싶을 때만 `workspace.enabled=true` 로 켜고 원하는 마운트 경로를 준다.
- `~` 를 명시적으로 쓰면 `HOME` 으로 해석되고 Helm 기본값에서는 `/home/hkclaw` 를 뜻한다.
- `discord serve`, `telegram serve`, `kakao serve` 를 정말 별도 Deployment/Pod로 분리할 때만 `/home/hkclaw` PVC를 admin Pod와 공유해야 한다. 그렇지 않으면 Claude 로그인 상태와 `.hkclaw-lite` 프로젝트 상태가 분리된다.

즉 Helm 기본 배포는 단일 웹 어드민 Pod 기준이고, 별도 role Pod가 필요할 때만 `args`를 override 하면 된다.

### Kubernetes / GitOps 인증 기준

이미지 안에는 `kubectl`과 `argocd`가 들어있지만, 차트가 클러스터 권한을 자동으로 열어주지는 않는다.

- 기본값은 `serviceAccount.create=true`, `serviceAccount.automountServiceAccountToken=false` 다.
- 그래서 Pod 안에서 `kubectl`을 실행해도 기본 ServiceAccount 토큰이 자동 주입되지 않는다.
- 클러스터 내부 권한이 필요하면 명시적으로 `serviceAccount.automountServiceAccountToken=true` 로 켜고, 필요한 RBAC를 별도로 붙여야 한다.
- 클러스터 외부 권한이 필요하면 kubeconfig를 Secret/PVC/extraVolume 등으로 직접 마운트하거나 환경 변수로 넘겨야 한다.
- GitOps 운영에서는 앱 저장소를 직접 `kubectl apply` 하는 방식보다, values 저장소의 image tag/digest를 갱신하고 Argo CD가 sync 하게 두는 방식이 기본이다.
- 관리자 암호는 `HKCLAW_LITE_ADMIN_PASSWORD` 로 bootstrap 할 수 있다. Helm에서는 `adminSecret` 또는 `adminExternalSecret`이 이 값을 주입한다.

관리자 암호는 첫 시작 때 SQLite 런타임 DB로 이관된다. 이후에는 웹 어드민에서 바꾼 암호가 기준이고, 세션 쿠키 이름은 `hkclaw_lite_admin_session`, 기본 TTL은 7일이다.
어드민 서버는 기본 보안 헤더(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`)를 응답에 붙인다. HTTPS 요청에서는 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`도 같이 추가한다.
로그인 세션 쿠키의 `Secure` 속성은 기본값 `auto` 로, `X-Forwarded-Proto: https` 또는 HTTPS 소켓이면 자동 활성화된다. 프록시 구성이 특수하면 `HKCLAW_LITE_ADMIN_COOKIE_SECURE=always|never|auto` 로 강제할 수 있다.

AI 로그인은 Kubernetes ServiceAccount가 아니라 컨테이너의 `HOME` 기준이다. Helm 기본값에서는 `HOME=/home/hkclaw` 이고, 이 경로가 state PVC에 저장된다. Codex/Claude/Gemini 로그인 상태와 `.hkclaw-lite` 런타임 상태도 이 PVC에 남는다.

## 기본 흐름

1. `admin`을 띄운다.
2. 웹에서 AI 로그인부터 끝낸다.
3. 에이전트를 만든다.
4. 플랫폼 커넥터를 만든다. 기존 에이전트 토큰 방식은 legacy 호환으로 계속 읽힌다.
5. 채널을 만들고 커넥터 + 실행 에이전트/role을 연결한다.
6. 해당 플랫폼 워커를 실행한다. Kakao는 보통 `kakao serve` sidecar 하나가 모든 Kakao 커넥터를 처리한다.

## 주요 명령

```bash
hkclaw-lite admin
hkclaw-lite add connector
hkclaw-lite run --channel <name> --message "hello"
hkclaw-lite discord serve --connector <connector-name>
hkclaw-lite telegram serve --connector <connector-name>
hkclaw-lite kakao serve --connector <connector-name>
```

`admin`은 웹 어드민, `run`은 one-shot 실행, `add connector`는 플랫폼 연결 계정/세션 추가, `discord serve`/`telegram serve`/`kakao serve`는 플랫폼 워커를 직접 띄우는 명령이다. 특정 커넥터만 띄우려면 `--connector <name>`을 쓰고, 마이그레이션 호환을 위해 `--agent <legacy-agent-name>`도 지원한다.

## KakaoTalk 채널

KakaoTalk 지원은 [`@openclaw/kakao-talkchannel`](https://github.com/kakao-bart-lee/openclaw-kakao-talkchannel-plugin) 플러그인과 [`kakao-talkchannel-relay-openclaw`](https://github.com/kakao-bart-lee/kakao-talkchannel-relay-openclaw)의 릴레이 구조를 참고했다. 운영 편의성을 위해 기본 배포에서는 **hkclaw-lite Admin 서버가 Kakao TalkChannel 릴레이 API를 내장 제공**한다.

### 구성 모델

현재 모델은 아래처럼 나뉜다.

| 위치 | 의미 | Kakao에서 넣는 값 |
| --- | --- | --- |
| Connector | Kakao 연결 계정/세션. 타입은 `kakao`로 고정되고 이름으로 여러 인스턴스를 구분한다. | Kakao 연결 릴레이 URL, 연결 토큰 또는 세션 토큰 |
| Agent | 메시지를 처리할 AI 실행 주체 | Codex/Claude/Gemini/local LLM/command 설정 |
| Channel | 들어온 메시지를 어느 커넥터/하네스/워크스페이스/role 구성으로 실행할지 정하는 논리 대화 단위 | Kakao 수신 channelId 필터, Kakao 사용자 ID 필터 |

- 커넥터의 `type`은 정해져 있다. KakaoTalk이면 `kakao`이고, 같은 타입의 커넥터 인스턴스는 `kakao-main`, `kakao-support`처럼 여러 개 만들 수 있다.
- 웹 어드민의 **채널** 화면에서 커넥터를 추가/수정/삭제하고, 채널 추가/수정 모달에서 사용할 커넥터를 고른다. CLI에서는 `hkclaw-lite add connector`를 쓴다.
- 같은 화면의 **채널 워커** 카드에서 Discord/Telegram/KakaoTalk 플랫폼 워커를 시작/재시작/중지한다. 커넥터 기반 채널은 에이전트별 토큰 버튼이 아니라 이 플랫폼 워커가 수신을 담당한다.
- **커넥터 하나로 여러 hkclaw 채널을 처리할 수 있다.** 채널마다 같은 커넥터를 선택하고 `kakaoChannelId`, `kakaoUserId`, workspace, single/tribunal role 구성을 다르게 두면 된다.
- 여러 커넥터가 필요한 경우는 서로 다른 Kakao 계정/세션/토큰, 운영 격리, 장애 격리가 필요할 때다.
- `Kakao 연결 릴레이 URL`은 워커가 SSE를 붙을 릴레이 주소다. `OPENCLAW_TALKCHANNEL_RELAY_URL` 또는 `KAKAO_TALKCHANNEL_RELAY_URL` 환경 변수가 있으면 그 값을 기본값으로 쓴다. 값이 없으면 공유 릴레이 `https://k.tess.dev/`를 기본값으로 쓴다.
- `Kakao 연결 토큰` 또는 `Kakao 세션 토큰`은 선택값이다.
- 토큰을 비워두면 워커 시작 시 릴레이 세션을 만들고 `/pair <code>` 형태의 페어링 코드를 상태에 표시한다.
- 채널의 `Kakao 수신 channelId 필터`는 기본적으로 `*`를 쓰면 된다. 특정 릴레이/OpenBuilder channelId만 이 hkclaw-lite 채널로 보내려면 그 값을 넣는다.
- `Kakao 사용자 ID 필터`를 넣으면 해당 paired user만 해당 채널로 라우팅한다.
- 같은 커넥터 안에서는 Kakao 라우팅 필터가 겹치면 저장을 막는다. 예를 들어 `kakaoChannelId=*`이고 사용자 필터가 빈 채널을 같은 커넥터에 두 개 만들 수 없다. 여러 채널을 나누려면 `kakaoChannelId`나 `kakaoUserId`를 좁혀서 각 메시지가 정확히 한 채널에만 매칭되게 한다.
- 그래서 hkclaw-lite의 **Channel은 역할이 있다.** Kakao 연결 자체를 여는 것은 Connector/worker지만, 어떤 workspace, single/tribunal 모드, owner/reviewer/arbiter role 세션으로 실행할지는 Channel이 결정한다.
- 기존처럼 에이전트에 Kakao 연결값이 붙어 있는 설정은 legacy 호환으로 계속 읽고, 로드 시 같은 이름의 Kakao 커넥터처럼 취급한다.

### 빠른 FAQ (혼동 포인트 정리)

- **Q. `*` 는 무엇인가요?**  
  - `Kakao 수신 channelId 필터`에서 `*`는 `모든 channelId`를 허용합니다. 즉, 필터를 좁히지 않겠다는 뜻입니다.  
  - 특정 채널만 받으려면 `channelId`를 정확히 지정하세요.
- **Q. connector, channel, worker, 에이전트는 각각 뭐가 다른가요?**
  - **Connector**: KakaoTalk 접속 계정/세션 정보(인증 수단)입니다.
  - **Channel**: 어떤 메시지를 누구에게 보낼지(워크스페이스, mode, 역할 매핑, 필터) 결정하는 실행 규칙입니다.
  - **Worker(`kakao serve`)**: 실제로 relay로부터 event를 받고 채널 규칙에 따라 실행을 위임합니다.
  - **Agent**: 실제 응답을 생성하는 실행 모델(LLM/커맨드)이며, 채널의 role(owner/reviewer/arbiter) 기준으로 동작합니다.
- **Q. "릴레이 서버를 별도로 배포해야 하나요?"**  
  - 기본값은 **별도 배포가 필요 없습니다.** `admin` 서비스와 같은 HTTP 서버에 relay 엔드포인트가 내장되어 동작합니다.
  - 외부 relay를 강제로 쓰고 싶다면 `Kakao 연결 릴레이 URL`을 별도 URL로 지정하면 됩니다.
- **Q. 채널마다 worker를 하나씩 만들어야 하나요?**
  - 기본적으로 **`kakao serve` 하나로 충분**합니다. 설정된 모든 Kakao Connector를 읽고 SSE를 연결해 처리할 수 있습니다.
  - 여러 worker가 필요한 건 트래픽 분산/격리 정책, 혹은 완전 분리된 계정/토큰을 채널 단위가 아닌 **Connector 단위**로 분리해야 할 때입니다.
- **Q. Tribu(tribunal)는 어디서 동작하나요?**
  - 채널 설정에서 `mode`가 tribunal로 정해지면 `owner / reviewer / arbiter` 흐름으로 같은 채널에서 순차 협업합니다.  
  - 에이전트별이 아니라 **채널:role** 조합(`channelName:owner` etc)으로 하네스 세션이 분리됩니다.

### 배포 단위

- **릴레이 서버/엔드포인트는 hkclaw-lite 인스턴스당 하나면 된다.** Admin HTTP 서버가 `/kakao-talkchannel/webhook`, `/v1/events`, `/openclaw/reply`를 같이 제공한다.
- **`Kakao 수신 channelId 필터`는 Kubernetes 배포 단위가 아니라 라우팅 필터다.** 보통은 `*`로 두고, 특정 OpenBuilder/릴레이 channelId만 받을 때만 값을 좁힌다.
- **worker도 보통 하나면 충분하다.** `kakao serve` 하나가 설정된 모든 KakaoTalk 커넥터를 읽고 커넥터별 SSE 세션을 만든 뒤, 들어온 메시지를 `connector`, `kakaoChannelId`, `kakaoUserId` 기준으로 채널에 라우팅한다.
- 채널마다 Pod/Deployment를 하나씩 만들 필요는 없다. 내장 릴레이는 같은 session token에 마지막 SSE consumer만 유지하고, 웹 어드민은 전체 Kakao 플랫폼 worker와 scoped worker가 겹쳐 뜨는 것을 막는다. 외부 릴레이나 직접 분리 배포를 쓸 때도 담당 커넥터가 겹치지 않게 나눠야 한다.
- 여러 worker가 필요한 경우는 트래픽/장애 격리, 서로 다른 Kakao 계정/토큰을 완전히 분리해야 하는 운영 요구가 있을 때다. 이 경우에도 보통 “채널별”보다 “커넥터/계정별”로 분리하고 `kakao serve --connector <connector-name>`처럼 담당 범위를 명확히 나눈다.
- GitOps 운영에서는 `workers.kakao.enabled=true`로 같은 Pod 안의 sidecar를 켜는 구성을 권장한다. 별도 Pod로 분리하면 ReadWriteOnce state PVC와 AI 로그인 상태 공유 문제가 생길 수 있다.

### 실행 흐름

```txt
kakao serve
  ↓
커넥터별 릴레이 세션 생성 또는 기존 token 사용
  ↓
SSE: <relay>/v1/events 수신
  ↓
채널 매칭(connector, kakaoChannelId 필터, kakaoUserId 필터)
  ↓
executeChannelTurn
  ↓
Reply: <relay>/openclaw/reply 로 Kakao SkillResponse 전송
```

일반 텍스트는 카카오 `simpleText`로 전송하고, 응답이 JSON 카드 형식이면 `textCard`, `basicCard`, `listCard`, `quickReplies` 같은 Kakao SkillResponse 카드로 변환한다.

### 내장 릴레이 엔드포인트

`admin` 서버는 웹 어드민과 같은 HTTP 서버에서 아래 릴레이 엔드포인트를 같이 제공한다. `/api/*`와 달리 Kakao/OpenClaw 릴레이 프로토콜용 엔드포인트라 웹 어드민 로그인 쿠키를 요구하지 않는다.

- `GET /v1/healthz` 또는 `/kakao-talkchannel/healthz`: 내장 릴레이 health/smoke 확인.
- `POST /v1/sessions/create`: 토큰 없는 Kakao 커넥터가 pairing session 생성.
- `GET /v1/events`: Kakao 워커가 SSE로 pairing/message 이벤트 수신.
- `POST /openclaw/reply`: Kakao 워커가 OpenBuilder callback으로 최종 답변 전송.
- `POST /kakao-talkchannel/webhook`: Kakao i OpenBuilder Skill URL.
- `GET /v1/sessions/{sessionToken}/status`: pairing 상태 확인.

현재 IDC GitOps 배포는 릴레이 URL을 hkclaw-lite 자체 주소로 둔다.

```yaml
env:
  OPENCLAW_TALKCHANNEL_RELAY_URL: https://hkclawtest.idc.hkyo.kr/
```

카카오 i 오픈빌더 스킬 URL은 hkclaw-lite의 `/kakao-talkchannel/webhook` 엔드포인트로 설정한다.

```txt
https://hkclawtest.idc.hkyo.kr/kakao-talkchannel/webhook
```

토큰을 비워 둔 Kakao 커넥터는 워커 시작 시 내장 릴레이에 session을 만들고 pairing code를 상태에 표시한다. 사용자가 카카오톡에서 `/pair <code>`를 입력하면 해당 대화가 session과 연결되고 이후 메시지는 `channel + role` 하네스로 라우팅된다. 외부 릴레이를 계속 쓰고 싶으면 커넥터의 `Kakao 연결 릴레이 URL`을 별도 릴레이 주소로 직접 지정하면 된다.

## 채널, 에이전트, 하네스 관리 모델

헷갈리기 쉬운 부분은 이것이다.

`hkclaw-lite`의 대화 하네스와 세션 경계는 **에이전트 단독 기준이 아니라 채널 + 역할(role) 기준**이다.

```txt
session_key = <channel.name>:<role>
```

예를 들면:

```txt
main:owner
main:reviewer
main:arbiter
ops:owner
```

같은 에이전트를 여러 채널에 붙여도 각 채널은 별도 세션 컨텍스트를 가진다.

### 용어

- **Agent**: Codex, Claude, Gemini, local LLM, command runner 같은 실제 실행 주체다. 모델, 명령, fallback을 가진다. 플랫폼 토큰은 legacy 호환으로 계속 읽지만 신규 구성은 Connector에 둔다.
- **Connector**: Discord/Telegram/KakaoTalk 연결 계정/세션이다. 타입은 고정이고 인스턴스는 여러 개 만들 수 있으며, 한 Connector를 여러 Channel이 공유할 수 있다.
- **Channel**: Discord/Telegram/KakaoTalk 대상, Connector, 기본 워크스페이스, 실행 모드, role 매핑을 가진 실행 단위다.
- **Channel worker**: Discord/Telegram/KakaoTalk 플랫폼 수신 프로세스다. 커넥터 기반 채널은 Agent 카드가 아니라 Channel 화면의 워커 카드에서 상태를 본다.
- **Role**: 한 turn 안에서 에이전트가 맡는 역할이다. 기본은 `owner`, tribunal 모드에서는 `owner`, `reviewer`, `arbiter`가 있다.
- **Harness / runtime session**: 채널 turn을 실행하고, role별 메시지/세션/사용량/outbox를 기록하는 런타임 상태다.

런타임 DB에는 주로 다음 상태가 남는다.

- `runtime_runs`: 채널 turn 1회의 상태, active role, round, 최종 disposition.
- `runtime_role_messages`: owner/reviewer/arbiter가 낸 메시지.
- `runtime_role_sessions`: `channel.name + role` 기준의 세션 매핑.
- `runtime_outbox_events`: 메시징 플랫폼으로 내보낼 role 메시지 이벤트.

KakaoTalk 릴레이 reply는 원본 `messageId`가 있어야 하므로, inbound SSE 이벤트를 처리하는 동안 즉시 전송한다. 프로세스가 중간에 죽어 원본 `messageId`를 잃은 orphan outbox는 안전하게 재전송할 수 없다.

### Single 채널

Single 모드에서는 채널의 기본 에이전트가 owner로 실행된다.

```txt
channel.agent -> owner
```

흐름:

1. `hkclaw-lite run --channel <name>` 또는 메시징 워커가 채널 turn을 시작한다.
2. `channel.agent`를 찾아 `owner` role로 실행한다.
3. 결과를 `runtime_runs`, `runtime_role_messages`, `runtime_role_sessions`에 기록한다.
4. Discord/Telegram/KakaoTalk 워커가 필요한 경우 outbox 이벤트를 전송한다.

세션 재사용도 `agent.name` 단독이 아니라 `channel.name:owner` 기준이다. 저장된 세션의 `agentName`이 현재 `channel.agent`와 다르면 기존 세션은 무시된다. 에이전트를 바꿨는데 옛 Claude 세션에 잘못 붙는 사고를 막기 위한 장치다.

### Tribunal, 또는 tribu 흐름

대화에서 `tribu`라고 부르는 흐름은 코드와 설정에서는 `tribunal` 모드다.

Tribunal은 한 채널 안에서 세 에이전트 역할이 협업하는 모드다.

```txt
channel.agent    -> owner
channel.reviewer -> reviewer
channel.arbiter  -> arbiter
```

활성 조건:

```txt
channel.mode = tribunal
```

또는 legacy/호환 구성에서 `reviewer`와 `arbiter`가 둘 다 있으면 tribunal로 처리된다.

실행 흐름:

```txt
owner 초안 작성
  ↓
reviewer 검토
  ↓
APPROVED면 owner 답변을 최종 전송
BLOCKED면 owner가 reviewer 피드백으로 재수정
  ↓
reviewRounds를 다 써도 BLOCKED면 arbiter가 최종 응답 작성
```

`reviewer`는 반드시 다음 둘 중 하나로 시작하는 판정을 내야 한다.

```txt
APPROVED
BLOCKED: <reason>
```

판정이 이 형식을 지키지 않으면 invalid verdict로 보고 바로 `arbiter`가 최종 응답을 만든다.

기본 review round는 2회다.

```txt
reviewRounds || 2
```

### Role별 세션 정책

Claude CLI 같은 sticky session을 지원하는 런타임은 role별로 다르게 다룬다.

```txt
owner    sticky
reviewer sticky
arbiter  ephemeral
```

owner/reviewer는 이전 turn의 맥락을 이어갈 수 있게 `channel.name:role` 기준으로 세션을 재사용한다. arbiter는 최종 판정자 성격이라 기본적으로 일회성 세션으로 본다.

최근 role 히스토리도 owner/reviewer 중심으로 주입된다. arbiter는 이전 판정보다 현재 owner 초안과 reviewer 피드백을 보고 최종 결정을 내리는 쪽에 가깝다.

### 워크스페이스 기준

채널의 기본 작업 디렉터리는 `channel.workspace` 또는 `channel.workdir`다.

Tribunal에서는 role별 override를 둘 수 있다.

```txt
ownerWorkspace
reviewerWorkspace
arbiterWorkspace
```

지정하지 않으면 기본 채널 workspace를 쓴다. Helm 기본 배포에서는 `/home/hkclaw/workspace`가 기본 채널 워크스페이스다.

### 세션 초기화

채널 카드에 Claude 세션이 있으면 웹 어드민에서 `세션 초기화` 버튼이 보인다. 이 동작은 해당 채널의 저장된 runtime session 매핑을 지운다.

API로는 다음과 같다.

```bash
curl -X DELETE \
  http://127.0.0.1:5687/api/channels/<channel-name>/runtime-sessions
```

초기화 후 다음 실행은 새 runtime session으로 시작한다.

## GitHub 릴리즈 / 배포 자동화

이 저장소는 GitHub Actions 기준으로 릴리즈-배포 흐름을 자동화한다.

### 포함된 워크플로우

- `CI` (`.github/workflows/ci.yml`)
  - PR / `main` push / 수동 실행에서 `npm ci` + `npm test`
- `Prepare Release` (`.github/workflows/release-prepare.yml`)
  - GitHub Actions 수동 실행용
  - `patch` / `minor` / `major` / `custom` 중 하나를 선택하면
    `package.json`, `package-lock.json`, `charts/hkclaw-lite/Chart.yaml` 버전을 함께 올린다.
  - 테스트 통과 후 릴리즈 커밋과 `vX.Y.Z` 태그를 자동으로 push 한다.
- `Publish Release` (`.github/workflows/release.yml`)
  - `v*` 태그 push 시 실행
  - 버전 동기화 검증
  - `NPM_TOKEN` 이 있으면 `npm publish --provenance` 실행
  - `NPM_TOKEN` 이 없으면 npm publish만 warning으로 건너뛰고 GitHub Release 자산은 계속 업로드
  - GitHub Release 생성/업데이트
  - npm 패키지 tarball, chart tarball, SHA256SUMS 업로드
- `Publish Container` (`.github/workflows/container-publish.yml`)
  - `main` push 때 `latest`/`sha-*` 이미지 publish
  - `v*` 태그 push 때 `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X` 태그까지 함께 publish

### 필요한 GitHub Secrets

- `NPM_TOKEN`: npm 배포용 토큰. 없으면 GitHub Release와 컨테이너 이미지는 계속 만들지만 npm publish는 건너뛴다.

### 운영 방법

1. GitHub Actions에서 `Prepare Release` 실행
2. `bump` 를 `patch`, `minor`, `major`, `custom` 중에서 선택
3. `custom` 이면 `version` 에 정확한 semver 입력 (`1.2.3`)
4. 워크플로우가 버전 파일 동기화 + 테스트 + 커밋 + `vX.Y.Z` 태그 push 수행
5. 태그가 올라가면 `Publish Release` 와 `Publish Container` 가 자동 실행
6. 사용자-facing 변경은 `CHANGELOG.md`에 함께 기록

### 버전 정책

다음 값은 항상 같이 움직이도록 맞춰뒀다.

- `package.json#version`
- `package-lock.json#version`
- `package-lock.json#packages[""].version`
- `charts/hkclaw-lite/Chart.yaml#version`
- `charts/hkclaw-lite/Chart.yaml#appVersion`

로컬에서 수동으로 맞추고 싶으면:

```bash
npm run release:sync-version -- 1.2.3
npm run release:verify-version -- v1.2.3
```
