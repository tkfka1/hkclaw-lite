import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('admin shell owns the top header so it does not render twice', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');

  assert.match(shellSource, /state\.data\s*\?\s*renderTopBar\(/u);
  assert.doesNotMatch(appSource, /renderTopBar\s+as\s+buildTopBar/u);
  assert.doesNotMatch(appSource, /\$\{renderTopBar\(\)\}/u);
  assert.doesNotMatch(appSource, /function\s+renderTopBar\s*\(/u);
});

test('top-level admin headings avoid duplicate English eyebrow labels', () => {
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.doesNotMatch(shellSource, /activeView\.eyebrow/u);
  assert.doesNotMatch(shellSource, /class="hero-eyebrow"/u);
  assert.doesNotMatch(shellSource, /class="shortcut-eyebrow"/u);
  assert.doesNotMatch(viewsSource, /class="section-eyebrow"/u);
});

test('desktop layout can show the sidebar without always rendering the hamburger button', () => {
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');

  assert.match(shellSource, /showNavToggle/u);
  assert.match(shellSource, /desktopNavVisible/u);
  assert.match(shellSource, /const sidebarVisible = Boolean\(state\.data && \(desktopNavVisible \|\| state\.navOpen\)\);/u);
  assert.match(shellSource, /nav-toggle-button/u);
  assert.match(shellSource, /state\.data && !desktopNavVisible && state\.navOpen/u);
  assert.match(shellSource, /desktopNavVisible \|\| state\.navOpen \? '' : 'inert'/u);
});

test('agents page keeps the operator surface simple', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(appSource, /VIEW_NAMES/u);
  assert.match(appSource, /window\.location\.hash/u);
  assert.match(appSource, /renderAgentDetailPanel/u);
  assert.match(appSource, /연결 시작/u);
  assert.match(appSource, /수신 연결/u);
  assert.doesNotMatch(appSource, /agentSearch/u);
  assert.doesNotMatch(appSource, /agentFilter/u);
  assert.doesNotMatch(appSource, /renderButtonLabel\('play', '실행'\)/u);
  assert.doesNotMatch(appSource, /Heartbeat/u);
  assert.doesNotMatch(appSource, /메시징 플랫폼/u);
  assert.doesNotMatch(viewsSource, /data-form="agent-filters"/u);
  assert.doesNotMatch(viewsSource, /name="agentSearch"/u);
  assert.doesNotMatch(viewsSource, /name="agentFilter"/u);
  assert.doesNotMatch(viewsSource, /에이전트 요약/u);
  assert.doesNotMatch(viewsSource, /전체 \$\{stats\.agents\.length\}/u);
});

test('channels page keeps cards focused on the actual receiving target', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(appSource, /const channelMetaParts = \[/u);
  assert.match(appSource, /describeChannelTarget\(channel\)/u);
  assert.doesNotMatch(appSource, /renderChannelRuntimeSessions/u);
  assert.doesNotMatch(appSource, /open-reset-channel-runtime-sessions/u);
  assert.doesNotMatch(appSource, /confirm-reset-channel-runtime-sessions/u);
  assert.doesNotMatch(appSource, /runtimeResetModal/u);
  assert.doesNotMatch(appSource, /buildChannelWorkerContext/u);
  assert.doesNotMatch(appSource, /worker\.managementLabel/u);
  assert.doesNotMatch(appSource, /localizeRuntimeStatus/u);
  assert.doesNotMatch(appSource, /localizeRuntimeBackend/u);
  assert.doesNotMatch(appSource, /localizeSessionPolicy/u);
  assert.doesNotMatch(appSource, /resolveRuntimeChipClass/u);
  assert.doesNotMatch(appSource, /formatRuntimeSessionId/u);
  assert.doesNotMatch(appSource, /pendingOutboxCount/u);
  assert.doesNotMatch(styles, /runtime-session/u);
  assert.doesNotMatch(styles, /runtime-reset/u);
});

