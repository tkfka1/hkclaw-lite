# hkclaw-lite

`hkclaw-lite`는 디스코드 전용 AI 에이전트를 CLI 중심으로 운영하기 위해 다시 정리한 경량 런타임이다.

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
- 선택적 로컬 웹 어드민
- 에이전트별 skill/context 파일 주입
- project-level shared env
- GitHub / GitLab CI check/watch
- detached background CI watcher

## 제외 범위

- 공개용 멀티유저 웹 제품
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

- Node.js 24 이상
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

CLI 대신 브라우저에서 관리하고 싶으면 로컬 웹 어드민을 바로 띄울 수도 있다.

```bash
hkclaw-lite admin
```

기본 주소는 `http://127.0.0.1:4622` 이다.

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

채널은 `mode`를 기준으로 동작한다.

- `single`: owner만 사용
- `tribunal`: owner + reviewer + arbiter 사용

- owner: 실제 초안 생성
- reviewer: owner 결과를 자동 검토
- arbiter: reviewer가 `BLOCKED`를 내리거나 review round를 초과하면 최종 판정

질문형 `add channel`에서는 먼저 일반 채널인지 tribunal 채널인지 물어본 다음, tribunal을 고르면 owner/reviewer/arbiter 세 에이전트를 순서대로 선택하게 된다.

채널의 `workspace`가 실제 작업 공간이고, tribunal이어도 owner/reviewer/arbiter는 같은 채널 `workspace`를 공유한다.

채널 설정 예시:

```json
{
  "mode": "tribunal",
  "discordChannelId": "123456789012345678",
  "workspace": "./workspaces/discord-main",
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
- 채널 모드 (`single` 또는 `tribunal`)
- Discord channel ID
- Discord guild ID
- 채널 workspace
- 어떤 에이전트에 연결할지
- 설명

`workspace`는 미리 존재하는 디렉터리여야 한다.

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

`agent`만 주고 `--workdir`를 생략하면, 그 agent가 연결된 채널이 정확히 하나일 때만 그 채널 컨텍스트와 workspace를 자동으로 사용한다. 여러 채널에 물려 있으면 `--channel` 또는 `--workdir`를 명시해야 한다.

tribunal 채널은 `run --channel ...` 시 아래 순서로 동작한다.

1. owner가 초안을 만든다.
2. reviewer가 `APPROVED` 또는 `BLOCKED: ...` 형식으로 판정한다.
3. `BLOCKED`가 계속되면 `reviewRounds` 이후 arbiter가 최종 응답을 만든다.

각 단계의 agent는 자기 `fallbackAgent`가 있으면 실패 시 fallback으로 재시도한다.

### 4. Discord 서비스

실제 Discord 채널과 연결해서 쓰려면 역할별 봇 토큰을 준비한 뒤 서비스 프로세스를 띄우면 된다.

```bash
hkclaw-lite discord serve --env-file .env
```

`.env` 예시:

```dotenv
OWNER_BOT_TOKEN=discord-owner-token
REVIEWER_BOT_TOKEN=discord-reviewer-token
ARBITER_BOT_TOKEN=discord-arbiter-token
```

- owner bot: 유저 입력을 받고 owner 응답을 보낸다.
- reviewer bot: tribunal 채널에서 reviewer 결과를 보낸다.
- arbiter bot: tribunal 채널에서 최종 중재 응답을 보낸다.

역할별 봇 아이덴티티는 전역이고, 어떤 agent/model이 해당 역할을 맡을지는 채널 설정의 owner/reviewer/arbiter가 결정한다.

### 5. 대시보드 추가

```bash
hkclaw-lite add dashboard
```

질문 예시는 다음과 같다.

- 대시보드 이름
- 모든 에이전트를 볼지, 특정 에이전트만 볼지
- refresh interval
- runtime detail 표시 여부

### 6. 대시보드 보기

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

### 7. 백업 / 복원 / 마이그레이션

프로젝트 메타데이터를 한 파일로 내보내거나 다른 루트로 옮길 수 있다.

```bash
hkclaw-lite backup export ./backups/project.json
hkclaw-lite backup import ./backups/project.json --root ./restored-project
hkclaw-lite migrate --from ../old-project --root ./new-project
```

백업에는 아래 내용이 포함된다.

- `.hkclaw-lite/config.json`
- `.hkclaw-lite/watchers/` 아래 watcher 상태 JSON과 로그
- 프로젝트 내부 상대경로로 지정된 `systemPromptFile`, `skills`, `contextFiles`
- 프로젝트 내부 상대경로인 channel `workdir` 디렉터리 생성 정보

포함되지 않는 내용:

- `workdir` 내부 실제 저장소/산출물 내용
- 프로젝트 바깥 경로를 가리키는 skill/context/prompt/workdir

즉 설정값과 hkclaw-lite가 직접 관리하는 상태 파일은 옮기되, 실제 작업 저장소 자체는 별도로 복사해야 한다.

### 8. 로컬 웹 어드민

브라우저에서 agent/channel/dashboard/shared env 를 수정하고 one-shot `run` 을 실행하려면:

```bash
hkclaw-lite admin
```

옵션:

- `--host`: 바인딩 주소. 기본값은 `127.0.0.1`
- `--port`: 리슨 포트. 기본값은 `4622`

예시:

```bash
hkclaw-lite admin --host 0.0.0.0 --port 4622
```

가벼운 로그인 비밀번호를 걸고 싶으면 환경 변수로 설정한다.

```bash
HKCLAW_LITE_ADMIN_PASSWORD='change-me' hkclaw-lite admin
```

이 모드에서는:

- 단일 비밀번호만 사용한다.
- 세션은 프로세스 메모리에만 유지된다.
- 브라우저에는 `HttpOnly` 쿠키만 남고, 서버 재시작 시 세션은 사라진다.

웹 어드민이 하는 일:

- agent / channel / dashboard 조회 및 수정
- shared env 편집
- CI watcher 목록과 로그 확인
- 기존 CLI `run` 흐름을 그대로 타는 one-shot 실행

즉 웹에서 별도 런타임을 새로 구현한 것이 아니라, 기존 프로젝트 설정과 CLI 동작을 브라우저에서 조작할 수 있게 감싼 관리자다.

## 주요 명령

```bash
hkclaw-lite init
hkclaw-lite admin
hkclaw-lite backup export ./backups/project.json
hkclaw-lite backup import ./backups/project.json --root ./restored-project
hkclaw-lite migrate --from ../old-project --root ./new-project
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
- 웹 어드민의 one-shot 실행은 내부적으로 기존 CLI `run` 경로를 호출한다.
- 예전 `chat`/`session` 스타일 명령은 제거됐다. 실행은 `run`, 관리는 `add/edit/remove`, `show`, `status`, `dashboard`, `ci`, `admin` 중심으로 쓴다.

