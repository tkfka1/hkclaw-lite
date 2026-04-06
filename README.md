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
- one-shot `run` 실행
- 선택적 owner/reviewer/arbiter tribunal 채널
- agent-level automatic failover
- CLI 상태 뷰와 라이브 대시보드
- 에이전트별 skill/context 파일 주입
- project-level shared env
- GitHub / GitLab CI check/watch
- detached background CI watcher

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

## 요구 사항

- Node.js 20 이상
- `codex`, `claude`, `gemini` 같은 외부 에이전트 CLI를 쓸 경우 해당 CLI가 로컬에 설치되어 있어야 한다.
- GitHub / GitLab CI를 private 리포지토리에서 확인할 경우 API 토큰이 필요하다.

## 설치

### 소스 체크아웃 후 바로 실행

패키지를 전역 설치하지 않고도 바로 사용할 수 있다.

```bash
git clone git@github.com:tkfka1/hkclaw-lite.git
cd hkclaw-lite
node bin/hkclaw-lite.js --help
```

### 로컬 전역 설치

현재 체크아웃한 저장소를 전역 명령으로 연결하려면:

```bash
cd hkclaw-lite
npm install -g .
hkclaw-lite --help
```

### npm 공개 배포 후 설치

패키지를 npm에 공개 배포한 뒤에는 아래처럼 설치하면 된다.

```bash
npm install -g hkclaw-lite
hkclaw-lite --help
```

## 빠른 시작

새 프로젝트 디렉터리에서 먼저 초기화한다.

```bash
mkdir my-agent-workspace
cd my-agent-workspace
hkclaw-lite init
```

프로젝트 루트에는 아래 구조가 생성된다.

```text
.hkclaw-lite/
  config.json
  watchers/
```

이후 기본 흐름은 `init -> add agent -> add channel -> run` 순서다.

## 기본 흐름

### 1. 에이전트 추가

```bash
hkclaw-lite add agent
```

실행하면 질문이 순서대로 나온다.

- 에이전트 이름
- 어떤 에이전트 타입을 만들지
- 모델/effort
- timeout
- system prompt
- skill path들
- context file들
- env
- 에이전트 타입별 추가 설정

`system prompt`는 운영 규칙에, `skill path`는 재사용 가능한 작업 규약에, `context file`은 저장소나 프로젝트 기본 배경지식에 쓰는 식으로 분리해서 관리할 수 있다.

추가 직후 설정을 확인하려면:

```bash
hkclaw-lite show agent <name>
```

### Skill / Context 분리

에이전트에는 아래 세 층을 따로 넣을 수 있다.

- `systemPrompt` / `systemPromptFile`
- `skills`
- `contextFiles`
- `fallbackAgent`

`skills`는 `SKILL.md` 파일 자체를 가리키거나, `SKILL.md`가 들어있는 디렉터리를 가리켜도 된다. 디렉터리를 넣으면 내부의 `SKILL.md`를 자동으로 읽는다.

`contextFiles`는 일반 텍스트/마크다운 파일을 읽어서 기본 컨텍스트로 주입한다.

### Agent / Channel 역할 분리

- `agent`는 모델, provider, system prompt, skills, fallback 같은 정적 프로필이다.
- `channel`은 실제 실행 workspace인 `workdir`를 가진다.
- 같은 agent를 여러 채널에 연결해도, 각 채널은 자기 `workdir` 기준으로 독립적으로 동작한다.

### Shared Env

모든 agent와 project 내부의 `ci check/watch`가 공통으로 쓰는 env를 top-level에 둘 수 있다.

```bash
hkclaw-lite env set GITHUB_TOKEN=ghp_xxx GITLAB_TOKEN=glpat-xxx
hkclaw-lite env list
hkclaw-lite env unset GITLAB_TOKEN
```

우선순위는 다음과 같다.

1. project `sharedEnv`
2. agent별 `env`

즉 공통 토큰은 `sharedEnv`에 두고, 특정 agent만 다른 값을 써야 하면 그 agent의 `env`에서 override 하면 된다.

프롬프트 조합 순서는 대략 다음과 같다.

