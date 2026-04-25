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
