import {
  renderDetailList,
  renderMetricCard,
  renderShortcutCard,
} from './ui-shell.js?v=20260426-01';
import { renderIcon } from './icons.js?v=20260426-01';

export function renderHomeView(ctx) {
  const { state, getDashboardStats, escapeHtml } = ctx;
  const stats = getDashboardStats();

  return `
    <section class="panel section-panel overview-panel">
      <div class="section-head section-head--stack">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('sparkles', 'ui-icon')}</span>
          <h2>바로가기</h2>
        </div>
      </div>
      <div class="shortcut-grid">
        ${renderShortcutCard({ view: 'agents', title: '에이전트', description: '', meta: `${stats.agents.length}개`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
        ${renderShortcutCard({ view: 'channels', title: '채널', description: '', meta: `${stats.channels.length}개`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
        ${renderShortcutCard({ view: 'ai', title: 'AI', description: '', meta: `${stats.readyAiCount}개 준비`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
      </div>
    </section>
  `;
}

export function renderAgentsView(ctx) {
  const { state, getDashboardStats, escapeHtml, escapeAttr, renderAgentList } = ctx;
  const stats = getDashboardStats();
  const discordService = state.data?.discord?.service || {};
  const telegramService = state.data?.telegram?.service || {};
  const kakaoService = state.data?.kakao?.service || {};
  const filterOptions = [
    ['all', '전체'],
    ['running', '실행중'],
    ['connected', '연결됨'],
    ['stopped', '중지'],
    ['issues', '확인 필요'],
    ['missing-token', '토큰 없음'],
    ['discord', 'Discord'],
    ['telegram', 'Telegram'],
    ['kakao', 'KakaoTalk'],
  ];

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('agents', 'ui-icon')}</span>
          <h2>에이전트 목록</h2>
        </div>
        <div class="inline-actions">
          <button type="button" class="btn-primary" data-action="open-agent-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}에이전트 추가</button>
        </div>
      </div>
      <div class="agent-toolbar" data-form="agent-filters">
        <label class="agent-search-field">
          <span>검색</span>
          <input
            type="search"
            name="agentSearch"
            value="${escapeAttr(state.agentSearch || '')}"
            placeholder="이름, 모델, 채널, 워크스페이스"
            autocomplete="off"
          />
        </label>
        <label class="agent-filter-field">
          <span>상태</span>
          <select name="agentFilter">
            ${filterOptions
              .map(([value, label]) => `<option value="${escapeAttr(value)}" ${(state.agentFilter || 'all') === value ? 'selected' : ''}>${escapeHtml(label)}</option>`)
              .join('')}
          </select>
        </label>
        <div class="agent-toolbar-summary" aria-label="에이전트 요약">
          <span class="mini-chip">${renderIcon('agents', 'ui-icon')}${escapeHtml(`전체 ${stats.agents.length}`)}</span>
          <span class="mini-chip mini-chip--ok">${renderIcon('link', 'ui-icon')}${escapeHtml(`연결 ${stats.connectedAgentCount}`)}</span>
          <span class="mini-chip">${renderIcon('server', 'ui-icon')}${escapeHtml(`워커 ${stats.activeWorkerCount}`)}</span>
        </div>
      </div>
      ${renderAgentList(state.data.agents, discordService, telegramService, kakaoService)}
    </section>
  `;
}

export function renderChannelsView(ctx) {
  const { state, getDashboardStats, escapeHtml, renderConnectorList, renderChannelList } = ctx;
  const stats = getDashboardStats();
  return `
    ${renderChannelWorkerPanel({ state, stats, escapeHtml })}
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('link', 'ui-icon')}</span>
          <h2>커넥터</h2>
        </div>
        <button type="button" class="btn-secondary" data-action="open-connector-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}커넥터 추가</button>
      </div>
      <p class="field-hint">커넥터는 플랫폼 계정/토큰 연결이고, 하나의 커넥터를 여러 채널이 공유할 수 있습니다.</p>
      ${renderConnectorList(state.data.connectors || [], state.data.channels || [])}
    </section>
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('channels', 'ui-icon')}</span>
          <h2>채널 목록</h2>
        </div>
        <button type="button" class="btn-primary" data-action="open-channel-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}추가</button>
      </div>
      ${renderChannelList(state.data.channels, state.data.agents)}
    </section>
  `;
}

function renderChannelWorkerPanel({ state, stats, escapeHtml }) {
  const services = [
    {
      key: 'discord',
      label: 'Discord',
      count: stats.discordChannelCount,
      service: state.data?.discord?.service || {},
      startAction: 'start-discord-service',
      restartAction: 'restart-discord-service',
      stopAction: 'stop-discord-service',
    },
    {
      key: 'telegram',
      label: 'Telegram',
      count: stats.telegramChannelCount,
      service: state.data?.telegram?.service || {},
      startAction: 'start-telegram-service',
      restartAction: 'restart-telegram-service',
      stopAction: 'stop-telegram-service',
    },
    {
      key: 'kakao',
      label: 'KakaoTalk',
      count: stats.kakaoChannelCount,
      service: state.data?.kakao?.service || {},
      startAction: 'start-kakao-service',
      restartAction: 'restart-kakao-service',
      stopAction: 'stop-kakao-service',
    },
  ];

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('server', 'ui-icon')}</span>
          <h2>채널 워커</h2>
        </div>
      </div>
      <p class="field-hint">커넥터 기반 채널은 에이전트별 토큰이 아니라 플랫폼 워커가 수신을 담당합니다.</p>
      <div class="card-list card-list--compact service-worker-list">
        ${services.map((entry) => renderChannelWorkerCard(entry, state, escapeHtml)).join('')}
      </div>
    </section>
  `;
}