test('admin state auto-refresh keeps recovered worker status from looking stuck', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /STATE_REFRESH_INTERVAL_MS\s*=\s*5_000/u);
  assert.match(appSource, /function startStateAutoRefresh/u);
  assert.match(appSource, /refreshState\(\{ silent: true \}\)/u);
  assert.match(appSource, /function canAutoRefreshState/u);
  assert.match(appSource, /function hasOpenActionDrawer/u);
  assert.match(appSource, /!hasOpenActionDrawer\(\)/u);
  assert.match(appSource, /function localizeWorkerError/u);
  assert.match(appSource, /외부 API 연결이 잠시 실패했습니다/u);
  assert.doesNotMatch(appSource, /escapeHtml\(worker\.lastError\)/u);
  assert.doesNotMatch(appSource, /value: context\.agentService\.lastError/u);
});

test('agent more drawers stay open across unavoidable re-renders', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /openActionDrawerIds:\s*captureOpenActionDrawerIds\(\)/u);
  assert.match(appSource, /function restoreOpenActionDrawers/u);
  assert.match(appSource, /drawer\.open\s*=\s*true/u);
  assert.match(appSource, /data-drawer-id="\$\{escapeAttr\(drawerId\)\}"/u);
  assert.match(appSource, /drawerId:\s*`agent:\$\{agent\.name\}`/u);
});

test('agent and channel cards expose click-through activity logs', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(appSource, /open-runtime-history/u);
  assert.match(appSource, /api\/runtime-history/u);
  assert.match(appSource, /function\s+renderRuntimeHistoryModal\s*\(/u);
  assert.match(appSource, /data-target-type="agent"/u);
  assert.match(appSource, /data-target-type="channel"/u);
  assert.match(styles, /\.modal-card--history/u);
  assert.match(styles, /\.activity-log-list/u);
});