## 컨테이너 / Helm 배포

이 프로젝트는 기본적으로 HTTP 서버가 아니라 CLI 런타임이지만, 기본 Helm chart는 운영 편의를 위해 웹 어드민을 바로 띄우도록 구성돼 있다. 기본값은 `0.0.0.0:4622` 이고 `ClusterIP` Service도 함께 생성된다.

기본 이미지는 이 저장소의 `Dockerfile`로 만들 수 있다.

```bash
docker build -t ghcr.io/tkfka1/hkclaw-lite:1.0.0 .
```

Helm chart는 `charts/hkclaw-lite` 아래에 있다.

```bash
helm upgrade --install hkclaw-lite ./charts/hkclaw-lite \
  --set image.repository=ghcr.io/tkfka1/hkclaw-lite \
  --set image.tag=1.0.0
```

설치 후 로컬에서는 아래처럼 포트 포워딩해서 웹 어드민에 붙으면 된다.

```bash
kubectl port-forward svc/hkclaw-lite 4622:4622
```

기본 차트는 `node /app/bin/hkclaw-lite.js admin --host 0.0.0.0 --port 4622` 를 실행한다. CLI toolbox 모드가 필요하면 `args`를 비우거나 원하는 명령으로 override 하면 된다.

웹 어드민 대신 직접 pod 안에서 CLI를 쓰고 싶으면:

```bash
kubectl exec -it deploy/hkclaw-lite -- /bin/bash
node /app/bin/hkclaw-lite.js status --root /data
```

백업 파일로 초기 상태를 넣고 싶으면:

```bash
helm upgrade --install hkclaw-lite ./charts/hkclaw-lite \
  --set image.repository=ghcr.io/tkfka1/hkclaw-lite \
  --set image.tag=1.0.0 \
  --set bootstrapBackup.enabled=true \
  --set-file bootstrapBackup.data=./backups/project.json
```

중요한 제약:

- `codex`, `claude-code`, `gemini-cli` 같은 외부 provider CLI를 쓰려면, 그 바이너리와 인증 파일을 포함한 파생 이미지를 직접 만들어야 한다.
- chart는 `.hkclaw-lite` 상태와 프로젝트 내부 상대경로 자산을 유지하는 용도이고, 실제 작업 저장소는 별도 PVC나 추가 volume mount로 붙이는 식으로 운영해야 한다.

## 배포

현재 패키지는 npm 공개 배포 가능한 상태다.

```bash
npm publish
```

스코프 패키지로 바꾸면 공개 배포 시 아래처럼 `--access public`이 필요하다.

```bash
npm publish --access public
```
