# hkclaw-lite

`hkclaw-lite`는 Discord/Telegram/KakaoTalk 에이전트를 웹 어드민 중심으로 운영하는 경량 런타임이다.

- 기본 진입점은 웹 어드민이다.
- 에이전트는 Codex/Claude/Gemini/local LLM/command 같은 **AI 실행 주체**다.
- 커넥터는 **KakaoTalk 전용 연결 계정/세션**이다. 타입은 `kakao`로 고정되어 있고, Discord/Telegram 토큰은 에이전트 플랫폼 설정에서 직접 관리한다.
- 채널은 **대화가 들어갈 논리 단위**다. Kakao 커넥터 또는 에이전트 플랫폼 설정, 대상 방/사용자 필터, 워크스페이스, 실행 모드, role 매핑, 하네스 세션 경계를 가진다.
- 메시징 워커는 Discord/Telegram 에이전트 토큰 또는 Kakao 커넥터 세션을 열고, 들어온 메시지는 채널이 정한 하네스로 라우팅한다. 채널은 수신 프로세스가 아니라 라우팅 규칙이다.
- CLI 자동화가 필요하면 `topology plan/apply/export`로 에이전트/커넥터/채널 desired-state JSON을 dry-run 후 적용할 수 있다.
- 기본 웹 주소는 `http://127.0.0.1:5687` 이다.

## 요구 사항

- Node.js 24+
- 기본 설치 시 내부 번들만 사용한다.
- 시스템 `PATH`에 있는 `codex` / `gemini`로 자동 fallback하지 않는다.
- Claude는 기본적으로 내부 번들을 쓰지만, 필요하면 `HKCLAW_LITE_CLAUDE_CLI=claude` 같은 환경 변수로 외부 CLI를 명시적으로 지정할 수 있다.

기본 번들 버전:

- `@openai/codex@0.125.0`
- `@anthropic-ai/claude-agent-sdk@0.2.119`
- `@google/gemini-cli@0.39.1`

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

macOS에서 Homebrew tap이 준비된 뒤에는 다음처럼 설치할 수 있다:

```bash
brew install tkfka1/tap/hkclaw-lite
hkclaw-lite admin
```

Homebrew로 설치한 macOS에서는 `hkclaw-lite admin`이 launchd 서비스를 자동 등록/시작한다. 터미널에 묶어서 직접 띄우고 싶을 때만:

```bash
hkclaw-lite admin --foreground
```

서비스를 수동으로 관리할 때:

```bash
brew services start tkfka1/tap/hkclaw-lite
brew services restart hkclaw-lite
brew services stop hkclaw-lite
```

Homebrew 서비스는 `/usr/local/var/hkclaw-lite` 또는 `/opt/homebrew/var/hkclaw-lite`를 프로젝트 루트로 쓰고, `0.0.0.0:5687`로 실행한다.

Homebrew formula는 npm release tarball을 받아 `std_npm_args`로 설치하므로 npm 배포 버전과 같은 CLI/선택 의존성(Codex/Gemini/Claude 번들)을 사용한다.

설치 후:

- 웹 어드민은 `5687` 포트에서 뜬다.
- 에이전트/채널/AI 로그인은 웹에서 관리한다.
- 채널이 있으면 필요한 Discord/Telegram/KakaoTalk 수신 워커는 자동으로 켜진다.
- KakaoTalk 연결은 **KakaoTalk 전용 커넥터**로 재사용하고, Discord/Telegram 토큰은 각 에이전트 설정에서 관리한다.

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
- Docker는 호스트의 `~/.codex`, `~/.claude`, `~/.gemini`, `~/.kube` 권한을 자동으로 쓰지 않는다. 컨테이너 안의 `HOME=/home/hkclaw` 기준으로 별도 로그인/권한 상태를 저장한다.
- `-v $(pwd):/workspace`로 마운트한 디렉터리는 컨테이너 안 작업 권한으로 접근한다. 프로세스는 기본 UID/GID `10001:10001`로 실행되므로 호스트 파일 권한이 맞아야 쓰기가 된다.
- 호스트 로그인 상태를 꼭 공유하려면 해당 설정 디렉터리나 kubeconfig를 명시적으로 마운트해야 한다. 이 경우 컨테이너가 그 로컬 권한을 그대로 쓰므로 신뢰하는 환경에서만 사용한다.
- 기본 Helm 배포는 단일 웹 어드민 Pod다. 웹 어드민에서 워커를 시작하면 같은 컨테이너 안에서 child process로 실행된다.
- 컨테이너 이미지 기준 기본 채널 워크스페이스는 `/workspace` 다. `~` 는 명시적으로 썼을 때만 `HOME` 으로 해석된다.
- 컨테이너는 자동으로 역할을 추측하지 않는다. `admin`, `run`, `discord serve`, `telegram serve`, `kakao serve` 중 어떤 명령을 띄울지 직접 넘겨야 한다.
- 컨테이너에는 운영용 기본 도구로 `ssh`, `kubectl`, `argocd`, `git`, `ripgrep`가 같이 들어간다.
- 이미지 빌드 기본값은 `package-lock.json`에 고정된 Codex/Claude/Gemini 번들을 설치한다. 빌드 시점 최신 번들을 받고 싶으면 아래처럼 build arg를 줄 수 있다. `latest` 대신 정확한 버전을 넣으면 재현 가능한 이미지가 된다.

