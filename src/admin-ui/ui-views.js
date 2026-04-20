import {
  renderDetailList,
  renderMetricCard,
  renderShortcutCard,
} from './ui-shell.js';

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
            <h2>현재 운영 상태</h2>
          </div>
          <span class="field-hint">지금 열려 있는 콘솔의 핵심 신호만 모았습니다.</span>
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
            <h2>빠른 이동</h2>
          </div>
          <span class="field-hint">관리 빈도가 높은 영역부터 바로 들어갑니다.</span>
        </div>
        <div class="shortcut-grid">
          ${renderShortcutCard({ view: 'agents', title: '에이전트', description: '워커 실행, 재연결, 모델 구성을 바로 조정합니다.', meta: `${stats.activeWorkerCount}개 실행 중`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'channels', title: '채널', description: '운영 채널, 역할, 세션 재사용 구성을 정리합니다.', meta: `${stats.channels.length}개 채널`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'ai', title: 'AI', description: '로그인, API 키, 로컬 LLM 연결을 관리합니다.', meta: `${stats.readyAiCount}개 준비됨`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
          ${renderShortcutCard({ view: 'tokens', title: '토큰', description: '최근 사용량과 추이를 확인합니다.', meta: `${stats.claudeSessionCount}개 세션`, state, escapeHtml, escapeAttr: ctx.escapeAttr })}
        </div>
      </section>
    </section>
    <section class="grid-two">
      <section class="panel section-panel overview-panel">
        <div class="section-head section-head--stack">
          <div>
            <span class="section-eyebrow">Agents</span>
            <h2>AI 구성 분포</h2>
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
            <h2>채널 구성 분포</h2>
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
          <div class="field-hint">에이전트별 워커 상태를 다시 읽거나 전체 제어합니다.</div>
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
          <div class="field-hint">Telegram 봇 연결과 프로세스 상태를 전체 단위로 제어합니다.</div>
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
            <div class="field-hint">현재 콘솔 접근 보호를 변경합니다.</div>
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
            <div class="field-hint">현재 브라우저 세션을 즉시 종료합니다.</div>
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
      <div class="field-hint">AI 카드를 누르면 해당 AI의 관리 화면이 열립니다.</div>
      ${renderAiList()}
    </section>
  `;
}
