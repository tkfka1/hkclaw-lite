import {
  renderDetailList,
  renderMetricCard,
  renderShortcutCard,
} from './ui-shell.js?v=20260421-22';

export function renderHomeView(ctx) {
  const { state, getDashboardStats, escapeHtml } = ctx;
  const stats = getDashboardStats();
  const discordStatus = stats.discordService.label || '중지';
  const telegramStatus = stats.telegramService.label || '중지';

  return `
    <section class="metrics metrics--hero metrics--four">
      ${renderMetricCard('에이전트', stats.agents.length, escapeHtml, 'accent', `토큰 설정 ${stats.configuredAgentCount}`)}
      ${renderMetricCard('활성 워커', stats.activeWorkerCount, escapeHtml, '', `연결됨 ${stats.connectedAgentCount}`)}
      ${renderMetricCard('채널', stats.channels.length, escapeHtml, '', `Tribunal ${stats.tribunalChannelCount}`)}
      ${renderMetricCard('사용 가능한 AI', `${stats.readyAiCount}/${stats.availableAiCount}`, escapeHtml, 'calm', `Claude 세션 ${stats.claudeSessionCount}`)}
    </section>
    <section class="grid-two">
      <section class="panel section-panel overview-panel">
        <div class="section-head section-head--stack">
          <div>
            <span class="section-eyebrow">Runtime</span>
            <h2>상태</h2>
          </div>
        </div>
        ${renderDetailList([
          { label: 'Discord 워커', value: discordStatus },
          { label: 'Telegram 워커', value: telegramStatus },
          { label: '연결된 에이전트', value: `${stats.connectedAgentCount} / ${stats.agents.length}` },
          { label: '관리자 보호', value: state.auth.enabled ? '활성화' : '비활성화' },
        ], escapeHtml)}
      </section>
      <section class="panel section-panel overview-panel">
        <div class="section-head section-head--stack">
          <div>
            <span class="section-eyebrow">Navigate</span>
            <h2>바로가기</h2>
          </div>
        </div>
        <div class="shortcut-grid">
          ${renderShortcutCard({ view: 'agents', title: '에이전트', description: '실행 · 재시작', meta: `${stats.activeWorkerCount}개 실행`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'channels', title: '채널', description: '구성 · 역할', meta: `${stats.channels.length}개`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'ai', title: 'AI', description: '로그인 · 연결', meta: `${stats.readyAiCount}개 준비`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'tokens', title: '토큰', description: '사용 기록', meta: `${stats.claudeSessionCount}개 세션`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
        </div>
      </section>
    </section>
    <section class="grid-two">
      <section class="panel section-panel overview-panel">
        <div class="section-head section-head--stack">
          <div>
            <span class="section-eyebrow">Agents</span>
            <h2>구성</h2>
          </div>
        </div>
        ${renderDetailList(
          stats.agentTypeSummary.map((entry) => ({
            label: entry.label,
            value: `${entry.count}개`,
          })),
          escapeHtml,
          '아직 등록된 에이전트가 없습니다.',
        )}
      </section>
      <section class="panel section-panel overview-panel">
        <div class="section-head section-head--stack">
          <div>
            <span class="section-eyebrow">Channels</span>
            <h2>분포</h2>
          </div>
        </div>
        ${renderDetailList(
          [
            ...stats.channelModeSummary.map((entry) => ({
              label: entry.label,
              value: `${entry.count}개`,
            })),
            ...stats.channelPlatformSummary.map((entry) => ({
              label: `${entry.label} 플랫폼`,
              value: `${entry.count}개`,
            })),
          ],
          escapeHtml,
          '아직 등록된 채널이 없습니다.',
        )}
      </section>
    </section>
  `;
}

