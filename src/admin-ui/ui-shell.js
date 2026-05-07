import { renderIcon } from './icons.js?v=20260507-01';

export const DESKTOP_NAV_MIN_WIDTH = 1081;

const NAV_TABS = [
  { view: 'home', label: '개요' },
  { view: 'agents', label: '에이전트' },
  { view: 'channels', label: '채널' },
  { view: 'schedules', label: '예약' },
  { view: 'topology', label: '구성' },
  { view: 'ai', label: 'AI' },
  { view: 'tokens', label: '토큰' },
  { view: 'all', label: '설정' },
];

export function shouldUseDesktopSidebar(viewportWidth) {
  return Number(viewportWidth) >= DESKTOP_NAV_MIN_WIDTH;
}

export function getViewMeta(view = 'home') {
  const views = {
    home: {
      title: '운영 개요',
    },
    agents: {
      title: '에이전트 운영',
    },
    channels: {
      title: '채널 관리',
    },
    schedules: {
      title: '예약 실행',
    },
    topology: {
      title: '구성 자동화',
    },
    ai: {
      title: 'AI 연결 관리',
    },
    tokens: {
      title: '토큰 사용량',
    },
    all: {
      title: '관리 설정',
    },
  };
  return views[view] || views.home;
}

export function renderMetricCard(label, value, escapeHtml, tone = '', meta = '') {
  return `
    <article class="metric ${tone ? `metric--${tone}` : ''}">
      <div class="metric-head">
        <span class="metric-icon">${renderIcon(resolveMetricIcon(label), 'ui-icon')}</span>
        <span class="metric-label">${escapeHtml(label)}</span>
      </div>
      <strong class="metric-value">${escapeHtml(String(value))}</strong>
      ${meta ? `<span class="metric-meta">${escapeHtml(meta)}</span>` : ''}
    </article>
  `;
}

export function renderShortcutCard({ view, title, description = '', meta = '', state, escapeHtml, escapeAttr }) {
  return `
    <article
      class="shortcut-card ${state.activeView === view ? 'is-active' : ''}"
      data-action="switch-view"
      data-view="${escapeAttr(view)}"
      data-clickable="true"
      role="button"
      tabindex="${state.busy ? '-1' : '0'}"
      aria-disabled="${state.busy ? 'true' : 'false'}"
      aria-current="${state.activeView === view ? 'page' : 'false'}"
    >
      <div class="shortcut-icon">${renderIcon(resolveViewIcon(view), 'ui-icon')}</div>
      <strong>${escapeHtml(title)}</strong>
      ${description ? `<span class="shortcut-copy">${escapeHtml(description)}</span>` : ''}
      ${meta ? `<span class="shortcut-meta">${escapeHtml(meta)}</span>` : ''}
    </article>
  `;
}

function renderSidebar({ state, escapeHtml, escapeAttr, desktopNavVisible = false }) {
  return `
    <aside class="panel sidebar-panel ${state.navOpen || desktopNavVisible ? 'is-open' : ''} ${desktopNavVisible ? 'sidebar-panel--desktop' : ''}" aria-hidden="${desktopNavVisible || state.navOpen ? 'false' : 'true'}" ${desktopNavVisible || state.navOpen ? '' : 'inert'}>
      <div class="sidebar-brand">
        <div class="sidebar-brand-mark">${renderIcon('sparkles', 'ui-icon')}</div>
        <div class="sidebar-brand-copy">
          <strong>hkclaw-lite</strong>
        </div>
        ${
          desktopNavVisible
            ? ''
            : `<button type="button" class="icon-button sidebar-close" data-action="close-nav" aria-label="메뉴 닫기">${renderIcon('close', 'ui-icon')}</button>`
        }
      </div>
      <nav class="side-nav" aria-label="관리 메뉴">
        ${NAV_TABS
          .map(
            (tab) => `
              <button
                type="button"
                class="side-nav-link ${state.activeView === tab.view ? 'is-active' : ''}"
                data-action="switch-view"
                data-view="${escapeAttr(tab.view)}"
                aria-current="${state.activeView === tab.view ? 'page' : 'false'}"
                ${state.busy ? 'disabled' : ''}
              >
                <span class="side-nav-main">
                  <span class="side-nav-icon">${renderIcon(resolveViewIcon(tab.view), 'ui-icon')}</span>
                  <span class="side-nav-copy">
                    <span class="side-nav-label">${escapeHtml(tab.label)}</span>
                  </span>
                </span>
              </button>
            `,
          )
          .join('')}
      </nav>
    </aside>
  `;
}

