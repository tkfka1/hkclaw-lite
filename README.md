# hkclaw-lite

`hkclaw-lite`는 Discord 에이전트를 웹 어드민 중심으로 운영하는 경량 런타임이다.

- 기본 진입점은 웹 어드민이다.
- 에이전트 1개당 Discord 토큰 1개를 가진다.
- Discord 워커도 에이전트별 프로세스로 동작한다.
- 기본 웹 주소는 `http://127.0.0.1:5687` 이다.

## 요구 사항

- Node.js 24+
- 기본 설치 시 내부 번들만 사용한다.
- 시스템 `PATH`에 있는 `codex` / `claude` / `gemini`로 fallback하지 않는다.

기본 번들 버전:

- `@openai/codex@0.120.0`
- `@anthropic-ai/claude-agent-sdk@0.2.105`
- `@google/gemini-cli@0.37.1`

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
- Discord 에이전트/채널/AI 로그인은 웹에서 관리한다.
- 실제 Discord 연결은 에이전트 카드의 `실행 / 재시작 / 중지` 버튼으로 제어한다.

## 2. Docker

퍼블릭 이미지:

```bash
docker pull ghcr.io/tkfka1/hkclaw-lite:latest
```

웹 어드민 실행:

```bash
docker run --rm \
  -p 5687:5687 \
  -v hkclaw-lite-data:/data \
  -v $(pwd):/workspace \
  ghcr.io/tkfka1/hkclaw-lite:latest \
  admin --host 0.0.0.0 --port 5687
```

운영 메모:

- `/data`는 로그인 상태와 런타임 상태를 유지하는 용도다.
- `/workspace`는 실제 작업 디렉터리를 붙이는 용도다.
- 컨테이너는 자동으로 역할을 추측하지 않는다. `admin`, `run`, `discord serve` 중 어떤 명령을 띄울지 직접 넘겨야 한다.

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
- `HOME=/data`
- 상태 저장용 PVC 사용

즉 Helm 기본 배포는 웹 어드민용이고, Discord 워커를 별도 Deployment로 나누고 싶으면 `args`를 따로 override 하면 된다.

## 기본 흐름

1. `admin`을 띄운다.
2. 웹에서 AI 로그인부터 끝낸다.
3. 에이전트를 만든다.
4. 채널을 연결한다.
5. 각 에이전트 카드에서 Discord 워커를 실행한다.

## 주요 명령

```bash
hkclaw-lite admin
hkclaw-lite run --channel <name> --message "hello"
hkclaw-lite discord serve --agent <agent-name>
```

`admin`은 웹 어드민, `run`은 one-shot 실행, `discord serve`는 특정 에이전트의 Discord 워커를 직접 띄우는 명령이다.
