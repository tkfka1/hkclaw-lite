# hkclaw-lite

`hkclaw`에서 웹, 디스코드, 서비스 매니저를 걷어내고 실제 실행 기능만 CLI 중심으로 다시 묶은 경량 런타임이다.

핵심 목표는 두 가지다.

- 모든 조작을 CLI로 처리한다.
- 서비스 정의, 세션 transcript, 에이전트 실행만 남긴다.

## 포함 범위

- 서비스 등록/수정/삭제
- 단발 실행(`run`)
- 세션 기반 대화(`chat`)
- 세션 조회/초기화/삭제
- 런타임 상태 확인(`status`)

제외한 항목은 다음과 같다.

- Discord 채널 라우팅
- 웹 대시보드
- systemd/launchd 서비스 관리
- HKClaw 내부 DB/IPC 구조

## 지원 에이전트

- `codex`
- `claude-code`
- `gemini-cli`
- `local-llm`
- `command`

`command`는 stdin으로 프롬프트를 받고 stdout으로 응답을 반환하는 임의의 로컬 명령을 연결할 때 쓴다.

## 시작

### 로컬 실행

```bash
cd hkclaw-lite
node bin/hkclaw-lite.js init
```

### npm 전역 설치 후 사용

```bash
npm install -g hkclaw-lite
hkclaw-lite init
```

프로젝트 루트에는 아래 구조가 생성된다.

```text
.hkclaw-lite/
  config.json
  sessions/
```

## 서비스 등록 예시

### Codex

```bash
hkclaw-lite service add dev-codex \
  --agent codex \
  --workdir . \
  --model gpt-5 \
  --sandbox workspace-write
```

### Claude Code

```bash
hkclaw-lite service add dev-claude \
  --agent claude-code \
  --workdir . \
  --model sonnet \
  --permission-mode bypassPermissions
```

### Local LLM

```bash
hkclaw-lite service add local-dev \
  --agent local-llm \
  --workdir . \
  --model qwen2.5-coder:14b \
  --base-url http://127.0.0.1:11434/v1
```

### Custom Command

```bash
hkclaw-lite service add mock \
  --agent command \
  --workdir . \
  --command "node ./scripts/mock-agent.mjs"
```

## 실행

단발 실행:

```bash
hkclaw-lite run dev-codex "현재 저장소 구조를 요약해라"
```

세션 저장과 함께 실행:

```bash
hkclaw-lite run dev-codex "첫 요청" --session demo
hkclaw-lite run dev-codex "이전 요청을 이어서 다음 작업을 제안해라" --session demo
```

대화 모드:

```bash
hkclaw-lite chat dev-claude
hkclaw-lite chat dev-claude --session bugfix
hkclaw-lite chat dev-claude --last
```

대화 모드 내부 명령:

- `.help`
- `.history`
- `.clear`
- `.exit`

## 세션 관리

```bash
hkclaw-lite session list
hkclaw-lite session list dev-codex
hkclaw-lite session show dev-codex demo
hkclaw-lite session clear dev-codex demo
hkclaw-lite session remove dev-codex demo
```

## 상태 확인

```bash
hkclaw-lite status
hkclaw-lite status dev-codex
```

## 참고 사항

- `codex`와 `claude-code`는 로컬 CLI가 설치되어 있어야 한다.
- 자동 실행을 위해 권한 우회 옵션을 사용할 수 있으므로, 신뢰 가능한 작업 디렉터리에서만 실행하는 편이 맞다.
- 세션은 provider-native session이 아니라 로컬 transcript 기반으로 이어진다. 즉, 매 턴마다 최근 대화 이력을 다시 프롬프트에 포함해 보낸다.

## 배포 메모

현재 패키지는 CLI 전용이다. npm 공개 배포 시에는 아래처럼 게시하면 된다.

```bash
npm publish
```

스코프 패키지로 바꾸는 경우에는 공개 배포를 위해 다음처럼 `--access public`이 필요하다.

```bash
npm publish --access public
```