1. system instructions
2. installed skills
3. baseline context
4. runtime context
5. user request

예시:

```json
{
  "agent": "codex",
  "systemPromptFile": "prompts/coder.md",
  "skills": ["skills/reviewer", "skills/release/SKILL.md"],
  "contextFiles": ["context/repo-map.md", "context/team-rules.md"],
  "fallbackAgent": "dev-codex-backup"
}
```

### Agent Failover

각 agent에는 선택적으로 `fallbackAgent`를 지정할 수 있다.

- primary agent 실행이 실패하면 같은 요청을 fallback agent로 한 번 더 시도한다.
- tribunal 채널에서는 owner, reviewer, arbiter 각각의 agent에 별도로 fallback을 줄 수 있다.

예시:

```json
{
  "agent": "claude-code",
  "model": "sonnet",
  "fallbackAgent": "owner-codex-backup"
}
```

### Tribunal Channel

채널은 기본적으로 하나의 owner agent에 매핑되지만, 필요하면 reviewer와 arbiter를 추가해서 tribunal 흐름으로 돌릴 수 있다.

- owner: 실제 초안 생성
- reviewer: owner 결과를 자동 검토
- arbiter: reviewer가 `BLOCKED`를 내리거나 review round를 초과하면 최종 판정

질문형 `add channel`에서는 먼저 일반 채널인지 tribunal 채널인지 물어본 다음, tribunal을 고르면 owner/reviewer/arbiter 세 에이전트를 순서대로 선택하게 된다.

채널의 `workdir`가 실제 workspace이고, tribunal이어도 owner/reviewer/arbiter는 같은 채널 `workdir`를 공유한다.

채널 설정 예시:

```json
{
  "discordChannelId": "123456789012345678",
  "workdir": "./workspaces/discord-main",
  "agent": "owner",
  "reviewer": "reviewer",
  "arbiter": "arbiter",
  "reviewRounds": 2
}
```

이 설정은 디스코드 쪽 owner -> reviewer -> arbiter tribunal 흐름을 표현하기 위한 채널 메타데이터다.

### 2. 채널 추가

채널을 먼저 등록해서 에이전트와 연결할 수 있다.

```bash
hkclaw-lite add channel
```

질문 예시는 다음과 같다.

- 채널 이름
- Discord channel ID
- Discord guild ID
- 채널 workdir
- 어떤 에이전트에 연결할지
- 설명

`workdir`는 미리 존재하는 디렉터리여야 한다.

추가 직후 설정을 확인하려면:

```bash
hkclaw-lite show channel <name>
```

### 3. one-shot 실행

현재 CLI 실행 진입점은 `run`이다.

채널 기준 실행:

```bash
hkclaw-lite run --channel discord-main --message "현재 작업 디렉터리 상태를 요약해라"
echo "최근 변경점을 검토해라" | hkclaw-lite run --channel discord-main
```

agent 기준 실행:

```bash
hkclaw-lite run dev-codex --workdir ./workspaces/dev --message "README를 정리해라"
```

`agent`만 주고 `--workdir`를 생략하면, 그 agent가 연결된 채널이 정확히 하나일 때만 그 채널 컨텍스트와 workdir을 자동으로 사용한다. 여러 채널에 물려 있으면 `--channel` 또는 `--workdir`를 명시해야 한다.

tribunal 채널은 `run --channel ...` 시 아래 순서로 동작한다.

1. owner가 초안을 만든다.
2. reviewer가 `APPROVED` 또는 `BLOCKED: ...` 형식으로 판정한다.
3. `BLOCKED`가 계속되면 `reviewRounds` 이후 arbiter가 최종 응답을 만든다.

각 단계의 agent는 자기 `fallbackAgent`가 있으면 실패 시 fallback으로 재시도한다.

### 4. 대시보드 추가

```bash
hkclaw-lite add dashboard
```

질문 예시는 다음과 같다.

- 대시보드 이름
- 모든 에이전트를 볼지, 특정 에이전트만 볼지
- refresh interval
- runtime detail 표시 여부

### 5. 대시보드 보기

```bash
hkclaw-lite dashboard ops
```

