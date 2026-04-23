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
