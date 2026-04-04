# hkclaw-lite

`hkclaw-lite`는 디스코드 전용 AI 에이전트를 CLI로만 운영하기 위해 다시 정리한 경량 런타임이다.

핵심 전제는 다음과 같다.

- 모든 조작은 CLI에서 한다.
- 불필요한 권한 관리 계층은 두지 않는다.
- 각 에이전트는 실행한 OS 계정 권한을 그대로 가진다.

즉, 이 도구는 샌드박스형 관리자가 아니라 실행 계정 위에서 직접 움직이는 디스코드 전용 에이전트 런타임이다.

## 포함 범위

- 질문형 `add agent`
- 질문형 `add channel`
- 질문형 `add dashboard`
- 에이전트 수정/삭제
- 채널 수정/삭제
- 에이전트와 디스코드 채널 매핑
- 세션 기반 대화형 실행
- 세션 조회/초기화/삭제
- CLI 상태 뷰와 라이브 대시보드

## 제외 범위

- 웹 UI
- systemd/launchd 서비스 관리자
- 복잡한 권한 승인 계층
- HKClaw 원본의 디스코드/웹/DB 전부

## 지원 에이전트 타입

- `codex`
- `claude-code`
- `gemini-cli`
- `local-llm`
- `command`

`command`는 stdin으로 프롬프트를 받고 stdout으로 응답을 내는 임의의 로컬 명령을 연결할 때 쓴다.

## 시작

### 로컬 실행

```bash
cd hkclaw-lite
node bin/hkclaw-lite.js init
```

### npm 전역 설치

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

## 기본 흐름

### 1. 에이전트 추가

```bash
hkclaw-lite add agent
```

실행하면 질문이 순서대로 나온다.

- 에이전트 이름
- 어떤 에이전트 타입을 만들지
- 작업 디렉터리
- 모델/effort
- 세션 history window
- timeout
- system prompt
- env
- 에이전트 타입별 추가 설정

### 2. 대시보드 추가

채널을 먼저 등록해서 에이전트와 연결할 수 있다.

```bash
hkclaw-lite add channel
```

질문 예시는 다음과 같다.

- 채널 이름
- Discord channel ID
- Discord guild ID
- 어떤 에이전트에 연결할지
- 설명

채널로 대화하려면:

```bash
hkclaw-lite chat --channel discord-main
```

이 경우 매핑된 에이전트가 자동 선택되고 기본 세션 ID는 `channel-<channel-name>` 형태를 쓴다.

### 3. 대시보드 추가

```bash
hkclaw-lite add dashboard
```

질문 예시는 다음과 같다.

- 대시보드 이름
- 모든 에이전트를 볼지, 특정 에이전트만 볼지
- refresh interval
- session count 표시 여부
- runtime detail 표시 여부

### 4. 에이전트와 대화

```bash
hkclaw-lite chat dev-codex
hkclaw-lite chat dev-codex --session bugfix
hkclaw-lite chat dev-codex --last
hkclaw-lite chat --channel discord-main
```

한 턴만 보내고 끝내고 싶으면 `chat`에 `--message`를 붙인다.

```bash
hkclaw-lite chat dev-codex --session demo --message "현재 저장소 구조를 요약해라"
```

대화 모드 내부 명령:

- `.help`
- `.history`
- `.clear`
- `.exit`

### 5. 대시보드 보기

```bash
hkclaw-lite dashboard ops
```

한 번만 출력하려면:

```bash
hkclaw-lite dashboard ops --once
```

## 주요 명령

```bash
hkclaw-lite add agent
hkclaw-lite add channel
hkclaw-lite add dashboard
hkclaw-lite edit agent <name>
hkclaw-lite edit channel <name>
hkclaw-lite edit dashboard <name>
hkclaw-lite remove agent <name>
hkclaw-lite remove channel <name>
hkclaw-lite remove dashboard <name>
hkclaw-lite list
hkclaw-lite show agent <name>
hkclaw-lite show channel <name>
hkclaw-lite show dashboard <name>
hkclaw-lite chat <agent>
hkclaw-lite chat --channel <channel>
hkclaw-lite dashboard <name>
hkclaw-lite status
hkclaw-lite status channel <name>
hkclaw-lite session list
hkclaw-lite session show <agent> <session>
```

## 권한 모델

이 프로젝트는 불필요한 권한 관리 레이어를 의도적으로 줄였다.

- 에이전트는 실행한 계정의 파일 접근 권한을 그대로 가진다.
- 에이전트는 실행한 계정의 네트워크 접근 권한을 그대로 가진다.
- 에이전트는 해당 계정에서 가능한 명령을 그대로 실행할 수 있다.

따라서 민감한 계정에서 바로 돌리는 대신, 목적에 맞는 전용 OS 계정에서 운영하는 쪽이 맞다.

## 참고 사항

- `codex`, `claude`, `gemini` 같은 외부 CLI는 로컬에 설치되어 있어야 한다.
- 세션은 provider-native session 복구가 아니라 로컬 transcript 재주입 방식이다.
- 예전 `run` / `service` 스타일 명령은 제거됐다. 이제 `add agent`, `add channel`, `add dashboard`, `chat`, `dashboard` 중심으로 쓴다.

## 배포

현재 패키지는 npm 공개 배포 가능한 상태다.

```bash
npm publish
```

스코프 패키지로 바꾸면 공개 배포 시 아래처럼 `--access public`이 필요하다.

```bash
npm publish --access public
```
