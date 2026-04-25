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
  assert.match(shellSource, /nav-toggle-button/u);
  assert.match(shellSource, /desktopNavVisible \|\| state\.navOpen \? '' : 'inert'/u);
});

test('agents page keeps operator controls visible and bookmarkable', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(appSource, /VIEW_NAMES/u);
  assert.match(appSource, /window\.location\.hash/u);
  assert.match(appSource, /agentSearch/u);
  assert.match(appSource, /agentFilter/u);
  assert.match(appSource, /renderAgentDetailPanel/u);
  assert.match(viewsSource, /data-form="agent-filters"/u);
  assert.match(viewsSource, /name="agentSearch"/u);
  assert.match(viewsSource, /name="agentFilter"/u);
});

test('channels page exposes role-scoped runtime session controls', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');

  assert.match(appSource, /renderChannelRuntimeSessions/u);
  assert.match(appSource, /data-role=/u);
  assert.match(appSource, /open-reset-channel-runtime-sessions/u);
  assert.match(appSource, /confirm-reset-channel-runtime-sessions/u);
  assert.match(appSource, /channel\.name.*session\.role/us);
});

test('channels page exposes reusable connector management', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const viewsSource = readRepoFile('src/admin-ui/ui-views.js');

  assert.match(viewsSource, /renderConnectorList/u);
  assert.match(viewsSource, /renderChannelWorkerPanel/u);
  assert.match(viewsSource, /start-kakao-service/u);
  assert.match(appSource, /data-form="connector"/u);
  assert.match(appSource, /open-connector-modal/u);
  assert.match(appSource, /\/api\/connectors/u);
  assert.match(appSource, /findKakaoChannelRouteConflict/u);
});

test('agent cards distinguish connector-managed channels from legacy agent tokens', () => {
  const appSource = readRepoFile('src/admin-ui/app.js');
  const adminStateSource = readRepoFile('src/admin-state.js');

  assert.match(adminStateSource, /platform:\s*channel\.platform/u);
  assert.match(adminStateSource, /connector:\s*channel\.connector/u);
  assert.match(appSource, /connectorOnly/u);
  assert.match(appSource, /커넥터 사용/u);
  assert.match(appSource, /채널 워커 사용/u);
  assert.match(appSource, /채널 탭에서 관리/u);
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
});

test('mobile shell exposes a thumb-friendly bottom navigation dock', () => {
  const shellSource = readRepoFile('src/admin-ui/ui-shell.js');
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(shellSource, /const NAV_TABS/u);
  assert.match(shellSource, /function renderMobileTabBar/u);
  assert.match(shellSource, /aria-label="빠른 관리 메뉴"/u);
  assert.match(shellSource, /class="mobile-tabbar-link/u);
  assert.match(shellSource, /getMobileNavBadge/u);
  assert.match(styles, /\.mobile-tabbar\s*\{[\s\S]*?display:\s*none;/u);
  assert.match(styles, /@media \(max-width: 1080px\)[\s\S]*?\.mobile-tabbar\s*\{[\s\S]*?position:\s*fixed;/u);
  assert.match(styles, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\);/u);
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);
});

test('mobile modals use the dynamic viewport and safe-area padding', () => {
  const styles = readRepoFile('src/admin-ui/styles.css');

  assert.match(styles, /\.modal-shell\s*\{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-bottom\)/u);
  assert.match(styles, /\.modal-card\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 24px\);/u);
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
