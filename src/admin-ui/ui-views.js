import {
  renderDetailList,
  renderMetricCard,
  renderShortcutCard,
} from './ui-shell.js?v=20260427-02';
import { renderIcon } from './icons.js?v=20260427-02';

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
          <span class="mini-chip">${renderIcon('server', 'ui-icon')}${escapeHtml(`수신 ${stats.activeWorkerCount}`)}</span>
        </div>
      </div>
      ${renderAgentList(state.data.agents, discordService, telegramService, kakaoService)}
    </section>
  `;
}

export function renderChannelsView(ctx) {
  const { state, renderConnectorList, renderChannelList } = ctx;
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('channels', 'ui-icon')}</span>
          <h2>채널</h2>
        </div>
        <button type="button" class="btn-primary" data-action="open-channel-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}채널 추가</button>
      </div>
      ${renderChannelList(state.data.channels, state.data.agents, state.data)}
    </section>
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('link', 'ui-icon')}</span>
          <h2>KakaoTalk 연결</h2>
        </div>
        <button type="button" class="btn-secondary" data-action="open-connector-modal" ${state.busy ? 'disabled' : ''}>${renderIcon('plus', 'ui-icon')}Kakao 연결 추가</button>
      </div>
      ${renderConnectorList(state.data.connectors || [], state.data.channels || [])}
    </section>
  `;
}

export function renderTopologyView(ctx) {
  const { state, escapeHtml, escapeAttr, renderTopologyResult } = ctx;
  const draft = state.topologyDraft || '';
  const placeholder = `{
  "version": 1,
  "agents": [
    {
      "name": "auto-owner",
      "agent": "codex",
      "platform": "kakao",
      "sandbox": "workspace-write"
    }
  ],
  "connectors": [
    {
      "name": "auto-kakao",
      "type": "kakao",
      "kakaoRelayUrl": "https://hkclaw.example/",
      "secretRefs": {
        "kakaoRelayTokenEnv": "HKCLAW_KAKAO_RELAY_TOKEN"
      }
    }
  ],
  "channels": [
    {
      "name": "auto-kakao-main",
      "platform": "kakao",
      "connector": "auto-kakao",
      "kakaoChannelId": "*",
      "workspace": "/workspace",
      "agent": "auto-owner"
    }
  ]
}`;

  return `
    <section class="panel section-panel topology-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('link', 'ui-icon')}</span>
          <h2>Topology 자동화</h2>
        </div>
        <div class="inline-actions">
          <button type="button" class="btn-secondary" data-action="topology-export" ${state.busy ? 'disabled' : ''}>${renderIcon('refresh', 'ui-icon')}현재 구성 불러오기</button>
          <button type="button" class="btn-secondary" data-action="topology-plan" ${state.busy ? 'disabled' : ''}>${renderIcon('notice', 'ui-icon')}Plan</button>
          <button type="button" class="btn-primary" data-action="topology-apply" ${state.busy ? 'disabled' : ''}>${renderIcon('play', 'ui-icon')}Apply</button>
        </div>
      </div>
      <div class="topology-grid" data-form="topology">
        <label class="field topology-editor">
          <span>Topology JSON</span>
          <textarea
            name="topologySpec"
            class="topology-textarea"
            spellcheck="false"
            placeholder="${escapeAttr(placeholder)}"
          >${escapeHtml(draft)}</textarea>
        </label>
        <div class="topology-result">
          ${renderTopologyResult(state.topologyResult)}
        </div>
      </div>
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
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '현재 비밀번호 변경' : '관리 화면 보호 켜기')}</span>
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
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '현재 브라우저 세션 종료' : '로그인 보호 비활성화됨')}</span>
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
      <div class="auth-overview-card">
        <div>
          <strong>로그인부터 테스트까지 한 화면에서 끝냅니다.</strong>
        </div>
        <div class="auth-overview-steps" aria-label="AI 인증 순서">
          <span class="mini-chip">${renderIcon('server', 'ui-icon')}상태 확인</span>
          <span class="mini-chip">${renderIcon('login', 'ui-icon')}로그인</span>
          <span class="mini-chip mini-chip--ok">${renderIcon('play', 'ui-icon')}응답 테스트</span>
        </div>
      </div>
      ${renderAiList()}
    </section>
  `;
}