한 번만 출력하려면:

```bash
hkclaw-lite dashboard ops --once
```

### 6. CI 확인 / 감시

프로젝트 초기화 없이도 GitHub Actions와 GitLab CI 상태를 바로 조회할 수 있다. 다만 `sharedEnv`에 저장된 토큰을 재사용하려면 `hkclaw-lite init`으로 만든 프로젝트 안에서 실행해야 한다.

한 번만 확인:

```bash
hkclaw-lite ci check github --repo owner/repo --run-id 123456
hkclaw-lite ci check gitlab --project group/project --pipeline-id 987
```

종료될 때까지 감시:

```bash
hkclaw-lite ci watch github --repo owner/repo --run-id 123456
hkclaw-lite ci watch gitlab --project group/project --job-id 555
```

백그라운드 watcher로 분리:

```bash
hkclaw-lite ci watch gitlab --project group/project --pipeline-id 987 --background
hkclaw-lite ci list
hkclaw-lite ci show <watcher-id>
hkclaw-lite ci stop <watcher-id>
```

주요 옵션:

- `--base-url`: GitHub Enterprise / self-managed GitLab API 주소
- `--token`: 명시적 API 토큰
- `--target`: 완료 메시지에 넣을 사람이 읽는 대상 이름
- `--interval-ms`: watch polling 간격
- `--timeout-ms`: watch 최대 대기 시간
- `--background`: detached watcher로 분리 실행

인증은 아래 환경 변수도 사용할 수 있다.

- GitHub: `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`
- GitLab: `GITLAB_TOKEN`, `GITLAB_PAT`, `GITLAB_PRIVATE_TOKEN`, `CI_JOB_TOKEN`

## 주요 명령

```bash
hkclaw-lite init
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
hkclaw-lite run <agent> [--workdir DIR] [--message TEXT]
hkclaw-lite run --channel <name> [--message TEXT]
hkclaw-lite dashboard <name>
hkclaw-lite env list
hkclaw-lite env set GITHUB_TOKEN=ghp_xxx GITLAB_TOKEN=glpat-xxx
hkclaw-lite env unset GITLAB_TOKEN
hkclaw-lite ci check github --repo owner/repo --run-id 123456
hkclaw-lite ci check gitlab --project group/project --pipeline-id 987
hkclaw-lite ci watch github --repo owner/repo --run-id 123456
hkclaw-lite ci watch gitlab --project group/project --job-id 555
hkclaw-lite ci list
hkclaw-lite ci show <watcher-id>
hkclaw-lite ci stop <watcher-id>
hkclaw-lite status
hkclaw-lite status agent <name>
hkclaw-lite status channel <name>
hkclaw-lite status dashboard <name>
```

## 권한 모델

이 프로젝트는 불필요한 권한 관리 레이어를 의도적으로 줄였다.

- 에이전트는 실행한 계정의 파일 접근 권한을 그대로 가진다.
- 에이전트는 실행한 계정의 네트워크 접근 권한을 그대로 가진다.
- 에이전트는 해당 계정에서 가능한 명령을 그대로 실행할 수 있다.

따라서 민감한 계정에서 바로 돌리는 대신, 목적에 맞는 전용 OS 계정에서 운영하는 쪽이 맞다.

## 참고 사항

- `ci check/watch`는 GitHub/GitLab API 접근이 가능해야 하고, private 리포지토리는 토큰이 필요하다.
- background CI watcher 상태와 로그는 `.hkclaw-lite/watchers/` 아래에 저장된다.
- background CI watcher는 명시적 `--token` 값을 watcher JSON에 저장하지 않고, 분리된 worker 프로세스 env로만 전달한다.
- 예전 `chat`/`session` 스타일 명령은 제거됐다. 실행은 `run`, 관리는 `add/edit/remove`, `show`, `status`, `dashboard`, `ci` 중심으로 쓴다.

## 배포

현재 패키지는 npm 공개 배포 가능한 상태다.

```bash
npm publish
```

스코프 패키지로 바꾸면 공개 배포 시 아래처럼 `--access public`이 필요하다.

```bash
npm publish --access public
```
