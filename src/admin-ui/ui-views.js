import {
  renderDetailList,
  renderMetricCard,
  renderShortcutCard,
} from './ui-shell.js?v=20260424-01';
import { renderIcon } from './icons.js?v=20260424-01';

export function renderHomeView(ctx) {
  const { state, getDashboardStats, escapeHtml } = ctx;
  const stats = getDashboardStats();

  return `
    <section class="panel section-panel overview-panel">
      <div class="section-head section-head--stack">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('sparkles', 'ui-icon')}</span>
          <div>
            <span class="section-eyebrow">Launcher</span>
            <h2>바로가기</h2>
          </div>
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
  const { state, getDashboardStats, escapeHtml, renderAgentList } = ctx;
  const stats = getDashboardStats();
  const discordService = state.data?.discord?.service || {};
  const telegramService = state.data?.telegram?.service || {};

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('agents', 'ui-icon')}</span>
          <div>
          <span class="section-eyebrow">Agents</span>
          <h2>에이전트 목록</h2>
          </div>
        </div>
        <div class="inline-actions">
          <button type="button" class="btn-primary" data-action="open-agent-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}에이전트 추가</button>
        </div>
      </div>
      ${renderAgentList(state.data.agents, discordService, telegramService)}
    </section>
  `;
}

export function renderChannelsView(ctx) {
  const { state, getDashboardStats, escapeHtml, renderChannelList } = ctx;
  const stats = getDashboardStats();
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('channels', 'ui-icon')}</span>
          <div>
          <span class="section-eyebrow">Channels</span>
          <h2>채널 목록</h2>
          </div>
        </div>
        <button type="button" class="btn-primary" data-action="open-channel-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}추가</button>
      </div>
      ${renderChannelList(state.data.channels, state.data.agents)}
    </section>
  `;
}

export function renderAllView(ctx) {
  const { state, escapeHtml } = ctx;
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('settings', 'ui-icon')}</span>
          <div>
          <span class="section-eyebrow">Settings</span>
          <h2>관리</h2>
          </div>
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
          <div>
          <span class="section-eyebrow">AI Runtime</span>
          <h2>AI 관리</h2>
          </div>
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