```bash
docker build -t hkclaw-lite:ai-latest \
  --build-arg HKCLAW_LITE_CODEX_CLI_VERSION=latest \
  --build-arg HKCLAW_LITE_CLAUDE_AGENT_SDK_VERSION=latest \
  --build-arg HKCLAW_LITE_GEMINI_CLI_VERSION=latest \
  .
```

컨테이너 시작/배포 시점마다 CLI를 새로 다운로드하는 방식도 기술적으로는 가능하지만, 네트워크 장애와 비재현 배포 위험이 커서 기본값으로 두지 않는다. 운영에서는 CI나 로컬에서 이미지를 다시 빌드해 태그/다이제스트로 배포하는 방식을 권장한다.

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
- state PVC 기본 크기는 `25Gi`
- 기본 채널 워크스페이스는 `/home/hkclaw/workspace`
- 별도 workspace PVC는 기본 비활성화, 켜면 기본 크기는 `25Gi`
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

### Helm 스토리지 확장

차트가 직접 만드는 state/workspace PVC는 `25Gi` 미만으로 설정할 수 없다. 운영 중 용량을 키울 때는 웹 어드민의 **전체 설정 → 스토리지** 화면에서 현재 PVC를 확인하고 `+25GB`, `+50GB`, `+100GB` 단위로 확장을 요청할 수 있다.

이 기능은 기본 비활성화다. 클러스터 StorageClass가 `allowVolumeExpansion=true` 를 지원할 때만 켠다.

```bash
helm upgrade --install hkclaw-lite ./charts/hkclaw-lite \
  --set image.repository=ghcr.io/tkfka1/hkclaw-lite \
  --set image.tag=latest \
  --set storageResize.rbac.enabled=true
```

`storageResize.rbac.enabled=true` 는 이 릴리스의 state/workspace PVC에 대한 `get`/`patch` 권한만 Role로 붙이고, Pod의 ServiceAccount 토큰 자동 마운트를 켠다. 기존 PVC 이름을 쓰는 경우에도 해당 claim 이름만 대상으로 제한된다.

### Kubernetes / GitOps 인증 기준

이미지 안에는 `kubectl`과 `argocd`가 들어있지만, 차트가 클러스터 권한을 자동으로 열어주지는 않는다.

- 기본값은 `serviceAccount.create=true`, `serviceAccount.automountServiceAccountToken=false` 다.
- 그래서 Pod 안에서 `kubectl`을 실행해도 기본 ServiceAccount 토큰이 자동 주입되지 않는다.
- 클러스터 내부 권한이 필요하면 명시적으로 `serviceAccount.automountServiceAccountToken=true` 로 켜고, 필요한 RBAC를 별도로 붙여야 한다. 스토리지 확장만 필요하면 `storageResize.rbac.enabled=true` 를 쓰면 된다.
- 클러스터 외부 권한이 필요하면 kubeconfig를 Secret/PVC/extraVolume 등으로 직접 마운트하거나 환경 변수로 넘겨야 한다.
- GitOps 운영에서는 앱 저장소를 직접 `kubectl apply` 하는 방식보다, values 저장소의 image tag/digest를 갱신하고 Argo CD가 sync 하게 두는 방식이 기본이다.
- 관리자 암호는 선택 사항이다. `HKCLAW_LITE_ADMIN_PASSWORD` 가 없으면 `hkclaw-lite admin`과 Helm Pod는 로그인 없이 바로 뜬다.
- 암호가 필요할 때만 `HKCLAW_LITE_ADMIN_PASSWORD` 로 bootstrap 한다. Helm에서는 `adminSecret` 또는 `adminExternalSecret`이 이 값을 주입할 수 있지만, Secret이 비어 있거나 아직 없어도 Pod 시작은 막지 않는다.