test('admin UI exposes durable schedule management', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(appSource, /schedules/u);
  assert.match(appSource, /open-schedule-modal/u);
  assert.match(appSource, /api\/schedules/u);
  assert.match(appSource, /run-schedule/u);
  assert.match(appSource, /function\s+renderScheduleModal\s*\(/u);
  assert.match(appSource, /function\s+renderScheduleList\s*\(/u);
  assert.match(shellSource, /예약/u);
  assert.match(shellSource, /schedule/u);
  assert.match(viewsSource, /renderSchedulesView/u);
  assert.match(viewsSource, /예약 실행/u);
});

test('channels page exposes relay server and routing channels without a Kakao session surface', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(viewsSource, /renderKakaoRelayServerPanel/u);
  assert.match(viewsSource, /<h2>채널<\/h2>/u);
  assert.match(viewsSource, /<h2>KakaoTalk 릴레이 서버<\/h2>/u);
  assert.doesNotMatch(viewsSource, /Kakao 세션 추가/u);
  assert.doesNotMatch(viewsSource, /open-connector-modal/u);
  assert.doesNotMatch(appSource, /start-channel-receiver/u);
  assert.doesNotMatch(appSource, /restart-channel-receiver/u);
  assert.doesNotMatch(appSource, /receiver\/start/u);
  assert.doesNotMatch(appSource, /receiver\/restart/u);
  assert.doesNotMatch(appSource, /buildChannelWorkerContext/u);
  assert.match(appSource, /릴레이 수신 워커 시작/u);
  assert.match(appSource, /릴레이 서버\(base\)/u);
  assert.match(appSource, /Kakao OpenBuilder Skill URL/u);
  assert.match(appSource, /kakao-talkchannel\/webhook/u);
  assert.match(appSource, /릴레이 서버 값은 hkclaw-lite 워커가 붙는 base URL입니다/u);
  assert.match(appSource, /KakaoBiz\/OpenBuilder의 Skill URL에는 반드시/u);
  assert.match(appSource, /KakaoTalk 채널 카드에서 <code>\/pair XXXX-XXXX<\/code> 전체 명령어/u);
  assert.match(appSource, /코드만 보내면 연결되지 않습니다/u);
  assert.match(appSource, /Callback 대기 문구로 처리 중 상태를 보여줍니다/u);
  assert.match(appSource, /Skill data의 <code>text<\/code> 값을 사용하세요/u);
  assert.match(appSource, /getDefaultKakaoSkillUrl/u);
  assert.match(appSource, /renderKakaoChannelStatusTags/u);
  assert.match(appSource, /KakaoTalk 채널/u);
  assert.match(appSource, /pairingCode/u);
  assert.match(appSource, /릴레이 연결됨/u);
  assert.match(appSource, /!runtime\.pairingCode && \(service\.running \|\| service\.starting\)/u);
  assert.match(appSource, /릴레이 서버는 하나만 배포됩니다/u);
  assert.match(appSource, /renderKakaoRelayServerPanel/u);
  assert.doesNotMatch(appSource, /renderKakaoSessionCard/u);
  assert.doesNotMatch(appSource, /renderKakaoSessionList/u);
  assert.match(appSource, /getDefaultChannelAgentName\('kakao'\)/u);
  assert.doesNotMatch(appSource, /Kakao 워커/u);
  assert.doesNotMatch(appSource, /KakaoTalk 수신 워커는 연결 단위로 관리합니다/u);
  assert.doesNotMatch(appSource, /채널은 라우팅 규칙만 저장합니다/u);
  assert.doesNotMatch(appSource, /개 채널/u);
  assert.doesNotMatch(appSource, /사용 채널/u);
  assert.doesNotMatch(viewsSource, /renderChannelWorkerPanel/u);
  assert.doesNotMatch(viewsSource, /<h2>메시지 수신<\/h2>/u);
  assert.doesNotMatch(viewsSource, />채널 워커</u);
  assert.doesNotMatch(viewsSource, /가동 중/u);
  assert.doesNotMatch(appSource, /connector-brief/u);
  assert.doesNotMatch(appSource, /커넥터는 KakaoTalk 전용입니다/u);
  assert.doesNotMatch(appSource, /locked-platform-card/u);
  assert.doesNotMatch(appSource, /이전 Discord\/Telegram 커넥터/u);
  assert.match(appSource, /channel-target-type/u);
  assert.match(appSource, /Discord 사용자 ID/u);
  assert.match(appSource, /telegram-get-updates/u);
  assert.match(appSource, /getUpdates 보기/u);
  assert.match(appSource, /getUpdates 링크 열기/u);
  assert.match(appSource, /선택한 봇 getUpdates 보기/u);
  assert.match(appSource, /최근 발견된 Telegram 채팅/u);
  assert.match(appSource, /apply-telegram-recent-chat/u);
  assert.match(appSource, /refresh-telegram-recent-chats/u);
  assert.doesNotMatch(appSource, /connector-agent-note/u);
  assert.doesNotMatch(appSource, /사용자가 봇에게 한 번 말을 걸면/u);
  assert.match(appSource, /\/api\/connectors/u);
  assert.match(appSource, /findKakaoChannelRouteConflict/u);
  assert.doesNotMatch(appSource, /KakaoTalk 연결이 아직 없습니다/u);
  assert.doesNotMatch(appSource, /Kakao 릴레이 URL/u);
});


test('agent cards distinguish connector-managed channels from legacy agent tokens', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const adminStateSource = readRepoFile('src/admin-state.js');

  assert.match(adminStateSource, /platform:\s*channel\.platform/u);
  assert.match(adminStateSource, /connector:\s*channel\.connector/u);
  assert.match(adminStateSource, /kakaoAgentCredentialConfigured/u);
  assert.match(appSource, /connectorOnly/u);
  assert.match(appSource, /agentCredentialConfiguredByPlatform/u);
  assert.match(appSource, /ownsConnectorOnlyRoute && agentPlatform === 'kakao'/u);
  assert.match(appSource, /Kakao 채널 사용/u);
  assert.match(appSource, /Kakao 채널에서 수신/u);
  assert.match(appSource, /Kakao 채널에서 관리/u);
  assert.match(appSource, /kakaoPlatformManaged/u);
  assert.match(appSource, /renderKakaoPlatformAgentPrimaryAction/u);
  assert.match(appSource, /릴레이 수신 워커 실행 중/u);
  assert.doesNotMatch(appSource, /Kakao platform worker is already running/u);
  assert.match(appSource, /function\s+unique\s*\(/u);
});

test('form fields stay top-aligned when validation messages expand a row', () => {
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(styles, /\.form-grid\s*\{[^}]*align-items:\s*start;/su);
  assert.match(styles, /\.field\s*\{[^}]*align-content:\s*start;/su);
});

