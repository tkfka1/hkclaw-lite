# hkclaw-lite

`hkclaw-lite`는 Discord/Telegram 에이전트를 웹 어드민 중심으로 운영하는 경량 런타임이다.

- 기본 진입점은 웹 어드민이다.
- 에이전트 1개당 선택한 플랫폼(Discord/Telegram)용 연결 정보를 가진다.
- 메시징 워커도 에이전트별 프로세스로 동작한다.
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
- 실제 Discord/Telegram 연결은 에이전트 카드의 `실행 / 재시작 / 중지` 버튼으로 제어한다.

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
- 컨테이너는 자동으로 역할을 추측하지 않는다. `admin`, `run`, `discord serve` 중 어떤 명령을 띄울지 직접 넘겨야 한다.
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

운영 주의:

- 기본 동작은 단일 Pod 운영이다. 웹 어드민이 Discord/Telegram 워커를 같은 컨테이너 안에서 띄운다.
- worker 재기동 복구는 runtime SQLite DB에 저장된 서비스 런타임 스냅샷을 우선 사용한다. 새 배포 환경을 반영하려면 웹 어드민에서 해당 워커를 한 번 다시 실행하거나 재시작하면 된다.
- Helm 기본 배포는 단일 state PVC 안의 `/home/hkclaw/workspace` 를 채널 기본 workdir 로 사용한다.
- 별도 작업용 볼륨을 쓰고 싶을 때만 `workspace.enabled=true` 로 켜고 원하는 마운트 경로를 준다.
- `~` 를 명시적으로 쓰면 `HOME` 으로 해석되고 Helm 기본값에서는 `/home/hkclaw` 를 뜻한다.
- `discord serve` 또는 `telegram serve` 를 정말 별도 Deployment/Pod로 분리할 때만 `/home/hkclaw` PVC를 admin Pod와 공유해야 한다. 그렇지 않으면 Claude 로그인 상태와 `.hkclaw-lite` 프로젝트 상태가 분리된다.

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

AI 로그인은 Kubernetes ServiceAccount가 아니라 컨테이너의 `HOME` 기준이다. Helm 기본값에서는 `HOME=/home/hkclaw` 이고, 이 경로가 state PVC에 저장된다. Codex/Claude/Gemini 로그인 상태와 `.hkclaw-lite` 런타임 상태도 이 PVC에 남는다.

## 기본 흐름

1. `admin`을 띄운다.
2. 웹에서 AI 로그인부터 끝낸다.
3. 에이전트를 만든다.
4. 채널을 연결한다.
5. 각 에이전트 카드에서 해당 플랫폼 워커를 실행한다.

## 주요 명령

```bash
hkclaw-lite admin
hkclaw-lite run --channel <name> --message "hello"
hkclaw-lite discord serve --agent <agent-name>
hkclaw-lite telegram serve --agent <agent-name>
```

`admin`은 웹 어드민, `run`은 one-shot 실행, `discord serve`/`telegram serve`는 특정 에이전트의 플랫폼 워커를 직접 띄우는 명령이다.

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

- **Agent**: Codex, Claude, Gemini, local LLM, command runner 같은 실제 실행 주체다. 모델, 명령, fallback, 플랫폼 토큰을 가진다.
- **Channel**: Discord/Telegram 대상, 기본 워크스페이스, 실행 모드, role 매핑을 가진 실행 단위다.
- **Role**: 한 turn 안에서 에이전트가 맡는 역할이다. 기본은 `owner`, tribunal 모드에서는 `owner`, `reviewer`, `arbiter`가 있다.
- **Harness / runtime session**: 채널 turn을 실행하고, role별 메시지/세션/사용량/outbox를 기록하는 런타임 상태다.

런타임 DB에는 주로 다음 상태가 남는다.

- `runtime_runs`: 채널 turn 1회의 상태, active role, round, 최종 disposition.
- `runtime_role_messages`: owner/reviewer/arbiter가 낸 메시지.
- `runtime_role_sessions`: `channel.name + role` 기준의 세션 매핑.
- `runtime_outbox_events`: Discord/Telegram으로 내보낼 role 메시지 이벤트.

### Single 채널

Single 모드에서는 채널의 기본 에이전트가 owner로 실행된다.

```txt
channel.agent -> owner
```

흐름:

1. `hkclaw-lite run --channel <name>` 또는 메시징 워커가 채널 turn을 시작한다.
2. `channel.agent`를 찾아 `owner` role로 실행한다.
3. 결과를 `runtime_runs`, `runtime_role_messages`, `runtime_role_sessions`에 기록한다.
4. Discord/Telegram 워커가 필요한 경우 outbox 이벤트를 전송한다.

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
  - `npm publish --provenance`
  - GitHub Release 생성/업데이트
  - npm 패키지 tarball, chart tarball, SHA256SUMS 업로드
- `Publish Container` (`.github/workflows/container-publish.yml`)
  - `main` push 때 `latest`/`sha-*` 이미지 publish
  - `v*` 태그 push 때 `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X` 태그까지 함께 publish

### 필요한 GitHub Secrets

- `NPM_TOKEN`: npm 배포용 토큰

### 운영 방법

1. GitHub Actions에서 `Prepare Release` 실행
2. `bump` 를 `patch`, `minor`, `major`, `custom` 중에서 선택
3. `custom` 이면 `version` 에 정확한 semver 입력 (`1.2.3`)
4. 워크플로우가 버전 파일 동기화 + 테스트 + 커밋 + `vX.Y.Z` 태그 push 수행
5. 태그가 올라가면 `Publish Release` 와 `Publish Container` 가 자동 실행

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
