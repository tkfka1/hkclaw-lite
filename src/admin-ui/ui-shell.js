export function getViewMeta(view = 'home') {
  const views = {
    home: {
      eyebrow: 'Overview',
      title: '운영 개요',
      description: '상태 요약',
    },
    agents: {
      eyebrow: 'Agents',
      title: '에이전트 운영',
      description: '워커 제어',
    },
    channels: {
      eyebrow: 'Channels',
      title: '채널 구성',
      description: '채널 관리',
    },
    ai: {
      eyebrow: 'AI Runtime',
      title: 'AI 연결 관리',
      description: '연결 상태',
    },
    tokens: {
      eyebrow: 'Usage',
      title: '토큰 사용량',
      description: '사용 기록',
    },
    all: {
      eyebrow: 'Settings',
      title: '관리 설정',
      description: '콘솔 설정',
    },
  };
  return views[view] || views.home;
}

export function summarizeCounts(entries, getKey, getLabel = (value) => value) {
  const counts = new Map();
  for (const entry of entries || []) {
    const key = getKey(entry);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: getLabel(key),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'ko'));
}

export function getDashboardStats({
  data,
  aiStatuses,
  getLocalLlmConnectionEntries,
  isAiReady,
  localizeAgentTypeValue,
  localizeChannelMode,
  localizeMessagingPlatform,
}) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  const discordService = data?.discord?.service || {};
  const telegramService = data?.telegram?.service || {};
  const discordRuntimeAgents = discordService.agents || discordService.bots || {};
  const telegramRuntimeAgents = telegramService.agents || telegramService.bots || {};
  const agentTypes = (data?.choices?.agentTypes || []).filter(
    (entry) => !['command', 'local-llm'].includes(entry.value),
  );
  const localLlmConnections = getLocalLlmConnectionEntries();

  const configuredAgentCount = agents.filter((agent) => {
    const platform = agent.platform || 'discord';
    return platform === 'telegram'
      ? Boolean(agent.telegramBotTokenConfigured)
      : Boolean(agent.discordTokenConfigured);
  }).length;

  const activeWorkerCount = agents.filter((agent) => {
    const platform = agent.platform || 'discord';
    const service = platform === 'telegram' ? agent.telegramService : agent.discordService;
    return Boolean(service?.running || service?.starting || service?.stale);
  }).length;

  const connectedAgentCount = agents.filter((agent) => {
    const platform = agent.platform || 'discord';
    return platform === 'telegram'
      ? Boolean(telegramRuntimeAgents[agent.name]?.connected)
      : Boolean(discordRuntimeAgents[agent.name]?.connected);
  }).length;

  const availableAiCount = agentTypes.length + localLlmConnections.length;
  const readyAiCount =
    agentTypes.filter((entry) => isAiReady(entry.value, aiStatuses[entry.value] || {})).length +
    (isAiReady('local-llm', aiStatuses['local-llm'] || {}) ? localLlmConnections.length : 0);

  const tribunalChannelCount = channels.filter(
    (channel) => (channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single')) === 'tribunal',
  ).length;
  const discordChannelCount = channels.filter((channel) => (channel.platform || 'discord') === 'discord').length;
  const telegramChannelCount = channels.filter((channel) => (channel.platform || 'discord') === 'telegram').length;
  const claudeSessionCount = channels.reduce((total, channel) => {
    const sessions = Array.isArray(channel.runtime?.sessions) ? channel.runtime.sessions : [];
    return total + sessions.filter((session) => session.runtimeBackend === 'claude-cli' && session.runtimeSessionId).length;
  }, 0);

  return {
    agents,
    channels,
    discordService,
    telegramService,
    configuredAgentCount,
    activeWorkerCount,
    connectedAgentCount,
    availableAiCount,
    readyAiCount,
    tribunalChannelCount,
    discordChannelCount,
    telegramChannelCount,
    claudeSessionCount,
    agentTypeSummary: summarizeCounts(
      agents,
      (agent) => agent.agent,
      (value) => localizeAgentTypeValue(value),
    ),
    channelModeSummary: summarizeCounts(
      channels,
      (channel) => channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single'),
      (value) => localizeChannelMode(value),
    ),
    channelPlatformSummary: summarizeCounts(
      channels,
      (channel) => channel.platform || 'discord',
      (value) => localizeMessagingPlatform(value),
    ),
  };
}