function renderMobileTabBar({ state, escapeHtml, escapeAttr }) {
  return `
    <nav class="mobile-tabbar" aria-label="빠른 관리 메뉴">
      ${NAV_TABS.map((tab) => {
        const active = state.activeView === tab.view;
        const label = getViewMeta(tab.view).title;
        return `
          <button
            type="button"
            class="mobile-tabbar-link ${active ? 'is-active' : ''}"
            data-action="switch-view"
            data-view="${escapeAttr(tab.view)}"
            aria-current="${active ? 'page' : 'false'}"
            aria-label="${escapeAttr(label)}"
            ${state.busy ? 'disabled' : ''}
          >
            <span class="mobile-tabbar-icon">${renderIcon(resolveViewIcon(tab.view), 'ui-icon')}</span>
            <span class="mobile-tabbar-label">${escapeHtml(tab.label)}</span>
          </button>
        `;
      }).join('')}
    </nav>
  `;
}

export function renderFrame({
  content,
  className = '',
  state,
  escapeAttr,
  escapeHtml,
  renderNotice,
  getActiveViewMeta,
}) {
  const desktopNavVisible = Boolean(state.data && state.desktopNav);
  const sidebarVisible = Boolean(state.data && (desktopNavVisible || state.navOpen));
  return `
    <div class="app-shell ${escapeAttr(className)} ${state.navOpen ? 'is-nav-open' : ''}">
      <div class="app-backdrop" aria-hidden="true"></div>
      ${state.data && !desktopNavVisible && state.navOpen ? `<button type="button" class="nav-scrim is-visible" data-action="close-nav" aria-label="메뉴 닫기"></button>` : ''}
      <div class="workspace-shell ${state.data ? '' : 'workspace-shell--simple'} ${desktopNavVisible ? 'workspace-shell--desktop-nav' : ''}">
        ${sidebarVisible ? renderSidebar({ state, escapeHtml, escapeAttr, desktopNavVisible }) : ''}
        <div class="workspace-main">
          ${state.data ? renderTopBar({ state, escapeHtml, getActiveViewMeta, showNavToggle: !desktopNavVisible }) : ''}
          <div class="shell ${state.data ? 'shell--embedded' : ''}">${content}</div>
        </div>
      </div>
      ${state.data && !desktopNavVisible ? renderMobileTabBar({ state, escapeHtml, escapeAttr }) : ''}
      ${renderNotice()}
    </div>
  `;
}

export function renderTopBar({ state, escapeHtml, getActiveViewMeta, showNavToggle = true }) {
  void state;
  const activeView = getActiveViewMeta();
  return `
    <section class="panel workspace-header">
      <div class="workspace-header-main">
        ${
          showNavToggle
            ? `<button type="button" class="icon-button nav-toggle-button" data-action="toggle-nav" aria-label="메뉴 열기">${renderIcon('menu', 'ui-icon')}</button>`
            : ''
        }
        <div class="workspace-header-copy">
          <h1>${escapeHtml(activeView.title)}</h1>
        </div>
      </div>
    </section>
  `;
}

function resolveViewIcon(view) {
  switch (view) {
    case 'agents':
      return 'agents';
    case 'channels':
      return 'channels';
    case 'schedules':
      return 'schedule';
    case 'topology':
      return 'link';
    case 'ai':
      return 'ai';
    case 'tokens':
      return 'tokens';
    case 'all':
      return 'settings';
    default:
      return 'home';
  }
}

function resolveMetricIcon(label) {
  if (/채널/u.test(label)) {
    return 'channels';
  }
  if (/AI/u.test(label)) {
    return 'ai';
  }
  if (/토큰/u.test(label)) {
    return 'tokens';
  }
  if (/워커/u.test(label)) {
    return 'server';
  }
  return 'chart';
}