export function renderAgentsView(ctx) {
  const { state, getDashboardStats, escapeHtml, renderAgentList } = ctx;
  const stats = getDashboardStats();
  const discordService = state.data?.discord?.service || {};
  const telegramService = state.data?.telegram?.service || {};
  const serviceLabel = discordService.label || '중지';
  const telegramLabel = telegramService.label || '중지';
  const canStartDiscord = !state.busy && !discordService.running;
  const canRestartDiscord = !state.busy && (discordService.running || discordService.stale);
  const canStopDiscord = !state.busy && (discordService.running || discordService.stale);
  const canReloadDiscord = !state.busy && discordService.running;
  const canStartTelegram = !state.busy && !telegramService.running;
  const canRestartTelegram = !state.busy && (telegramService.running || telegramService.stale);
  const canStopTelegram = !state.busy && (telegramService.running || telegramService.stale);
  const canReloadTelegram = !state.busy && telegramService.running;

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div>
          <span class="section-eyebrow">Agents</span>
          <h2>에이전트 목록</h2>
        </div>
        <div class="inline-actions">
          <button type="button" class="btn-primary" data-action="open-agent-modal" ${state.busy ? 'disabled' : ''}>에이전트 추가</button>
        </div>
      </div>
      <section class="metrics metrics--compact metrics--three">
        ${renderMetricCard('등록됨', stats.agents.length, escapeHtml, '', `토큰 설정 ${stats.configuredAgentCount}`)}
        ${renderMetricCard('활성 워커', stats.activeWorkerCount, escapeHtml, '', `연결됨 ${stats.connectedAgentCount}`)}
        ${renderMetricCard('플랫폼', stats.agents.length, escapeHtml, '', `Discord ${stats.agents.filter((entry) => (entry.platform || 'discord') === 'discord').length} · Telegram ${stats.agents.filter((entry) => (entry.platform || 'discord') === 'telegram').length}`)}
      </section>
      <div class="service-grid">
        <article class="service-card">
          <div class="service-card-head">
            <div>
              <span class="section-eyebrow">Discord</span>
              <strong>Discord 워커</strong>
            </div>
            <span class="status-pill ${discordService.running ? 'is-ok' : discordService.stale ? 'is-warning' : ''}">${escapeHtml(serviceLabel)}</span>
          </div>
          <div class="inline-actions">
            <button type="button" class="btn-secondary" data-action="start-discord-service" ${canStartDiscord ? '' : 'disabled'}>전체 실행</button>
            <button type="button" class="btn-secondary" data-action="restart-discord-service" ${canRestartDiscord ? '' : 'disabled'}>전체 재시작</button>
            <button type="button" class="btn-secondary" data-action="stop-discord-service" ${canStopDiscord ? '' : 'disabled'}>전체 중지</button>
            <button type="button" class="btn-secondary" data-action="reload-discord-service" ${canReloadDiscord ? '' : 'disabled'}>구성 다시 읽기</button>
          </div>
        </article>
        <article class="service-card">
          <div class="service-card-head">
            <div>
              <span class="section-eyebrow">Telegram</span>
              <strong>Telegram 워커</strong>
            </div>
            <span class="status-pill ${telegramService.running ? 'is-ok' : telegramService.stale ? 'is-warning' : ''}">${escapeHtml(telegramLabel)}</span>
          </div>
          <div class="inline-actions">
            <button type="button" class="btn-secondary" data-action="start-telegram-service" ${canStartTelegram ? '' : 'disabled'}>전체 실행</button>
            <button type="button" class="btn-secondary" data-action="restart-telegram-service" ${canRestartTelegram ? '' : 'disabled'}>전체 재시작</button>
            <button type="button" class="btn-secondary" data-action="stop-telegram-service" ${canStopTelegram ? '' : 'disabled'}>전체 중지</button>
            <button type="button" class="btn-secondary" data-action="reload-telegram-service" ${canReloadTelegram ? '' : 'disabled'}>구성 다시 읽기</button>
          </div>
        </article>
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
        <div>
          <span class="section-eyebrow">Channels</span>
          <h2>채널 목록</h2>
        </div>
        <button type="button" class="btn-primary" data-action="open-channel-modal" ${state.busy ? 'disabled' : ''}>추가</button>
      </div>
      <section class="metrics metrics--compact metrics--three">
        ${renderMetricCard('전체 채널', stats.channels.length, escapeHtml, '', `Tribunal ${stats.tribunalChannelCount}`)}
        ${renderMetricCard('Discord', stats.discordChannelCount, escapeHtml, '', '기본 운영 채널')}
        ${renderMetricCard('Telegram', stats.telegramChannelCount, escapeHtml, '', `Claude 세션 ${stats.claudeSessionCount}`)}
      </section>
      ${renderChannelList(state.data.channels, state.data.agents)}
    </section>
  `;
}

export function renderAllView(ctx) {
  const { state, escapeHtml } = ctx;
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div>
          <span class="section-eyebrow">Settings</span>
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
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '설정됨' : '미설정')}</span>
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
            <span class="card-meta">${escapeHtml(state.auth.enabled ? '현재 세션 종료' : '비활성화됨')}</span>
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
        <div>
          <span class="section-eyebrow">AI Runtime</span>
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
                신규 LLM 추가
              </button>`
            : ''
        }
      </div>
      <section class="metrics metrics--compact metrics--three">
        ${renderMetricCard('준비된 AI', `${stats.readyAiCount}/${stats.availableAiCount}`, escapeHtml, 'calm', '로그인/연결 상태 기준')}
        ${renderMetricCard('로컬 LLM', getLocalLlmConnectionEntries().length, escapeHtml, '', '연결별 관리')}
        ${renderMetricCard('토큰 기록', stats.claudeSessionCount, escapeHtml, '', 'Claude 세션 수')}
      </section>
      ${renderAiList()}
    </section>
  `;
}