export function renderDetailList(rows, escapeHtml, emptyText = '표시할 정보가 없습니다.') {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return `<div class="field-hint">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="detail-list">
      ${list
        .map(
          (row) => `
            <div class="detail-row">
              <span class="detail-label">${escapeHtml(row.label)}</span>
              <strong class="detail-value">${escapeHtml(row.value)}</strong>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

export function renderMetricCard(label, value, escapeHtml, tone = '', meta = '') {
  return `
    <article class="metric ${tone ? `metric--${tone}` : ''}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong class="metric-value">${escapeHtml(String(value))}</strong>
      ${meta ? `<span class="metric-meta">${escapeHtml(meta)}</span>` : ''}
    </article>
  `;
}

export function renderShortcutCard({ view, title, description, meta, state, escapeHtml, escapeAttr }) {
  return `
    <article
      class="shortcut-card ${state.activeView === view ? 'is-active' : ''}"
      data-action="switch-view"
      data-view="${escapeAttr(view)}"
      data-clickable="true"
      role="button"
      tabindex="${state.busy ? '-1' : '0'}"
      aria-disabled="${state.busy ? 'true' : 'false'}"
    >
      <span class="shortcut-eyebrow">${escapeHtml(getViewMeta(view).eyebrow)}</span>
      <strong>${escapeHtml(title)}</strong>
      ${description ? `<span class="shortcut-copy">${escapeHtml(description)}</span>` : ''}
      <span class="shortcut-meta">${escapeHtml(meta)}</span>
    </article>
  `;
}

function renderSidebar({ state, stats, escapeHtml, escapeAttr }) {
  const tabs = [
    { view: 'home', label: '개요' },
    { view: 'agents', label: '에이전트' },
    { view: 'channels', label: '채널' },
    { view: 'ai', label: 'AI' },
    { view: 'tokens', label: '토큰' },
    { view: 'all', label: '설정' },
  ];
  return `
    <aside class="panel sidebar-panel">
      <div class="sidebar-brand">
        <span class="hero-eyebrow">hkclaw-lite</span>
        <strong>Operations Console</strong>
      </div>
      <nav class="side-nav" aria-label="관리 메뉴">
        ${tabs
          .map(
            (tab) => `
              <button
                type="button"
                class="side-nav-link ${state.activeView === tab.view ? 'is-active' : ''}"
                data-action="switch-view"
                data-view="${escapeAttr(tab.view)}"
                ${state.busy ? 'disabled' : ''}
              >
                <span class="side-nav-label">${escapeHtml(tab.label)}</span>
                ${tab.meta ? `<span class="side-nav-meta">${escapeHtml(tab.meta)}</span>` : ''}
              </button>
            `,
          )
          .join('')}
      </nav>
      <div class="sidebar-summary">
        <div class="sidebar-summary-row">
          <span>에이전트</span>
          <strong>${escapeHtml(String(stats.agents.length))}</strong>
        </div>
        <div class="sidebar-summary-row">
          <span>활성 워커</span>
          <strong>${escapeHtml(String(stats.activeWorkerCount))}</strong>
        </div>
        <div class="sidebar-summary-row">
          <span>채널</span>
          <strong>${escapeHtml(String(stats.channels.length))}</strong>
        </div>
        <div class="sidebar-summary-row">
          <span>준비된 AI</span>
          <strong>${escapeHtml(`${stats.readyAiCount}/${stats.availableAiCount}`)}</strong>
        </div>
      </div>
    </aside>
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
  getDashboardStats,
}) {
  const stats = state.data ? getDashboardStats() : null;
  return `
    <div class="app-shell ${escapeAttr(className)}">
      <div class="app-backdrop" aria-hidden="true"></div>
      <div class="workspace-shell ${state.data ? '' : 'workspace-shell--simple'}">
        ${state.data && stats ? renderSidebar({ state, stats, escapeHtml, escapeAttr }) : ''}
        <div class="workspace-main">
          ${state.data ? renderTopBar({ state, escapeHtml, getActiveViewMeta, stats }) : ''}
          <div class="shell ${state.data ? 'shell--embedded' : ''}">${content}</div>
        </div>
      </div>
      ${renderNotice()}
    </div>
  `;
}

export function renderTopBar({ state, escapeHtml, getActiveViewMeta, stats }) {
  void state;
  void getActiveViewMeta;
  return `
    <section class="panel workspace-header">
      <div class="workspace-status">
        <span class="status-pill ${stats.discordService.running ? 'is-ok' : stats.discordService.stale ? 'is-warning' : ''}">
          ${escapeHtml(`Discord ${stats.discordService.label || '중지'}`)}
        </span>
        <span class="status-pill ${stats.telegramService.running ? 'is-ok' : stats.telegramService.stale ? 'is-warning' : ''}">
          ${escapeHtml(`Telegram ${stats.telegramService.label || '중지'}`)}
        </span>
        <span class="status-pill">${escapeHtml(`연결 ${stats.connectedAgentCount}/${stats.agents.length}`)}</span>
      </div>
    </section>
  `;
}