관리자 암호는 첫 시작 때 SQLite 런타임 DB로 이관된다. 이후에는 웹 어드민에서 바꾼 암호가 기준이고, 세션 쿠키 이름은 `hkclaw_lite_admin_session`, 기본 TTL은 7일이다.
어드민 서버는 기본 보안 헤더(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`)를 응답에 붙인다. HTTPS 요청에서는 `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`도 같이 추가한다.
로그인 세션 쿠키의 `Secure` 속성은 기본값 `auto` 로, `X-Forwarded-Proto: https` 또는 HTTPS 소켓이면 자동 활성화된다. 프록시 구성이 특수하면 `HKCLAW_LITE_ADMIN_COOKIE_SECURE=always|never|auto` 로 강제할 수 있다.

AI 로그인은 Kubernetes ServiceAccount가 아니라 컨테이너의 `HOME` 기준이다. Helm 기본값에서는 `HOME=/home/hkclaw` 이고, 이 경로가 state PVC에 저장된다. Codex/Claude/Gemini 로그인 상태와 `.hkclaw-lite` 런타임 상태도 이 PVC에 남는다.

## 기본 흐름

1. `admin`을 띄운다.
2. 웹에서 AI 로그인부터 끝낸다.
3. 에이전트를 만든다.
4. KakaoTalk을 쓸 때만 커넥터를 만든다. Discord/Telegram은 에이전트에 토큰을 둔다.
5. 대화 대상을 만든다. Discord/Telegram은 서버/그룹 채널 또는 개인 대화/DM 중 하나를 고르고, Kakao는 커넥터를 고른다.
6. 해당 플랫폼 워커를 실행한다. Discord/Telegram은 에이전트 카드에서, Kakao는 KakaoTalk 연결 영역에서 관리한다.

웹 어드민은 채널 설정을 보고 필요한 에이전트/커넥터 수신 워커를 자동 시작한다. 자동 시작을 끄려면 `HKCLAW_LITE_CHANNEL_AUTOSTART=0`을 지정한다.

## 주요 명령

```bash
hkclaw-lite admin
hkclaw-lite add connector
hkclaw-lite add channel --platform discord --target-type direct --discord-user-id <user-id>
hkclaw-lite add channel --platform telegram --target-type direct --telegram-chat-id <chat-id>
hkclaw-lite run --channel <name> --message "hello"
hkclaw-lite topology plan --file topology.json
hkclaw-lite topology apply --file topology.json --yes
hkclaw-lite discord serve --agent <agent-name>
hkclaw-lite telegram serve --agent <agent-name>
hkclaw-lite kakao serve --connector <kakao-connector-name>
```

`admin`은 웹 어드민, `run`은 one-shot 실행, `add connector`는 KakaoTalk 연결 계정/세션 추가, `discord serve`/`telegram serve`/`kakao serve`는 플랫폼 워커를 직접 띄우는 명령이다. `--connector <name>`은 KakaoTalk 커넥터 범위를 좁힐 때 쓰고, Discord/Telegram은 `--agent <agent-name>`의 플랫폼 토큰을 사용한다. Discord/Telegram 개인 대화는 채널 생성 시 `targetType=direct`로 저장되며, 내부 세션 경계는 일반 채널과 동일하게 `channel.name:role`이다.

### CLI topology 자동화

내부 에이전트나 운영 스크립트가 대화형 `add` 프롬프트를 조작하지 않도록, desired-state JSON을 먼저 검토하고 적용하는 흐름을 제공한다.

```bash
hkclaw-lite topology plan --file topology.json
hkclaw-lite topology apply --file topology.json --yes
hkclaw-lite topology export
```

- `plan`은 읽기 전용 dry-run이며 `.hkclaw-lite/config.json`을 수정하지 않는다.
- `apply`는 기존 store validator로 전체 미래 config를 먼저 검증한 뒤 한 번에 저장한다.
- 토큰은 JSON에 직접 쓰지 말고 `secretRefs.*Env`를 사용한다. 출력과 export에서는 secret 값이 `***`로 redaction 된다.
- 에이전트가 직접 `apply`하려면 해당 에이전트 설정에 `managementPolicy.canApply=true`와 허용 action/name/platform/workspace/max-change 정책이 있어야 한다.
- 웹 어드민의 **구성 자동화** 화면에서도 같은 plan/apply/export 흐름을 사용할 수 있고, API는 `GET /api/topology/export`, `POST /api/topology/plan`, `POST /api/topology/apply`를 제공한다.

## KakaoTalk 채널

KakaoTalk 연동은 **Admin 내장 릴레이 + Kakao 커넥터 + 채널 + 에이전트** 조합으로 동작한다. 별도 릴레이 서버는 기본적으로 필요 없다.

### 필요한 것

- 외부에서 접근 가능한 hkclaw-lite Admin URL
  - 예: `https://your-domain.example`
- Kakao i OpenBuilder Skill URL
  - `https://your-domain.example/kakao-talkchannel/webhook`
- 응답을 만들 AI Agent
  - Codex/Claude/Gemini/local LLM/command 중 하나
- KakaoTalk Connector
  - Kakao 연결 계정/세션 정보
- KakaoTalk Channel
  - 어떤 메시지를 어떤 workspace/agent/mode로 처리할지 정하는 라우팅 규칙
- Kakao worker
  - KakaoTalk 연결 영역에서 시작/재시작한다. 직접 실행할 때는 `hkclaw-lite kakao serve`를 쓴다.

### 웹 어드민 설정 순서

1. Admin을 외부에서 접근 가능하게 띄운다.

   ```bash
   hkclaw-lite admin --host 0.0.0.0 --port 5687
   ```

2. Kakao i OpenBuilder의 Skill URL에 아래 주소를 등록한다.

   ```txt
   https://your-domain.example/kakao-talkchannel/webhook
   ```

3. 웹 어드민에서 AI 로그인 후 Agent를 만든다.
4. **채널** 화면에서 KakaoTalk Connector를 만든다.
   - 이름: 예 `kakao-main`
   - 릴레이 URL: 예 `https://your-domain.example/`
   - 연결 토큰/세션 토큰: 선택값. 비우면 pairing code를 발급한다.
5. KakaoTalk Channel을 만든다.
   - connector: 위에서 만든 `kakao-main`
   - `Kakao 수신 channelId 필터`: 보통 `*`
   - `Kakao 사용자 ID 필터`: 특정 사용자만 받을 때만 입력
   - owner/reviewer/arbiter agent, workspace, single/tribunal mode 설정
6. KakaoTalk 연결 영역에서 Kakao 워커를 시작/재시작한다.
7. pairing code가 보이면 카카오톡에서 입력한다.

   ```txt
   /pair <code>
   ```

8. 이후 카카오톡 메시지는 Channel 규칙에 따라 Agent로 전달되고, 응답은 Kakao SkillResponse로 돌아간다.

### CLI와 운영 명령

```bash
hkclaw-lite add connector
hkclaw-lite add channel
hkclaw-lite kakao serve
hkclaw-lite kakao serve --connector kakao-main
```

- `hkclaw-lite kakao serve` 하나가 설정된 모든 Kakao Connector/Channel을 처리할 수 있다.
- 특정 커넥터만 분리 운영할 때만 `--connector <name>`을 쓴다.
- Helm/GitOps에서 상시 수신이 필요하면 `workers.kakao.enabled=true`로 같은 Pod 안의 sidecar를 켜는 구성을 권장한다.

### 릴레이 URL과 엔드포인트

Connector의 릴레이 URL은 Kakao worker가 붙을 relay 주소다. 보통 Admin 외부 URL을 그대로 넣는다.

환경 변수로 기본값을 지정할 수도 있다.

```bash
OPENCLAW_TALKCHANNEL_RELAY_URL=https://your-domain.example/
# 또는
KAKAO_TALKCHANNEL_RELAY_URL=https://your-domain.example/
```

내장 릴레이는 Admin 서버에서 아래 엔드포인트를 제공한다.

- `POST /kakao-talkchannel/webhook`: Kakao i OpenBuilder Skill URL
- `GET /v1/healthz` 또는 `/kakao-talkchannel/healthz`: health check
- `POST /v1/sessions/create`: pairing session 생성
- `GET /v1/events`: Kakao worker SSE 수신
- `POST /openclaw/reply`: Kakao 응답 전송
- `GET /v1/sessions/{sessionToken}/status`: pairing 상태 확인

### 알아둘 점

- Connector는 KakaoTalk 접속/세션 정보이고, Channel은 라우팅/워크스페이스/역할 설정이다.
- `kakaoChannelId`의 `*`는 모든 channelId를 받는다는 뜻이다.
- 같은 Connector 안에서 라우팅 필터가 겹치는 Channel은 저장되지 않는다.
- 커넥터 하나로 여러 Channel을 처리할 수 있지만, `kakaoChannelId`나 `kakaoUserId`로 메시지가 정확히 하나의 Channel에만 매칭되게 나눠야 한다.
- 채널마다 worker/Pod를 따로 만들 필요는 없다. 보통 커넥터 단위로만 분리한다.
- 외부 릴레이를 강제로 쓰고 싶을 때만 Connector 릴레이 URL을 별도 relay 주소로 지정한다.

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

- **Agent**: Codex, Claude, Gemini, local LLM, command runner 같은 실제 실행 주체다. 모델, 명령, fallback을 가진다. Discord/Telegram 토큰은 에이전트 플랫폼 설정에 둔다.
- **Connector**: KakaoTalk 전용 연결 계정/세션이다. 타입은 `kakao`로 고정이고, 여러 Kakao 커넥터를 만들어 여러 Channel이 공유할 수 있다.
- **Channel**: Discord/Telegram/KakaoTalk 대상, Kakao 커넥터 또는 에이전트 플랫폼 설정, 기본 워크스페이스, 실행 모드, role 매핑을 가진 실행 단위다.
- **Direct Channel**: Discord DM 또는 Telegram 봇 1:1 대화다. 사용자에게는 “직접 사용”처럼 보이지만, 내부적으로는 세션/워크스페이스/outbox를 안정적으로 보존하기 위해 Channel로 저장한다.
- **Messaging worker**: Discord/Telegram/KakaoTalk 플랫폼 수신 프로세스다. Discord/Telegram은 Agent 카드에서, Kakao 커넥터 기반 수신은 KakaoTalk 연결 영역에서 관리한다.
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
  - Docker Buildx/QEMU로 `linux/amd64`와 `linux/arm64` 컨테이너 빌드를 smoke test
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
  - npm에 올라간 tarball URL/SHA256으로 Homebrew formula 생성
  - `HOMEBREW_TAP_TOKEN` 이 있으면 tap repo의 `Formula/hkclaw-lite.rb`를 갱신
  - GitHub Release 생성/업데이트
  - npm 패키지 tarball, chart tarball, Homebrew formula, SHA256SUMS 업로드
- `Publish Container` (`.github/workflows/container-publish.yml`)
  - `main` push 때 `latest`/`sha-*` 이미지 publish
  - `v*` 태그 push 때 `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X` 태그까지 함께 publish
  - Docker Buildx/QEMU로 `linux/amd64`와 `linux/arm64` 멀티아키텍처 이미지를 하나의 manifest로 publish
  - 컨테이너 이미지만 publish한다. 운영 배포 반영은 공개 저장소 밖의 별도 절차에서 처리한다

### 필요한 GitHub Secrets

- `NPM_TOKEN`: npm 배포용 토큰. 없으면 GitHub Release와 컨테이너 이미지는 계속 만들지만 npm publish는 건너뛴다.
- `HOMEBREW_TAP_TOKEN`: `homebrew-tap` 저장소에 push 가능한 GitHub token. 없으면 formula 파일만 Release 자산으로 만들고 tap 갱신은 건너뛴다.
- `HOMEBREW_TAP_REPOSITORY` Repository variable: 선택값. 기본값은 `${owner}/homebrew-tap`이고, 다른 tap을 쓰면 `owner/repo`로 지정한다.

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