test('mobile cards stack actions below content instead of squeezing labels', () => {
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.card\s*\{[\s\S]*?flex-direction:\s*column;/u);
  assert.match(styles, /\.card\s*>\s*\.inline-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(128px, 1fr\)\);/u);
  assert.match(styles, /\.agent-status-grid\s*\{[\s\S]*?overflow-x:\s*auto;/u);
  assert.match(styles, /\.agent-chip\s*\{[\s\S]*?flex:\s*0 0 auto;/u);
});

test('mobile shell exposes a thumb-friendly bottom navigation dock', () => {
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(shellSource, /const NAV_TABS/u);
  assert.match(shellSource, /function renderMobileTabBar/u);
  assert.match(shellSource, /aria-label="빠른 관리 메뉴"/u);
  assert.match(shellSource, /class="mobile-tabbar-link/u);
  assert.doesNotMatch(shellSource, /getMobileNavBadge/u);
  assert.doesNotMatch(shellSource, /mobile-tabbar-badge/u);
  assert.doesNotMatch(shellSource, /side-nav-subtitle/u);
  assert.doesNotMatch(shellSource, /sidebar-summary/u);
  assert.match(styles, /\.mobile-tabbar\s*\{[\s\S]*?display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 1080px\)[\s\S]*?\.mobile-tabbar\s*\{[\s\S]*?position:\s*fixed;/u);
  assert.match(styles, /grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/u);
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);
  assert.doesNotMatch(styles, /mobile-tabbar-badge/u);
  assert.doesNotMatch(styles, /sidebar-summary/u);
});

test('mobile modals use the dynamic viewport and safe-area padding', () => {
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(styles, /\.modal-shell\s*\{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-bottom\)/u);
  assert.match(styles, /\.modal-card\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 24px\);/u);
  assert.match(styles, /\.modal-card\s*>\s*\.section-head\s*\{[\s\S]*?position:\s*sticky;/u);
  assert.match(styles, /\.modal-card\s*>\s*form\s*>\s*\.actions,[\s\S]*?\.modal-card \.wizard-actions\s*\{[\s\S]*?position:\s*sticky;/u);
});

test('closed mobile sidebar is visually and interactively hidden', () => {
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(styles, /\.sidebar-panel\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/u);
  assert.match(styles, /\.sidebar-panel\.is-open,[\s\S]*?\.sidebar-panel--desktop\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?pointer-events:\s*auto;/u);
});

test('channel modal does not show empty-field errors before submit', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(
    appSource,
    /if \(action === 'open-channel-modal'\) \{[\s\S]*?clearFormErrors\('channel'\);/u,
  );
  assert.match(appSource, /const visibleErrors = getFormErrors\('channel'\);/u);
  assert.match(appSource, /refreshVisibleFormErrors\('channel', collectChannelDraftErrors\(\)\);/u);
  assert.doesNotMatch(
    appSource,
    /if \(action === 'open-channel-modal'\) \{[\s\S]*?setFormErrors\('channel', collectChannelDraftErrors/u,
  );
});

test('admin password modal keeps typed values across validation re-renders', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /adminPasswordFormValues:\s*captureAdminPasswordFormValues\(\)/u);
  assert.match(appSource, /restoreAdminPasswordFormValues\(viewState\?\.adminPasswordFormValues\);/u);
  assert.match(appSource, /ADMIN_PASSWORD_FIELD_NAMES/u);
  assert.match(appSource, /Object\.fromEntries\(/u);
  assert.match(appSource, /for \(const name of ADMIN_PASSWORD_FIELD_NAMES\)/u);
  assert.match(appSource, /function\s+captureAdminPasswordFormValues\s*\(/u);
  assert.match(appSource, /function\s+restoreAdminPasswordFormValues\s*\(/u);
  assert.match(appSource, /getNamedInputValue\(form,\s*name\)/u);
  assert.match(appSource, /setNamedInputValue\(form,\s*name,\s*values\[name\]\)/u);
  assert.doesNotMatch(appSource, /name="newPassword"[^>]*value=/u);
  assert.doesNotMatch(appSource, /name="confirmPassword"[^>]*value=/u);
});

test('AI auth manager keeps Claude and browser login controls compact', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.doesNotMatch(viewsSource, /auth-overview-card/u);
  assert.doesNotMatch(viewsSource, /로그인부터 테스트까지/u);
  assert.match(appSource, /function\s+renderAiManagerGuide\s*\(/u);
  assert.match(appSource, /class="auth-steps"/u);
  assert.doesNotMatch(appSource, /Claude Code CLI 로그인 흐름/u);
  assert.doesNotMatch(appSource, /왼쪽부터 순서대로/u);
  assert.match(appSource, /3\. 브라우저 완료 후 주소 붙여넣기/u);
  assert.match(appSource, /showCompleteLoginButton/u);
  assert.match(appSource, /function\s+renderAiRuntimeSummary\s*\(/u);
  assert.match(appSource, /runtimePackageVersion/u);
  assert.match(appSource, /hkclaw-lite가 포함한 Codex CLI/u);
  assert.match(appSource, /모델 목록 불러오기/u);
  assert.doesNotMatch(appSource, /Codex는 hkclaw-lite 전용 저장소/u);
  assert.doesNotMatch(appSource, /외부 Claude CLI는 웹 callback 단계가 없습니다/u);
  assert.doesNotMatch(appSource, /처음이면 로그인 시작을 누르세요/u);
  assert.match(styles, /\.modal-card--ai\s*\{/u);
  assert.match(styles, /\.runtime-summary-card/u);
  assert.match(styles, /\.model-default-card/u);
  assert.match(styles, /\.auth-step\.is-active/u);
  assert.doesNotMatch(styles, /auth-overview-card/u);
});

test('AI auth manager exposes bundled CLI update controls', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /api\/bundled-cli-update/u);
  assert.match(appSource, /번들 업데이트/u);
  assert.match(appSource, /supportsBundledCliUpdate/u);
});

test('agent wizard keeps reasoning effort with model selection', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /question:\s*'모델과 추론 강도는 뭘로 할까요\?'/u);
  assert.match(appSource, /id:\s*'model'[\s\S]*renderModelField\([\s\S]*renderEffortField\(draft\)/u);
  assert.match(appSource, /currentStep\.id === 'model' && optionalDraftText\(draft\.effort\)/u);
  assert.match(appSource, /return \['low', 'medium', 'high', 'xhigh', 'max'\];/u);
  assert.match(appSource, /return \['none', 'low', 'medium', 'high', 'xhigh'\];/u);
  assert.doesNotMatch(
    appSource,
    /id:\s*'execution'[\s\S]*renderEffortField\(draft\)[\s\S]*id:\s*'runtime'/u,
  );
});

test('agent wizard exposes access mode beyond Codex', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /function\s+supportsAgentAccessMode\s*\(/u);
  assert.match(appSource, /\['codex', 'gemini-cli', 'local-llm', 'command'\]/u);
  assert.match(appSource, /id="wizard-agent-access-mode"/u);
  assert.match(appSource, /name="accessMode"/u);
  assert.doesNotMatch(appSource, /id="wizard-agent-codex-access"/u);
});

test('admin login keeps the first screen focused on hkclaw-lite password entry', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(appSource, /id="login-title">hkclaw-lite/u);
  assert.match(appSource, /renderRequiredLabel\('비밀번호'\)/u);
  assert.match(appSource, /autocomplete="current-password"/u);
  assert.match(appSource, /autofocus/u);
  assert.doesNotMatch(appSource, /관리 화면 로그인/u);
  assert.doesNotMatch(appSource, /처음 설정한 환경 변수/u);
  assert.doesNotMatch(appSource, /세션 유지/u);
  assert.match(appSource, /autocomplete="new-password"/u);
  assert.match(appSource, /보호 켜기/u);
  assert.match(viewsSource, /현재 비밀번호 변경/u);
  assert.match(viewsSource, /현재 브라우저 세션 종료/u);
});

test('admin UI fallbacks no longer point at the removed /workspace container path', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(appSource, /const DEFAULT_CHANNEL_WORKSPACE = '~';/u);
  assert.doesNotMatch(appSource, /DEFAULT_CHANNEL_WORKSPACE\s*=\s*'\/workspace'/u);
  assert.doesNotMatch(viewsSource, /"workspace":\s*"\/workspace"/u);
});