function renderChannelWorkerCard(entry, state, escapeHtml) {
  const service = entry.service || {};
  const running = Boolean(service.running);
  const starting = Boolean(service.starting);
  const stale = Boolean(service.stale);
  const label = service.label || '중지';
  const statusClass = stale ? 'mini-chip--danger' : running ? 'mini-chip--ok' : '';
  const disabled = state.busy || starting || entry.count === 0;
  const lastError = service.lastError
    ? `<p class="field-hint field-hint--danger">${escapeHtml(service.lastError)}</p>`
    : '';

  return `
    <article class="card card--stack service-worker-card">
      <div class="card-main">
        <div class="card-title-row">
          ${renderIcon('server', 'ui-icon')}
          <strong>${escapeHtml(entry.label)}</strong>
        </div>
        <div class="card-tags">
          <span class="mini-chip ${statusClass}">${escapeHtml(label)}</span>
          <span class="mini-chip">${escapeHtml(`채널 ${entry.count}개`)}</span>
        </div>
        ${lastError}
      </div>
      <div class="inline-actions">
        ${
          running || stale
            ? `<button type="button" class="btn-secondary" data-action="${entry.restartAction}" ${state.busy || (!running && !stale) ? 'disabled' : ''}>${renderIcon('refresh', 'ui-icon')}재시작</button>`
            : `<button type="button" class="btn-secondary" data-action="${entry.startAction}" ${disabled ? 'disabled' : ''}>${renderIcon('play', 'ui-icon')}시작</button>`
        }
        ${
          running || stale || starting
            ? `<button type="button" class="btn-secondary" data-action="${entry.stopAction}" ${state.busy || (!running && !stale && !starting) ? 'disabled' : ''}>${renderIcon('stop', 'ui-icon')}중지</button>`
            : ''
        }
      </div>
    </article>
  `;
}

export function renderAllView(ctx) {
  const { state, escapeHtml } = ctx;
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('settings', 'ui-icon')}</span>
          <h2>관리</h2>
        </div>
      </div>
      <div class="settings-grid">
        <article
          class="card card--clickable settings-card"
          data-action="open-admin-password-modal"
          data-clickable="true"
          role="button"
          tabindex="${state.busy ? '-1' : '0'}"
          aria-disabled="${state.busy ? 'true' : 'false'}"
        >
          <div class="card-main">
            <strong class="card-title">관리자 비밀번호</strong>
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '설정됨' : '')}</span>
          </div>
        </article>
        <article
          class="card card--clickable card--danger settings-card"
          ${state.auth.enabled ? 'data-action="logout" data-clickable="true"' : ''}
          role="button"
          tabindex="${state.busy || !state.auth.enabled ? '-1' : '0'}"
          aria-disabled="${state.busy || !state.auth.enabled ? 'true' : 'false'}"
        >
          <div class="card-main">
            <strong class="card-title">로그아웃</strong>
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '' : '비활성화됨')}</span>
          </div>
        </article>
      </div>
    </section>
  `;
}

export function renderAiView(ctx) {
  const { state, getDashboardStats, escapeHtml, renderAiList, getLocalLlmConnectionEntries } = ctx;
  const stats = getDashboardStats();
  const supportsLocalLlm = (state.data?.choices?.agentTypes || []).some(
    (entry) => entry.value === 'local-llm',
  );
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('ai', 'ui-icon')}</span>
          <h2>AI 관리</h2>
        </div>
        ${
          supportsLocalLlm
            ? `<button
                type="button"
                class="btn-secondary"
                data-action="open-local-llm-create"
                ${state.busy ? 'disabled' : ''}
              >
                ${renderIcon('plus', 'ui-icon')}신규 LLM 추가
              </button>`
            : ''
        }
      </div>
      ${renderAiList()}
    </section>
  `;
}
