import {
  getDashboardStats as buildDashboardStats,
  getViewMeta as resolveViewMeta,
  renderDetailList as buildDetailList,
  renderFrame as buildFrame,
  renderMetricCard as buildMetricCard,
  shouldUseDesktopSidebar,
} from './ui-shell.js?v=20260426-02';
import {
  renderAgentsView as buildAgentsView,
  renderAiView as buildAiView,
  renderAllView as buildAllView,
  renderChannelsView as buildChannelsView,
  renderHomeView as buildHomeView,
} from './ui-views.js?v=20260426-02';
import {
  AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS,
  getAiManagerStatusPollDelay,
} from './polling.js?v=20260426-02';
import {
  getClaudeRuntimeSourceBadge,
  getClaudeRuntimeSourceHintLines,
} from './claude-runtime-ui.js?v=20260426-02';
import { renderIcon } from './icons.js?v=20260426-02';

const app = document.getElementById('app');
const DEFAULT_CHANNEL_WORKSPACE = '/workspace';
const FALLBACK_KAKAO_RELAY_URL = 'https://k.tess.dev/';
const NOTICE_AUTO_DISMISS_MS = 4_500;
const VIEW_NAMES = new Set(['home', 'agents', 'channels', 'ai', 'tokens', 'all']);
let noticeTimer = null;
let aiManagerStatusPollTimer = null;
let aiManagerStatusPollSession = 0;

const state = {
  data: null,
  loading: true,
  busy: false,
  notice: null,
  auth: {
    enabled: false,
    authenticated: true,
    passwordEnv: 'HKCLAW_LITE_ADMIN_PASSWORD',
  },
  activeView: getInitialActiveView(),
  desktopNav: shouldUseDesktopSidebar(window.innerWidth),
  navOpen: false,
  agentSearch: '',
  agentFilter: 'all',
  agentModalOpen: false,
  connectorModalOpen: false,
  channelModalOpen: false,
  localLlmModalOpen: false,
  adminPasswordModalOpen: false,
  runtimeResetModal: null,
  connectorDraft: null,
  channelDraft: null,
  localLlmDraft: null,
  agentWizard: null,
  aiManager: null,
  aiStatuses: {},
  formErrors: {
    agentWizard: {},
    connector: {},
    channel: {},
    localLlm: {},
    adminPassword: {},
  },
};

app.addEventListener('click', handleClick);
app.addEventListener('keydown', handleKeydown);
app.addEventListener('submit', handleSubmit);
app.addEventListener('input', handleInput);
app.addEventListener('change', handleInput);
window.addEventListener('resize', handleWindowResize);
window.addEventListener('hashchange', handleHashChange);

boot().catch((error) => {
  setNotice('error', localizeErrorMessage(error.message));
  render();
});

async function boot() {
  state.auth = await requestJson('/api/auth/status');
  if (state.auth.enabled && !state.auth.authenticated) {
    state.loading = false;
    render();
    return;
  }
  await refreshState();
  void refreshAiStatuses();
}

async function refreshState() {
  state.loading = true;
  render();

  try {
    state.data = await requestJson('/api/state');
    state.notice = null;
  } catch (error) {
    if (handleAuthError(error)) {
      setNotice('info', '로그인이 필요합니다.');
    } else {
      setNotice('error', localizeErrorMessage(error.message));
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshAiStatuses() {
  try {
    const payload = await requestJson('/api/ai-statuses');
    state.aiStatuses = mergeAiStatuses(state.aiStatuses, payload.statuses || {});
    render();
  } catch (error) {
    if (handleAuthError(error)) {
      render();
    }
  }
}

function handleClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (state.busy && ['open-ai-modal', 'open-admin-password-modal', 'logout'].includes(action)) {
    return;
  }

  if (action === 'switch-view') {
    setActiveView(button.dataset.view || 'home');
    state.navOpen = false;
    render();
    return;
  }

  if (action === 'clear-agent-filters') {
    state.agentSearch = '';
    state.agentFilter = 'all';
    render();
    return;
  }

  if (action === 'toggle-nav') {
    if (state.desktopNav) {
      return;
    }
    state.navOpen = !state.navOpen;
    render();
    return;
  }

  if (action === 'close-nav') {
    state.navOpen = false;
    render();
    return;
  }

  if (action === 'open-ai-modal') {
    stopAiManagerStatusPolling();
    state.aiManager = createAiManager(button.dataset.agentType || '', {
      localLlmConnection: button.dataset.localLlmConnection || '',
    });
    clearFormErrors('localLlm');
    maybeResumeAiManagerStatusPolling(state.aiManager);
    render();
    return;
  }

  if (action === 'open-local-llm-manager') {
    stopAiManagerStatusPolling();
    state.aiManager = createAiManager('local-llm', {
      localLlmConnection: button.dataset.localLlmConnection || '',
    });
    state.localLlmDraft = null;
    clearFormErrors('localLlm');
    render();
    return;
  }

  if (action === 'open-local-llm-create') {
    stopAiManagerStatusPolling();
    state.aiManager = createAiManager('local-llm');
    state.localLlmModalOpen = false;
    state.localLlmDraft = createLocalLlmConnectionDraft();
    setFormErrors('localLlm', collectLocalLlmDraftErrors(state.localLlmDraft));
    render();
    return;
  }

  if (action === 'close-ai-modal') {
    stopAiManagerStatusPolling();
    state.aiManager = null;
    state.localLlmModalOpen = false;
    state.localLlmDraft = null;
    clearFormErrors('localLlm');
    render();
    return;
  }

  if (action === 'open-local-llm-modal') {
    stopAiManagerStatusPolling();
    if (!state.aiManager || state.aiManager.type !== 'local-llm') {
      state.aiManager = createAiManager('local-llm');
    }
    state.localLlmModalOpen = false;
    state.localLlmDraft = createLocalLlmConnectionDraft();
    clearFormErrors('localLlm');
    render();
    return;
  }

  if (action === 'edit-local-llm-connection') {
    stopAiManagerStatusPolling();
    const entry = resolveLocalLlmConnectionEntry(button.dataset.name);
    if (!entry) {
      setNotice('error', '로컬 LLM 연결을 찾지 못했습니다.');
      render();
      return;
    }
    state.aiManager = createAiManager('local-llm', {
      localLlmConnection: entry.name,
    });
    state.localLlmModalOpen = false;
    state.localLlmDraft = createLocalLlmConnectionDraft(entry);
    setFormErrors('localLlm', collectLocalLlmDraftErrors(state.localLlmDraft));
    render();
    return;
  }

  if (action === 'close-local-llm-modal') {
    state.localLlmModalOpen = false;
    state.localLlmDraft = null;
    clearFormErrors('localLlm');
    render();
    return;
  }

  if (action === 'open-admin-password-modal') {
    state.adminPasswordModalOpen = true;
    clearFormErrors('adminPassword');
    render();
    return;
  }

  if (action === 'close-admin-password-modal') {
    state.adminPasswordModalOpen = false;
    clearFormErrors('adminPassword');
    render();
    return;
  }

  if (action === 'open-reset-channel-runtime-sessions') {
    openRuntimeResetModal(button.dataset.name, button.dataset.role || '');
    return;
  }

  if (action === 'close-runtime-reset-modal') {
    state.runtimeResetModal = null;
    render();
    return;
  }

  if (action === 'confirm-reset-channel-runtime-sessions') {
    const modal = state.runtimeResetModal;
    void resetChannelRuntimeSessions(modal?.channelName, modal?.role || '');
    return;
  }

  if (action === 'logout' && !state.auth.enabled) {
    return;
  }

  if (action === 'close-notice') {
    clearNotice();
    render();
    return;
  }

  if (action === 'open-agent-modal') {
    const selectableAgentTypes = getSelectableAgentTypes();
    if (!selectableAgentTypes.length) {
      setNotice('error', '사용 가능한 AI가 없습니다.');
      render();
      return;
    }
    state.agentModalOpen = true;
    state.agentWizard = {
      step: 0,
      draft: createBlankAgent(),
      modelCatalog: null,
      authResult: null,
      testResult: null,
    };
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (action === 'edit-agent') {
    const agent = state.data?.agents?.find((entry) => entry.name === button.dataset.name);
    if (!agent) {
      setNotice('error', '에이전트를 찾지 못했습니다.');
      render();
      return;
    }
    state.agentModalOpen = true;
    state.agentWizard = {
      currentName: agent.name,
      step: 0,
      draft: createAgentDraft(agent),
      modelCatalog: null,
      authResult: null,
      testResult: null,
    };
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (action === 'reload-discord-service') {
    void reloadDiscordServiceConfig();
    return;
  }

  if (action === 'reload-telegram-service') {
    void reloadTelegramServiceConfig();
    return;
  }

  if (action === 'reload-kakao-service') {
    void reloadKakaoServiceConfig();
    return;
  }

  if (action === 'start-discord-service') {
    void startDiscordService();
    return;
  }

  if (action === 'start-telegram-service') {
    void startTelegramService();
    return;
  }

  if (action === 'start-kakao-service') {
    void startKakaoService();
    return;
  }

  if (action === 'restart-discord-service') {
    void restartDiscordService();
    return;
  }

  if (action === 'restart-telegram-service') {
    void restartTelegramService();
    return;
  }

  if (action === 'restart-kakao-service') {
    void restartKakaoService();
    return;
  }

  if (action === 'stop-discord-service') {
    void stopDiscordService();
    return;
  }

  if (action === 'stop-telegram-service') {
    void stopTelegramService();
    return;
  }

  if (action === 'stop-kakao-service') {
    void stopKakaoService();
    return;
  }

  if (action === 'reconnect-agent') {
    void reconnectAgent(button.dataset.name);
    return;
  }

  if (action === 'start-agent-discord-service') {
    void startAgentDiscordService(button.dataset.name);
    return;
  }

  if (action === 'start-agent-service') {
    void startAgentService(button.dataset.name);
    return;
  }

  if (action === 'restart-agent-discord-service') {
    void restartAgentDiscordService(button.dataset.name);
    return;
  }

  if (action === 'restart-agent-service') {
    void restartAgentService(button.dataset.name);
    return;
  }

  if (action === 'stop-agent-discord-service') {
    void stopAgentDiscordService(button.dataset.name);
    return;
  }

  if (action === 'stop-agent-service') {
    void stopAgentService(button.dataset.name);
    return;
  }

  if (action === 'ai-auth-status') {
    void runAiManagerAction('status');
    render();
    return;
  }

  if (action === 'load-model-catalog') {
    void loadModelCatalog(button.dataset.scope || '').catch((error) => {
      setNotice('error', localizeErrorMessage(error.message));
      render();
    });
    return;
  }

  if (action === 'apply-model-suggestion') {
    try {
      applyModelSelection(button.dataset.scope || '', button.dataset.model || '');
    } catch (error) {
      setNotice('error', localizeErrorMessage(error.message));
      render();
    }
    return;
  }

  if (action === 'apply-default-model') {
    try {
      applyDefaultModelSelection(button.dataset.scope || '');
    } catch (error) {
      setNotice('error', localizeErrorMessage(error.message));
      render();
    }
    return;
  }

  if (action === 'ai-auth-login') {
    const popup = openLoginPopup();
    void runAiManagerAction('login', { popup });
    return;
  }

  if (action === 'ai-auth-complete-login') {
    void runAiManagerAction('complete-login');
    return;
  }

  if (action === 'ai-auth-logout') {
    void runAiManagerAction('logout');
    return;
  }

  if (action === 'ai-auth-test') {
    void runAiManagerAction('test');
    return;
  }

  if (action === 'ai-save-credentials') {
    void saveAiCredentials();
    return;
  }

  if (action === 'close-agent-modal') {
    state.agentModalOpen = false;
    state.agentWizard = null;
    clearFormErrors('agentWizard');
    render();
    return;
  }

  if (action === 'open-connector-modal') {
    state.connectorModalOpen = true;
    state.connectorDraft = createBlankConnector();
    clearFormErrors('connector');
    render();
    return;
  }

  if (action === 'edit-connector') {
    const connector = state.data?.connectors?.find((entry) => entry.name === button.dataset.name);
    if (!connector) {
      setNotice('error', '커넥터를 찾지 못했습니다.');
      render();
      return;
    }
    state.connectorModalOpen = true;
    state.connectorDraft = createConnectorDraft(connector);
    clearFormErrors('connector');
    render();
    return;
  }

  if (action === 'close-connector-modal') {
    state.connectorModalOpen = false;
    state.connectorDraft = null;
    clearFormErrors('connector');
    render();
    return;
  }

  if (action === 'open-channel-modal') {
    state.channelModalOpen = true;
    state.channelDraft = createBlankChannel();
    clearFormErrors('channel');
    render();
    return;
  }

  if (action === 'edit-channel') {
    const channel = state.data?.channels?.find((entry) => entry.name === button.dataset.name);
    if (!channel) {
      setNotice('error', '채널을 찾지 못했습니다.');
      render();
      return;
    }
    state.channelModalOpen = true;
    state.channelDraft = createChannelDraft(channel);
    clearFormErrors('channel');
    render();
    return;
  }

  if (action === 'close-channel-modal') {
    state.channelModalOpen = false;
    state.channelDraft = null;
    clearFormErrors('channel');
    render();
    return;
  }

  if (action === 'prev-agent-step') {
    if (state.agentWizard) {
      state.agentWizard.step = Math.max(0, state.agentWizard.step - 1);
      state.notice = null;
      render();
    }
    return;
  }

  if (action === 'delete-agent') {
    void deleteEntity('agent', button.dataset.name);
    return;
  }

  if (action === 'delete-connector') {
    void deleteEntity('connector', button.dataset.name);
    return;
  }

  if (action === 'delete-channel') {
    void deleteEntity('channel', button.dataset.name);
    return;
  }

  if (action === 'delete-local-llm-connection') {
    void deleteLocalLlmConnection(button.dataset.name);
    return;
  }

  if (action === 'logout') {
    void logout();
  }
}

function handleWindowResize() {
  const nextDesktopNav = shouldUseDesktopSidebar(window.innerWidth);
  if (nextDesktopNav === state.desktopNav) {
    return;
  }
  state.desktopNav = nextDesktopNav;
  if (nextDesktopNav) {
    state.navOpen = false;
  }
  render();
}

function handleHashChange() {
  const nextView = normalizeView(window.location.hash.replace(/^#/u, ''));
  if (nextView === state.activeView) {
    return;
  }
  state.activeView = nextView;
  state.navOpen = false;
  render();
}

function getInitialActiveView() {
  return normalizeView(window.location.hash.replace(/^#/u, ''));
}

function normalizeView(view) {
  const value = String(view || '').trim();
  return VIEW_NAMES.has(value) ? value : 'home';
}

function setActiveView(view) {
  const nextView = normalizeView(view);
  state.activeView = nextView;
  const nextHash = `#${nextView}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
}

function handleKeydown(event) {
  const target = event.target.closest('[data-action][data-clickable="true"]');
  if (!target) {
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    target.click();
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
    return;
  }

  if (target.closest('[data-form="agent-filters"]') && target.name) {
    if (target.name === 'agentSearch') {
      state.agentSearch = target.value;
    }
    if (target.name === 'agentFilter') {
      state.agentFilter = target.value || 'all';
    }
    render();
    return;
  }

  const isAgentWizardField = Boolean(state.agentWizard && target.closest('[data-form="agent-wizard"]'));
  if (!isAgentWizardField || !target.name) {
    if (
      state.aiManager &&
      target.closest('[data-form="ai-manager"]') &&
      target.name
    ) {
      if (target.dataset.aiAuthKey) {
        state.aiManager.authConfig[target.dataset.aiAuthKey] =
          target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
        if (
          target.dataset.aiAuthKey === 'callbackUrl' ||
          target.dataset.aiAuthKey === 'authorizationCode'
        ) {
          render();
        }
        return;
      }
      state.aiManager.testConfig[target.name] =
        target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      if (agentTypeUsesLocalLlmConnections(state.aiManager.type) && target.name === 'localLlmConnection') {
        state.aiManager.modelCatalog = null;
        render();
      }
      if (target.name === 'modelMode') {
        if (state.aiManager.testConfig.modelMode !== 'custom') {
          state.aiManager.testConfig.model = '';
        }
        render();
      }
    }
    if (
      state.localLlmDraft &&
      target.closest('[data-form="local-llm-connection"]') &&
      target.name
    ) {
      state.localLlmDraft[target.name] =
        target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      setFormErrors('localLlm', collectLocalLlmDraftErrors());
      render();
      return;
    }
    if (
      state.connectorDraft &&
      target.closest('[data-form="connector"]') &&
      target.name
    ) {
      state.connectorDraft[target.name] =
        target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      if (target.name === 'type') {
        if (state.connectorDraft.type === 'telegram') {
          state.connectorDraft.discordToken = '';
          state.connectorDraft.kakaoRelayUrl = '';
          state.connectorDraft.kakaoRelayToken = '';
          state.connectorDraft.kakaoSessionToken = '';
        } else if (state.connectorDraft.type === 'kakao') {
          state.connectorDraft.discordToken = '';
          state.connectorDraft.telegramBotToken = '';
          state.connectorDraft.kakaoRelayUrl = state.connectorDraft.kakaoRelayUrl || getDefaultKakaoRelayUrl();
        } else {
          state.connectorDraft.telegramBotToken = '';
          state.connectorDraft.kakaoRelayUrl = '';
          state.connectorDraft.kakaoRelayToken = '';
          state.connectorDraft.kakaoSessionToken = '';
        }
        refreshVisibleFormErrors('connector', collectConnectorDraftErrors());
        render();
        return;
      }
      refreshVisibleFormErrors('connector', collectConnectorDraftErrors());
      render();
      return;
    }
    if (
      state.channelDraft &&
      target.closest('[data-form="channel"]') &&
      target.name
    ) {
      state.channelDraft[target.name] =
        target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      if (target.name === 'platform') {
        state.channelDraft.connector = getDefaultConnectorNameForPlatform(state.channelDraft.platform);
        if (state.channelDraft.platform === 'telegram') {
          state.channelDraft.discordChannelId = '';
          state.channelDraft.guildId = '';
          state.channelDraft.kakaoChannelId = '';
          state.channelDraft.kakaoUserId = '';
        } else if (state.channelDraft.platform === 'kakao') {
          state.channelDraft.discordChannelId = '';
          state.channelDraft.guildId = '';
          state.channelDraft.telegramChatId = '';
          state.channelDraft.telegramThreadId = '';
          state.channelDraft.kakaoChannelId = state.channelDraft.kakaoChannelId || '*';
        } else {
          state.channelDraft.telegramChatId = '';
          state.channelDraft.telegramThreadId = '';
          state.channelDraft.kakaoChannelId = '';
          state.channelDraft.kakaoUserId = '';
        }
        refreshVisibleFormErrors('channel', collectChannelDraftErrors());
        render();
        return;
      }
      if (target.name === 'mode' && state.channelDraft.mode !== 'tribunal') {
        state.channelDraft.reviewer = '';
        state.channelDraft.arbiter = '';
        state.channelDraft.reviewRounds = '';
      }
      if (target.name === 'mode') {
        refreshVisibleFormErrors('channel', collectChannelDraftErrors());
        render();
        return;
      }
      refreshVisibleFormErrors('channel', collectChannelDraftErrors());
      render();
      return;
    }
    if (target.closest('[data-form="admin-password"]') && target.name) {
      const form = target.closest('form');
      if (form) {
        setFormErrors('adminPassword', collectAdminPasswordErrors(new FormData(form)));
        render();
      }
      return;
    }
    return;
  }

  state.agentWizard.draft[target.name] =
    target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;

  if (target.name === 'platform') {
    if (state.agentWizard.draft.platform === 'telegram') {
      state.agentWizard.draft.discordToken = '';
      state.agentWizard.draft.kakaoRelayUrl = '';
      state.agentWizard.draft.kakaoRelayToken = '';
      state.agentWizard.draft.kakaoSessionToken = '';
    } else if (state.agentWizard.draft.platform === 'kakao') {
      state.agentWizard.draft.discordToken = '';
      state.agentWizard.draft.telegramBotToken = '';
      state.agentWizard.draft.kakaoRelayUrl =
        state.agentWizard.draft.kakaoRelayUrl || getDefaultKakaoRelayUrl();
    } else {
      state.agentWizard.draft.telegramBotToken = '';
      state.agentWizard.draft.kakaoRelayUrl = '';
      state.agentWizard.draft.kakaoRelayToken = '';
      state.agentWizard.draft.kakaoSessionToken = '';
    }
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (target.name === 'agent') {
    state.agentWizard.authResult = null;
    state.agentWizard.testResult = null;
    state.agentWizard.modelCatalog = null;
    state.agentWizard.draft.modelMode = defaultModelModeForAgent(state.agentWizard.draft.agent);
    state.agentWizard.draft.model = '';
    state.agentWizard.draft.effort = '';
    if (state.agentWizard.draft.agent === 'local-llm') {
      state.agentWizard.draft.localLlmConnection = getDefaultLocalLlmConnectionName();
      if (state.agentWizard.draft.localLlmConnection) {
        state.agentWizard.draft.baseUrl = '';
      }
    }
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (target.name === 'localLlmConnection') {
    state.agentWizard.modelCatalog = null;
    if (optionalDraftText(state.agentWizard.draft.localLlmConnection)) {
      state.agentWizard.draft.baseUrl = '';
    }
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (target.name === 'modelMode') {
    if (state.agentWizard.draft.modelMode !== 'custom') {
      state.agentWizard.draft.model = '';
    }
    state.agentWizard.draft.effort = normalizeEffortValue(
      state.agentWizard.draft.agent,
      state.agentWizard.draft.model,
      state.agentWizard.draft.effort,
    );
    setFormErrors('agentWizard', collectAgentWizardStepErrors());
    render();
    return;
  }

  if (target.name === 'model') {
    state.agentWizard.draft.effort = normalizeEffortValue(
      state.agentWizard.draft.agent,
      state.agentWizard.draft.model,
      state.agentWizard.draft.effort,
    );
  }
  setFormErrors('agentWizard', collectAgentWizardStepErrors());
  render();
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const kind = form.dataset.form;

  try {
    if (kind === 'login') {
      await login(form);
      return;
    }

    if (kind === 'agent-wizard') {
      if (!state.agentWizard) {
        return;
      }
      if (state.agentWizard.step < getAgentWizardSteps(state.agentWizard.draft).length - 1) {
        const errors = collectAgentWizardStepErrors();
        if (Object.keys(errors).length > 0) {
          throw createValidationError('agentWizard', errors);
        }
        validateAgentWizardStep();
        state.agentWizard.step += 1;
        setFormErrors('agentWizard', collectAgentWizardStepErrors());
        state.notice = null;
        render();
        return;
      }
      await saveAgentWizard();
      return;
    }

    if (kind === 'channel') {
      await saveChannel(form);
      return;
    }

    if (kind === 'connector') {
      await saveConnector(form);
      return;
    }

    if (kind === 'local-llm-connection') {
      await saveLocalLlmConnection(form);
      return;
    }

    if (kind === 'admin-password') {
      await changeAdminPassword(form);
    }
  } catch (error) {
    if (error?.name === 'ValidationError' && error?.formScope) {
      setFormErrors(error.formScope, error.formErrors || {});
    }
    setNotice('error', localizeErrorMessage(error.message));
    render();
    if (error?.name === 'ValidationError' && error?.formScope) {
      focusFirstInvalidField(error.formScope);
    }
  }
}

async function login(form) {
  const values = new FormData(form);
  const response = await mutateJson('/api/login', {
    method: 'POST',
    body: {
      password: requiredText(values, 'password'),
    },
  });

  state.auth = response;
  state.loading = false;
  setNotice('info', '로그인했습니다.');
  await refreshState();
}

async function logout() {
  try {
    const response = await mutateJson('/api/logout', {
      method: 'POST',
    });
    state.auth = response;
    state.data = null;
    setNotice('info', '로그아웃했습니다.');
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function changeAdminPassword(form) {
  const values = new FormData(form);
  const errors = collectAdminPasswordErrors(values);
  if (Object.keys(errors).length > 0) {
    throw createValidationError('adminPassword', errors);
  }
  const currentPassword = optionalText(values, 'currentPassword');
  const newPassword = requiredText(values, 'newPassword');
  const confirmPassword = requiredText(values, 'confirmPassword');

  if (newPassword !== confirmPassword) {
    throw new Error('비밀번호 확인이 일치하지 않습니다.');
  }

  const response = await mutateJson('/api/admin-password', {
    method: 'PUT',
    body: {
      currentPassword,
      newPassword,
    },
  });

  state.auth = response.auth || state.auth;
  state.adminPasswordModalOpen = false;
  clearFormErrors('adminPassword');
  setNotice('info', '관리자 비밀번호를 변경했습니다.');
  render();
}

async function saveAgentWizard() {
  const errors = collectAgentWizardStepErrors();
  if (Object.keys(errors).length > 0) {
    throw createValidationError('agentWizard', errors);
  }
  validateAgentWizardStep();
  const values = state.agentWizard?.draft || createBlankAgent();
  const currentName = optionalDraftText(state.agentWizard?.currentName);
  const platform = optionalDraftText(values.platform) || 'discord';
  const definition = {
    name: requiredDraftText(values.name, 'name'),
    agent: requiredDraftText(values.agent, 'agent'),
    platform,
    fallbackAgent: optionalDraftText(values.fallbackAgent),
    model: resolveConfiguredModel(values.agent, values),
    effort: optionalDraftText(values.effort),
    timeoutMs: optionalDraftText(values.timeoutMs),
    systemPrompt: optionalDraftText(values.systemPrompt),
    systemPromptFile: optionalDraftText(values.systemPromptFile),
    skills: parseListText(values.skillsText),
    contextFiles: parseListText(values.contextFilesText),
    sandbox:
      values.agent === 'codex'
        ? resolveCodexAccessMode(values)
        : optionalDraftText(values.sandbox),
    permissionMode:
      values.agent === 'claude-code'
        ? optionalDraftText(values.permissionMode)
        : undefined,
    dangerous:
      values.agent === 'codex'
        ? resolveCodexAccessMode(values) === 'danger-full-access'
        : undefined,
    discordToken:
      platform === 'discord'
        ? requiredDraftText(values.discordToken, 'discordToken')
        : undefined,
    telegramBotToken:
      platform === 'telegram'
        ? requiredDraftText(values.telegramBotToken, 'telegramBotToken')
        : undefined,
    kakaoRelayUrl:
      platform === 'kakao'
        ? optionalDraftText(values.kakaoRelayUrl) || getDefaultKakaoRelayUrl()
        : undefined,
    kakaoRelayToken:
      platform === 'kakao'
        ? optionalDraftText(values.kakaoRelayToken)
        : undefined,
    kakaoSessionToken:
      platform === 'kakao'
        ? optionalDraftText(values.kakaoSessionToken)
        : undefined,
    localLlmConnection: optionalDraftText(values.localLlmConnection),
    baseUrl: optionalDraftText(values.baseUrl),
    command: optionalDraftText(values.command),
  };

  const response = await mutateJson('/api/agents', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.agentModalOpen = false;
  state.agentWizard = null;
  clearFormErrors('agentWizard');
  setNotice('info', `에이전트 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function saveConnector(form) {
  const values = new FormData(form);
  const errors = collectConnectorDraftErrors(state.connectorDraft || {});
  if (Object.keys(errors).length > 0) {
    throw createValidationError('connector', errors);
  }
  const currentName = optionalText(values, 'currentName');
  const type = requiredText(values, 'type');
  const definition = {
    name: requiredText(values, 'name'),
    type,
    description: optionalText(values, 'description'),
    discordToken: type === 'discord' ? requiredText(values, 'discordToken') : undefined,
    telegramBotToken:
      type === 'telegram' ? requiredText(values, 'telegramBotToken') : undefined,
    kakaoRelayUrl:
      type === 'kakao' ? optionalText(values, 'kakaoRelayUrl') : undefined,
    kakaoRelayToken:
      type === 'kakao' ? optionalText(values, 'kakaoRelayToken') : undefined,
    kakaoSessionToken:
      type === 'kakao' ? optionalText(values, 'kakaoSessionToken') : undefined,
  };

  const response = await mutateJson('/api/connectors', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.connectorModalOpen = false;
  state.connectorDraft = null;
  clearFormErrors('connector');
  setNotice('info', `커넥터 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function saveChannel(form) {
  const values = new FormData(form);
  const errors = collectChannelDraftErrors(state.channelDraft || {});
  if (Object.keys(errors).length > 0) {
    throw createValidationError('channel', errors);
  }
  const currentName = optionalText(values, 'currentName');
  const platform = requiredText(values, 'platform');
  const definition = {
    name: requiredText(values, 'name'),
    platform,
    connector: optionalText(values, 'connector'),
    mode: requiredText(values, 'mode'),
    discordChannelId:
      platform === 'discord' ? requiredText(values, 'discordChannelId') : undefined,
    guildId: platform === 'discord' ? optionalText(values, 'guildId') : undefined,
    telegramChatId:
      platform === 'telegram' ? requiredText(values, 'telegramChatId') : undefined,
    telegramThreadId:
      platform === 'telegram' ? optionalText(values, 'telegramThreadId') : undefined,
    kakaoChannelId:
      platform === 'kakao' ? requiredText(values, 'kakaoChannelId') : undefined,
    kakaoUserId:
      platform === 'kakao' ? optionalText(values, 'kakaoUserId') : undefined,
    workspace: requiredText(values, 'workspace'),
    ownerWorkspace: optionalText(values, 'ownerWorkspace'),
    reviewerWorkspace: optionalText(values, 'reviewerWorkspace'),
    arbiterWorkspace: optionalText(values, 'arbiterWorkspace'),
    agent: requiredText(values, 'agent'),
    reviewer: optionalText(values, 'reviewer'),
    arbiter: optionalText(values, 'arbiter'),
    reviewRounds: optionalText(values, 'reviewRounds'),
    description: optionalText(values, 'description'),
  };

  const response = await mutateJson('/api/channels', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.channelModalOpen = false;
  state.channelDraft = null;
  clearFormErrors('channel');
  setNotice('info', `채널 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function saveLocalLlmConnection(form) {
  const values = new FormData(form);
  const errors = collectLocalLlmDraftErrors(state.localLlmDraft || {});
  if (Object.keys(errors).length > 0) {
    throw createValidationError('localLlm', errors);
  }
  const draft = {
    currentName: optionalText(values, 'currentName'),
    name: requiredText(values, 'name'),
    baseUrl: requiredText(values, 'baseUrl'),
    apiKey: optionalText(values, 'apiKey'),
    description: optionalText(values, 'description'),
  };
  const nextConnections = upsertLocalLlmConnectionEntries(getLocalLlmConnectionEntries(), draft);
  const response = await mutateJson('/api/local-llm-connections', {
    method: 'PUT',
    body: {
      connections: nextConnections,
    },
  });

  state.data = response.state;
  if (state.aiManager?.type === 'local-llm') {
    state.aiManager = createAiManager('local-llm', {
      localLlmConnection: draft.name,
    });
  }
  state.localLlmModalOpen = false;
  state.localLlmDraft = null;
  clearFormErrors('localLlm');
  setNotice('info', `로컬 LLM 연결 "${draft.name}"을(를) ${draft.currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function deleteEntity(kind, name) {
  if (!name) {
    return;
  }

  const confirmed = window.confirm(`${localizeKind(kind)} "${name}"을(를) 삭제할까요?`);
  if (!confirmed) {
    return;
  }

  try {
    const response = await mutateJson(`/api/${kind}s/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });

    state.data = response.state;
    setNotice(
      'info',
      `${localizeKind(kind)} "${name}"을(를) 삭제했습니다.`,
    );
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function reloadDiscordServiceConfig() {
  try {
    await mutateJson('/api/discord-service/reload', {
      method: 'POST',
    });
    setNotice('info', 'Discord 서비스가 최신 에이전트 연결 설정을 다시 읽고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function reloadTelegramServiceConfig() {
  try {
    await mutateJson('/api/telegram-service/reload', {
      method: 'POST',
    });
    setNotice('info', 'Telegram 서비스가 최신 에이전트 연결 설정을 다시 읽고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function reloadKakaoServiceConfig() {
  try {
    await mutateJson('/api/kakao-service/reload', {
      method: 'POST',
    });
    setNotice('info', 'KakaoTalk 서비스가 최신 에이전트 연결 설정을 다시 읽고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function startDiscordService() {
  try {
    await mutateJson('/api/discord-service/start', {
      method: 'POST',
    });
    setNotice('info', 'Discord 서비스를 시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function startTelegramService() {
  try {
    await mutateJson('/api/telegram-service/start', {
      method: 'POST',
    });
    setNotice('info', 'Telegram 서비스를 시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function startKakaoService() {
  try {
    await mutateJson('/api/kakao-service/start', {
      method: 'POST',
    });
    setNotice('info', 'KakaoTalk 서비스를 시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function restartDiscordService() {
  try {
    await mutateJson('/api/discord-service/restart', {
      method: 'POST',
    });
    setNotice('info', 'Discord 서비스를 재시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function restartTelegramService() {
  try {
    await mutateJson('/api/telegram-service/restart', {
      method: 'POST',
    });
    setNotice('info', 'Telegram 서비스를 재시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function restartKakaoService() {
  try {
    await mutateJson('/api/kakao-service/restart', {
      method: 'POST',
    });
    setNotice('info', 'KakaoTalk 서비스를 재시작하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function stopDiscordService() {
  try {
    await mutateJson('/api/discord-service/stop', {
      method: 'POST',
    });
    setNotice('info', 'Discord 서비스를 중지하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function stopTelegramService() {
  try {
    await mutateJson('/api/telegram-service/stop', {
      method: 'POST',
    });
    setNotice('info', 'Telegram 서비스를 중지하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function stopKakaoService() {
  try {
    await mutateJson('/api/kakao-service/stop', {
      method: 'POST',
    });
    setNotice('info', 'KakaoTalk 서비스를 중지하고 있습니다.');
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function reconnectAgent(name) {
  if (!name) {
    return;
  }
  try {
    await mutateJson(`/api/agents/${encodeURIComponent(name)}/reconnect`, {
      method: 'POST',
    });
    const platform = resolveAgentPlatform(name);
    setNotice('info', `에이전트 "${name}" ${localizeMessagingPlatform(platform)} 연결을 다시 시도합니다.`);
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function startAgentDiscordService(name) {
  return startAgentService(name);
}

async function startAgentService(name) {
  if (!name) {
    return;
  }
  try {
    await mutateJson(`/api/agents/${encodeURIComponent(name)}/start`, {
      method: 'POST',
    });
    setNotice('info', `에이전트 "${name}" ${resolveAgentPlatformLabel(name)} 워커를 시작하고 있습니다.`);
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function restartAgentDiscordService(name) {
  return restartAgentService(name);
}

async function restartAgentService(name) {
  if (!name) {
    return;
  }
  try {
    await mutateJson(`/api/agents/${encodeURIComponent(name)}/restart`, {
      method: 'POST',
    });
    setNotice('info', `에이전트 "${name}" ${resolveAgentPlatformLabel(name)} 워커를 재시작하고 있습니다.`);
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function stopAgentDiscordService(name) {
  return stopAgentService(name);
}

async function stopAgentService(name) {
  if (!name) {
    return;
  }
  try {
    await mutateJson(`/api/agents/${encodeURIComponent(name)}/stop`, {
      method: 'POST',
    });
    setNotice('info', `에이전트 "${name}" ${resolveAgentPlatformLabel(name)} 워커를 중지하고 있습니다.`);
    render();
    void refreshStateAfterServiceCommand();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function refreshStateAfterServiceCommand() {
  await new Promise((resolve) => {
    window.setTimeout(resolve, 1200);
  });
  try {
    state.data = await requestJson('/api/state');
    render();
  } catch (error) {
    if (handleAuthError(error)) {
      render();
      return;
    }
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

function resolveAgentPlatform(name) {
  const agent = state.data?.agents?.find((entry) => entry.name === name);
  return agent?.platform || 'discord';
}

function resolveAgentPlatformLabel(name) {
  return localizeMessagingPlatform(resolveAgentPlatform(name));
}

async function deleteLocalLlmConnection(name) {
  if (!name) {
    return;
  }
  const currentEntries = getLocalLlmConnectionEntries();
  if (currentEntries.length <= 1) {
    setNotice('error', '로컬 LLM 연결은 최소 1개가 필요합니다.');
    render();
    return;
  }

  const confirmed = window.confirm(`로컬 LLM 연결 "${name}"을(를) 삭제할까요?`);
  if (!confirmed) {
    return;
  }

  const nextConnections = currentEntries.filter((entry) => entry.name !== name);
  try {
    const response = await mutateJson('/api/local-llm-connections', {
      method: 'PUT',
      body: {
        connections: nextConnections,
      },
    });

    state.data = response.state;
    if (
      state.aiManager?.type === 'local-llm' &&
      optionalDraftText(state.aiManager?.localLlmConnection) === name
    ) {
      const fallbackName = nextConnections[0]?.name || '';
      state.aiManager = fallbackName
        ? createAiManager('local-llm', { localLlmConnection: fallbackName })
        : null;
    }
    setNotice('info', `로컬 LLM 연결 "${name}"을(를) 삭제했습니다.`);
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

function openRuntimeResetModal(channelName, role = '') {
  const channel = state.data?.channels?.find((entry) => entry.name === channelName);
  if (!channel) {
    setNotice('error', '채널을 찾지 못했습니다.');
    render();
    return;
  }
  state.runtimeResetModal = {
    channelName,
    role: role || '',
  };
  render();
}

async function resetChannelRuntimeSessions(name, role = '') {
  if (!name) {
    return;
  }

  try {
    const query = role ? `?role=${encodeURIComponent(role)}` : '';
    const response = await mutateJson(
      `/api/channels/${encodeURIComponent(name)}/runtime-sessions${query}`,
      {
        method: 'DELETE',
      },
    );

    state.data = response.state;
    state.runtimeResetModal = null;
    setNotice(
      'info',
      role
        ? `채널 "${name}"의 ${localizeAgentRole(role)} Claude 세션 매핑을 초기화했습니다.`
        : `채널 "${name}"의 Claude 세션 매핑을 초기화했습니다.`,
    );
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function mutateJson(url, options) {
  state.busy = true;
  render();
  try {
    return await requestJson(url, options);
  } finally {
    state.busy = false;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      const error = new Error(localizeErrorMessage(payload.error || '인증이 필요합니다.'));
      error.code = 'AUTH_REQUIRED';
      error.auth = payload.auth || null;
      throw error;
    }
    throw new Error(localizeErrorMessage(payload.error || `요청에 실패했습니다. (${response.status})`));
  }
  return payload;
}

function handleAuthError(error) {
  if (error?.code !== 'AUTH_REQUIRED') {
    return false;
  }
  state.auth = {
    ...state.auth,
    ...(error.auth || {}),
    authenticated: false,
  };
  state.data = null;
  return true;
}

function setNotice(type, text) {
  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  state.notice = {
    type,
    text,
    id: Date.now(),
  };
  if (type !== 'error') {
    noticeTimer = window.setTimeout(() => {
      clearNotice();
      render();
    }, NOTICE_AUTO_DISMISS_MS);
  }
}

function clearNotice() {
  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  state.notice = null;
}

function render() {
  const previousViewState = captureRenderState();

  if (!state.data && state.loading) {
    app.innerHTML = renderFrame(renderEmptyState('불러오는 중', true));
    restoreRenderState(previousViewState);
    return;
  }

  if (state.auth.enabled && !state.auth.authenticated) {
    app.innerHTML = renderFrame(renderLoginScreen(), 'app-shell--auth');
    restoreRenderState(previousViewState);
    return;
  }

  if (!state.data) {
    app.innerHTML = renderFrame(renderEmptyState('데이터 없음'));
    restoreRenderState(previousViewState);
    return;
  }

  app.innerHTML = renderFrame(`
    ${renderActiveView()}
    ${state.agentModalOpen ? renderAgentModal() : ''}
    ${state.connectorModalOpen ? renderConnectorModal() : ''}
    ${state.channelModalOpen ? renderChannelModal() : ''}
    ${state.aiManager ? renderAiModal() : ''}
    ${state.adminPasswordModalOpen ? renderAdminPasswordModal() : ''}
    ${state.runtimeResetModal ? renderRuntimeResetModal() : ''}
  `);
  restoreRenderState(previousViewState);
}

function restoreRenderState(viewState) {
  window.requestAnimationFrame(() => {
    window.scrollTo(viewState?.scrollX || 0, viewState?.scrollY || 0);
    restoreFocusedElement(viewState?.focus);
  });
}

function captureRenderState() {
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    focus: captureFocusedElement(),
  };
}

function captureFocusedElement() {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !app.contains(activeElement)) {
    return null;
  }

  const focusable =
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLButtonElement;
  if (!focusable) {
    return null;
  }

  const form = activeElement.closest('[data-form]');
  return {
    tagName: activeElement.tagName.toLowerCase(),
    id: activeElement.id || '',
    name: 'name' in activeElement ? activeElement.name || '' : '',
    formKind: form?.dataset.form || '',
    selectionStart:
      'selectionStart' in activeElement && typeof activeElement.selectionStart === 'number'
        ? activeElement.selectionStart
        : null,
    selectionEnd:
      'selectionEnd' in activeElement && typeof activeElement.selectionEnd === 'number'
        ? activeElement.selectionEnd
        : null,
    selectionDirection:
      'selectionDirection' in activeElement &&
      typeof activeElement.selectionDirection === 'string'
        ? activeElement.selectionDirection
        : 'none',
  };
}

function restoreFocusedElement(focusState) {
  if (!focusState) {
    return;
  }

  const target = findFocusableElement(focusState);
  if (!(target instanceof HTMLElement)) {
    return;
  }

  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }

  if (
    typeof focusState.selectionStart === 'number' &&
    typeof focusState.selectionEnd === 'number' &&
    'setSelectionRange' in target
  ) {
    try {
      target.setSelectionRange(
        focusState.selectionStart,
        focusState.selectionEnd,
        focusState.selectionDirection,
      );
    } catch {
      // Ignore selection restore failures for non-text inputs.
    }
  }
}

function findFocusableElement(focusState) {
  if (!focusState) {
    return null;
  }

  if (focusState.id) {
    const elementById = document.getElementById(focusState.id);
    if (elementById && app.contains(elementById)) {
      return elementById;
    }
  }

  let scope = app;
  if (focusState.formKind) {
    const form = app.querySelector(
      `[data-form="${escapeSelectorValue(focusState.formKind)}"]`,
    );
    if (form) {
      scope = form;
    }
  }

  if (focusState.name) {
    const selector = `${focusState.tagName}[name="${escapeSelectorValue(focusState.name)}"]`;
    const elementByName = scope.querySelector(selector);
    if (elementByName) {
      return elementByName;
    }
  }

  return null;
}

function escapeSelectorValue(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/gu, '\\$&');
}

function renderFrame(content, className = '') {
  return buildFrame({
    content,
    className,
    state,
    escapeAttr,
    escapeHtml,
    renderNotice,
    getActiveViewMeta,
    getDashboardStats,
  });
}

function renderActiveView() {
  if (state.activeView === 'home') {
    return renderHomeView();
  }
  if (state.activeView === 'agents') {
    return renderAgentsView();
  }
  if (state.activeView === 'channels') {
    return renderChannelsView();
  }
  if (state.activeView === 'ai') {
    return renderAiView();
  }
  if (state.activeView === 'tokens') {
    return renderTokenView();
  }
  return renderAllView();
}

function getViewMeta(view = state.activeView) {
  return resolveViewMeta(view);
}

function getActiveViewMeta() {
  return getViewMeta(state.activeView);
}

function getDashboardStats() {
  return buildDashboardStats({
    data: state.data,
    aiStatuses: state.aiStatuses,
    getLocalLlmConnectionEntries,
    isAiReady,
    localizeAgentTypeValue,
    localizeChannelMode,
    localizeMessagingPlatform,
  });
}

function renderDetailList(rows, emptyText = '표시할 정보가 없습니다.') {
  return buildDetailList(rows, escapeHtml, emptyText);
}

function renderHomeView() {
  return buildHomeView({
    state,
    getDashboardStats,
    escapeHtml,
    escapeAttr,
  });
}

function renderAgentsView() {
  return buildAgentsView({
    state,
    getDashboardStats,
    escapeHtml,
    escapeAttr,
    renderAgentList,
  });
}

function renderChannelsView() {
  return buildChannelsView({
    state,
    getDashboardStats,
    escapeHtml,
    renderConnectorList,
    renderChannelList,
  });
}

function renderAllView() {
  return buildAllView({
    state,
    escapeHtml,
  });
}

function renderAiView() {
  return buildAiView({
    state,
    getDashboardStats,
    escapeHtml,
    renderAiList,
    getLocalLlmConnectionEntries,
  });
}

function renderTokenView() {
  const tokenUsage = state.data?.tokenUsage || null;
  if (!tokenUsage) {
    return `
      <section class="panel section-panel">
        <div class="section-head">
          <h2>토큰 기록</h2>
        </div>
        <div class="empty-inline">토큰 기록을 불러오지 못했습니다.</div>
      </section>
    `;
  }

  const totals = tokenUsage.totals || {};
  const daily = Array.isArray(tokenUsage.daily) ? tokenUsage.daily : [];
  const activeDaily = Array.isArray(tokenUsage.activeDaily) ? tokenUsage.activeDaily : [];
  const byAgentType = Array.isArray(tokenUsage.byAgentType) ? tokenUsage.byAgentType : [];
  const byModel = Array.isArray(tokenUsage.byModel) ? tokenUsage.byModel : [];
  const recentDaily = daily.slice(-14);
  const maxDailyTokens = Math.max(...recentDaily.map((entry) => Number(entry.totalTokens || 0)), 1);
  const topAgentTypes = byAgentType.slice(0, 4);
  const topModels = byModel.slice(0, 4);

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <div class="section-title-group">
          <span class="section-title-icon">${renderIcon('tokens', 'ui-icon')}</span>
          <h2>토큰 기록</h2>
        </div>
        <span class="field-hint">최근 ${escapeHtml(String(tokenUsage.windowDays || 90))}일 · ${escapeHtml(tokenUsage.since || '')} ~ ${escapeHtml(tokenUsage.until || '')}</span>
      </div>
      <section class="metrics token-metrics">
        ${renderMetricCard('총 토큰', formatTokenCount(totals.totalTokens), 'accent', '최근 90일 누적')}
        ${renderMetricCard('입력 / 출력', `${formatTokenCount(totals.inputTokens)} / ${formatTokenCount(totals.outputTokens)}`, '', '프롬프트 / 응답')}
        ${renderMetricCard('기록 횟수', formatTokenCount(totals.recordedEvents), '', '이 앱이 관측한 호출')}
        ${renderMetricCard('활동 일수', formatTokenCount(totals.activeDays), 'calm', '기록이 있는 날짜')}
      </section>
      <section class="usage-summary-card token-chart-card">
        <div class="token-chart-head">
          <strong>최근 14일 추이</strong>
          <span class="field-hint">활동이 없는 날도 포함합니다.</span>
        </div>
        ${
          recentDaily.length
            ? `
                <div class="token-column-chart">
                  ${recentDaily
                    .map((entry) => {
                      const totalTokens = Number(entry.totalTokens || 0);
                      const height = totalTokens > 0 ? Math.max(10, Math.round((totalTokens / maxDailyTokens) * 100)) : 6;
                      const shortDate = String(entry.date || '').slice(5);
                      return `
                        <div class="token-column">
                          <div class="token-column-bar-track">
                            <div class="token-column-bar" style="height:${height}%"></div>
                          </div>
                          <strong class="token-column-value">${escapeHtml(formatTokenCount(totalTokens))}</strong>
                          <span class="token-column-date">${escapeHtml(shortDate)}</span>
                        </div>
                      `;
                    })
                    .join('')}
                </div>
              `
            : '<div class="field-hint">최근 3개월 기록이 없습니다.</div>'
        }
      </section>
      <div class="grid-two">
        <section class="usage-summary-card">
          <strong>AI별 합계</strong>
          ${
            topAgentTypes.length
              ? `
                  <div class="token-breakdown-list">
                    ${topAgentTypes
                      .map(
                        (entry) => `
                          <div class="token-breakdown-row">
                            <span>${escapeHtml(localizeAgentTypeValue(entry.agentType))}</span>
                            <strong>${escapeHtml(formatTokenCount(entry.totalTokens))}</strong>
                          </div>
                        `,
                      )
                      .join('')}
                  </div>
                `
              : '<div class="field-hint">최근 3개월 기록이 없습니다.</div>'
          }
        </section>
        <section class="usage-summary-card">
          <strong>상위 모델</strong>
          ${
            topModels.length
              ? `
                  <div class="token-breakdown-list">
                    ${topModels
                      .map(
                        (entry) => `
                          <div class="token-breakdown-row">
                            <span title="${escapeAttr(entry.model || '')}">${escapeHtml(formatUsageBreakdownLabel(entry.model, 'model'))}</span>
                            <strong>${escapeHtml(formatTokenCount(entry.totalTokens))}</strong>
                          </div>
                        `,
                      )
                      .join('')}
                  </div>
                `
              : '<div class="field-hint">최근 3개월 기록이 없습니다.</div>'
          }
        </section>
      </div>
    </section>
  `;
}

function renderCardTitle(iconName, title, tone = '') {
  return `
    <div class="card-title-row">
      <span class="card-title-icon ${tone}">${renderIcon(iconName, 'ui-icon')}</span>
      <strong class="card-title">${escapeHtml(title)}</strong>
    </div>
  `;
}

function renderButtonLabel(iconName, text) {
  return `${renderIcon(iconName, 'ui-icon')}${escapeHtml(text)}`;
}

function renderMetricCard(label, value, tone = '', meta = '') {
  return buildMetricCard(label, value, escapeHtml, tone, meta);
}

function getAiActionLabels(agentType) {
  return agentType === 'claude-code' || agentType === 'gemini-cli'
    ? {
        login: '브라우저 로그인',
        complete: '인증 반영',
        status: '연결 확인',
        test: '응답 테스트',
      }
    : {
        login: '로그인',
        complete: '',
        status: '상태 확인',
        test: '테스트 호출',
      };
}

function renderMetaText(text) {
  const value = String(text || '').trim();
  return `<span class="card-meta"${value ? ` title="${escapeAttr(value)}"` : ''}>${escapeHtml(value)}</span>`;
}

function resolveAgentTypeIcon(agentType) {
  if (agentType === 'claude-code' || agentType === 'gemini-cli' || agentType === 'local-llm') {
    return 'ai';
  }
  if (agentType === 'command') {
    return 'sparkles';
  }
  return 'agents';
}

function resolvePlatformIcon(platform) {
  if (platform === 'telegram') {
    return 'telegram';
  }
  if (platform === 'kakao') {
    return 'kakao';
  }
  return 'discord';
}

function renderCardActionDrawer({
  title = '관리',
  body = '',
  actions = [],
}) {
  const items = actions.filter(Boolean);
  if (!items.length && !body) {
    return '';
  }
  return `
    <details class="card-actions-drawer">
      <summary class="card-actions-summary">${renderIcon('settings', 'ui-icon')}${escapeHtml(title)}</summary>
      <div class="card-actions-panel">
        ${body}
        ${
          items.length
            ? `
                <div class="card-actions-panel-actions">
                  ${items.join('')}
                </div>
              `
            : ''
        }
      </div>
    </details>
  `;
}

function renderAgentList(agents, discordService = {}, telegramService = {}, kakaoService = {}) {
  if (!agents.length) {
    return '<div class="empty-inline">에이전트가 없습니다.</div>';
  }

  const serviceAgents = discordService?.agents || discordService?.bots || {};
  const telegramAgents = telegramService?.agents || telegramService?.bots || {};
  const kakaoAgents = kakaoService?.agents || kakaoService?.accounts || {};
  const agentEntries = agents.map((agent) => ({
    agent,
    context: buildAgentDisplayContext(agent, serviceAgents, telegramAgents, kakaoAgents),
  }));
  const filteredEntries = agentEntries.filter(({ agent, context }) => matchesAgentListControls(agent, context));
  const hasActiveControls = Boolean((state.agentSearch || '').trim()) || (state.agentFilter || 'all') !== 'all';

  return `
    <div class="agent-result-row">
      <span>${escapeHtml(`표시 ${filteredEntries.length}/${agents.length}`)}</span>
      ${hasActiveControls ? `<button type="button" class="btn-secondary btn-inline" data-action="clear-agent-filters">${renderButtonLabel('refresh', '필터 초기화')}</button>` : ''}
    </div>
    ${
      filteredEntries.length
        ? `
            <div class="card-list agent-list">
              ${filteredEntries.map(({ agent, context }) => renderAgentCard(agent, context)).join('')}
            </div>
          `
        : `
            <div class="empty-inline agent-empty">
              <strong>조건에 맞는 에이전트가 없습니다.</strong>
              <span>검색어를 줄이거나 상태 필터를 전체로 바꿔보세요.</span>
              <button type="button" class="btn-secondary" data-action="clear-agent-filters">${renderButtonLabel('refresh', '필터 초기화')}</button>
            </div>
          `
    }
  `;
}

function renderAgentCard(agent, context) {
  const {
    platform,
    isDiscordPlatform,
    platformLabel,
    runtimeAgent,
    telegramRuntime,
    kakaoRuntime,
    agentService,
    agentServiceRunning,
    agentServiceStarting,
    agentServiceStale,
    tokenConfigured,
    connectionSummary,
    connected,
    channelCount,
    credentialLabel,
    connectorOnly,
  } = context;
  const primaryAction = connectorOnly
    ? ''
    : !tokenConfigured
    ? `<button type="button" class="btn-secondary" data-action="start-agent-service" data-name="${escapeAttr(agent.name)}" disabled>${renderButtonLabel('play', '실행')}</button>`
    : agentServiceRunning || agentServiceStale
      ? `<button type="button" class="btn-secondary" data-action="restart-agent-service" data-name="${escapeAttr(agent.name)}" ${state.busy || (!agentServiceRunning && !agentServiceStale) ? 'disabled' : ''}>${renderButtonLabel('refresh', '재시작')}</button>`
      : `<button type="button" class="btn-secondary" data-action="start-agent-service" data-name="${escapeAttr(agent.name)}" ${state.busy || !tokenConfigured || agentServiceRunning || agentServiceStarting ? 'disabled' : ''}>${renderButtonLabel('play', '실행')}</button>`;
  const stopAction =
    agentServiceRunning || agentServiceStale || agentServiceStarting
      ? `<button type="button" class="btn-secondary" data-action="stop-agent-service" data-name="${escapeAttr(agent.name)}" ${state.busy || (!agentServiceRunning && !agentServiceStale && !agentServiceStarting) ? 'disabled' : ''}>${renderButtonLabel('stop', '중지')}</button>`
      : '';
  return `
    <article class="card agent-card">
      <div class="card-main agent-card-main">
        <div class="agent-card-heading">
          ${renderCardTitle(resolveAgentTypeIcon(agent.agent), agent.name, 'accent')}
          ${renderMetaText(`${localizeAgentTypeValue(agent.agent)}${agent.model ? ` · ${agent.model}` : ''}`)}
        </div>
        <div class="agent-status-grid">
          <span class="mini-chip agent-chip agent-chip--platform">${renderIcon(resolvePlatformIcon(platform), 'ui-icon')} ${escapeHtml(platformLabel)}</span>
          <span class="mini-chip agent-chip ${tokenConfigured ? 'mini-chip--ok' : 'mini-chip--danger'}">${renderIcon('shield', 'ui-icon')} ${escapeHtml(credentialLabel)}</span>
          <span class="mini-chip agent-chip ${agentServiceStale ? 'mini-chip--danger' : connected ? 'mini-chip--ok' : ''}">${renderIcon('server', 'ui-icon')}${escapeHtml(connectionSummary)}</span>
          <span class="mini-chip agent-chip">${renderIcon('channels', 'ui-icon')}${escapeHtml(`채널 ${channelCount}개`)}</span>
        </div>
      </div>
      <div class="inline-actions agent-card-actions">
        ${primaryAction}
        ${stopAction}
        <button type="button" class="btn-secondary" data-action="edit-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('edit', '수정')}</button>
        ${renderCardActionDrawer({
          title: '더보기',
          body: renderAgentDetailPanel(agent, context),
          actions: [
            !connectorOnly && (isDiscordPlatform || platform === 'kakao')
              ? `<button type="button" class="btn-secondary" data-action="reconnect-agent" data-name="${escapeAttr(agent.name)}" ${state.busy || !agentService?.running ? 'disabled' : ''}>${renderButtonLabel('refresh', '재연결')}</button>`
              : '',
            `<button type="button" class="btn-danger" data-action="delete-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('trash', '삭제')}</button>`,
          ],
        })}
      </div>
    </article>
  `;
}

function buildAgentDisplayContext(agent, serviceAgents = {}, telegramAgents = {}, kakaoAgents = {}) {
  const mappedChannels = Array.isArray(agent.mappedChannels) ? agent.mappedChannels : [];
  const channelPlatforms = unique(
    mappedChannels
      .map((channel) => channel.platform || 'discord')
      .filter(Boolean),
  );
  const connectorPlatforms = unique(
    mappedChannels
      .filter((channel) => channel.connector)
      .map((channel) => channel.platform || 'discord')
      .filter(Boolean),
  );
  const legacyCredentialPlatforms = unique(
    mappedChannels
      .filter((channel) => !channel.connector)
      .map((channel) => channel.platform || 'discord')
      .filter(Boolean),
  );
  const connectorOnly = mappedChannels.length > 0 && connectorPlatforms.length > 0 && legacyCredentialPlatforms.length === 0;
  const platform = legacyCredentialPlatforms[0] || channelPlatforms[0] || agent.platform || 'discord';
  const isDiscordPlatform = platform === 'discord';
  const platformLabels = (channelPlatforms.length ? channelPlatforms : [platform]).map((value) =>
    localizeMessagingPlatform(value),
  );
  const platformLabel = platformLabels.join(' / ');
  const runtimeAgent = serviceAgents[agent.name] || {};
  const telegramRuntime = telegramAgents[agent.name] || {};
  const kakaoRuntime = kakaoAgents[agent.name] || {};
  const agentService = isDiscordPlatform
    ? (agent.discordService || null)
    : platform === 'kakao'
      ? (agent.kakaoService || null)
      : (agent.telegramService || null);
  const agentServiceLabel = agentService?.label || '중지';
  const agentServiceRunning = Boolean(agentService?.running);
  const agentServiceStarting = Boolean(agentService?.starting);
  const agentServiceStale = Boolean(agentService?.stale);
  const tokenConfiguredByPlatform = {
    discord: Boolean(agent.discordTokenConfigured),
    telegram: Boolean(agent.telegramBotTokenConfigured),
    kakao: Boolean(agent.kakaoRelayConfigured),
  };
  const tokenConfigured = connectorOnly
    ? true
    : legacyCredentialPlatforms.length > 0
      ? legacyCredentialPlatforms.every((value) => tokenConfiguredByPlatform[value])
      : Boolean(tokenConfiguredByPlatform[platform]);
  const credentialLabel = connectorOnly
    ? '커넥터 사용'
    : tokenConfigured
      ? '토큰 설정됨'
      : '토큰 미설정';
  const connected = connectorOnly
    ? false
    : isDiscordPlatform
      ? Boolean(runtimeAgent.connected)
      : platform === 'kakao'
        ? Boolean(kakaoRuntime.connected)
        : Boolean(telegramRuntime.connected);
  const connectionSummary = connectorOnly
    ? '채널 워커 사용'
    : isDiscordPlatform
      ? runtimeAgent.connected
      ? `연결됨${runtimeAgent.tag ? ` · ${runtimeAgent.tag}` : ''}`
      : agentServiceRunning
        ? '연결 안 됨'
        : agentServiceStarting
          ? '워커 시작 중'
          : agentServiceStale
            ? '워커 끊김'
            : '워커 중지'
    : platform === 'kakao'
      ? kakaoRuntime.connected
        ? `연결됨${kakaoRuntime.pairedUserId ? ` · ${kakaoRuntime.pairedUserId}` : ''}`
        : kakaoRuntime.pairingCode
          ? `/pair ${kakaoRuntime.pairingCode}`
          : agentServiceRunning
            ? '페어링 대기'
            : agentServiceStarting
              ? '워커 시작 중'
              : agentServiceStale
                ? '워커 끊김'
                : '워커 중지'
      : telegramRuntime.connected
        ? `연결됨${telegramRuntime.username ? ` · @${telegramRuntime.username}` : ''}`
        : agentServiceRunning
          ? '연결 안 됨'
          : agentServiceStarting
            ? '워커 시작 중'
            : agentServiceStale
              ? '워커 끊김'
              : '워커 중지';

  return {
    platform,
    platforms: channelPlatforms.length ? channelPlatforms : [platform],
    isDiscordPlatform,
    platformLabel,
    runtimeAgent,
    telegramRuntime,
    kakaoRuntime,
    agentService,
    agentServiceLabel,
    agentServiceRunning,
    agentServiceStarting,
    agentServiceStale,
    tokenConfigured,
    credentialLabel,
    connectorOnly,
    connected,
    connectionSummary,
    channelCount: (agent.mappedChannelNames || []).length,
    needsAttention: !tokenConfigured || (!connectorOnly && agentServiceStale) || Boolean(agentService?.lastError),
  };
}

function matchesAgentListControls(agent, context) {
  return matchesAgentFilter(context, state.agentFilter || 'all') && matchesAgentSearch(agent, context, state.agentSearch || '');
}

function matchesAgentFilter(context, filter) {
  switch (filter) {
    case 'running':
      return context.agentServiceRunning || context.agentServiceStarting;
    case 'connected':
      return context.connected;
    case 'stopped':
      return !context.agentServiceRunning && !context.agentServiceStarting && !context.agentServiceStale;
    case 'issues':
      return context.needsAttention;
    case 'missing-token':
      return !context.tokenConfigured;
    case 'discord':
      return (context.platforms || [context.platform]).includes('discord');
    case 'telegram':
      return (context.platforms || [context.platform]).includes('telegram');
    case 'kakao':
      return (context.platforms || [context.platform]).includes('kakao');
    default:
      return true;
  }
}

function matchesAgentSearch(agent, context, rawSearch) {
  const search = normalizeSearchText(rawSearch);
  if (!search) {
    return true;
  }
  const values = [
    agent.name,
    agent.agent,
    localizeAgentTypeValue(agent.agent),
    agent.model,
    agent.sandbox,
    context.platformLabel,
    context.connectionSummary,
    context.agentServiceLabel,
    agent.runtime?.source,
    agent.runtime?.detail,
    ...(agent.mappedChannelNames || []),
    ...(agent.workspaces || []),
  ];
  return normalizeSearchText(values.filter(Boolean).join(' ')).includes(search);
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLocaleLowerCase('ko-KR');
}

function unique(values = []) {
  return Array.from(new Set(values));
}

function renderAgentDetailPanel(agent, context) {
  const channels = (agent.mappedChannels || []).map((channel) => {
    const role = channel.role ? ` · ${localizeAgentRole(channel.role)}` : '';
    return `${channel.name}${role}`;
  });
  const workspaces = agent.workspaces || [];
  const runtimeStatus = agent.runtime
    ? `${agent.runtime.ready ? '준비됨' : '확인 필요'} · ${agent.runtime.source || 'unknown'}`
    : '미확인';
  const rows = context.connectorOnly
    ? [
        { label: '채널 워커', value: '채널 탭에서 관리' },
        { label: '런타임', value: runtimeStatus, title: agent.runtime?.detail || '' },
        { label: 'Sandbox', value: agent.sandbox || '기본값' },
      ]
    : [
        { label: '서비스', value: context.agentServiceLabel },
        { label: 'Heartbeat', value: context.agentService?.heartbeatAt ? formatRelativeDateTime(context.agentService.heartbeatAt) : '없음' },
        { label: '런타임', value: runtimeStatus, title: agent.runtime?.detail || '' },
        { label: 'Sandbox', value: agent.sandbox || '기본값' },
      ];
  if (context.agentService?.lastError) {
    rows.push({ label: '최근 오류', value: context.agentService.lastError });
  }
  if (!context.connectorOnly && context.platform === 'kakao') {
    rows.push(
      { label: '연결 릴레이', value: context.kakaoRuntime?.relayUrl || agent.kakaoRelayUrl || getDefaultKakaoRelayUrl() },
      context.kakaoRuntime?.pairingCode
        ? { label: '페어링', value: `/pair ${context.kakaoRuntime.pairingCode}` }
        : null,
      context.kakaoRuntime?.pairedUserId
        ? { label: '연결 사용자', value: context.kakaoRuntime.pairedUserId }
        : null,
    );
  }

  return `
    <div class="agent-detail-panel">
      <div class="agent-detail-grid">
        ${rows
          .filter(Boolean)
          .map(
            (row) => `
              <div class="agent-detail-item">
                <span>${escapeHtml(row.label)}</span>
                <strong title="${escapeAttr(row.title || row.value)}">${escapeHtml(row.value)}</strong>
              </div>
            `,
          )
          .join('')}
      </div>
      <div class="agent-detail-block">
        <span>채널</span>
        <p>${escapeHtml(channels.length ? channels.join(', ') : '연결된 채널 없음')}</p>
      </div>
      <div class="agent-detail-block">
        <span>워크스페이스</span>
        <p>${escapeHtml(workspaces.length ? workspaces.join(', ') : '미지정')}</p>
      </div>
    </div>
  `;
}

function localizeAgentRole(role) {
  if (role === 'owner') {
    return 'owner';
  }
  if (role === 'reviewer') {
    return 'reviewer';
  }
  if (role === 'arbiter') {
    return 'arbiter';
  }
  return role || '';
}

function renderConnectorList(connectors = [], channels = []) {
  if (!connectors.length) {
    return '<div class="empty-inline">아직 커넥터가 없습니다. 기존 에이전트 연결은 호환 모드로 계속 사용할 수 있습니다.</div>';
  }
  return `
    <div class="card-list card-list--compact">
      ${connectors
        .map((connector) => {
          const mappedChannels = channels.filter((channel) => channel.connector === connector.name);
          return `
            <article class="card card--stack">
              <div class="card-main">
                ${renderCardTitle('link', connector.name, 'calm')}
                ${renderMetaText(`${localizeMessagingPlatform(connector.type)} · ${mappedChannels.length}개 채널`)}
                <div class="card-tags">
                  <span class="mini-chip">${renderIcon('link', 'ui-icon')}${escapeHtml(localizeMessagingPlatform(connector.type))}</span>
                  ${
                    connector.description
                      ? `<span class="mini-chip">${escapeHtml(connector.description)}</span>`
                      : ''
                  }
                  ${
                    connector.type === 'kakao'
                      ? `<span class="mini-chip">${escapeHtml(connector.kakaoSessionToken || connector.kakaoRelayToken ? '토큰 설정됨' : '페어링 모드')}</span>`
                      : ''
                  }
                </div>
                ${
                  mappedChannels.length
                    ? `<p class="field-hint">사용 채널: ${escapeHtml(mappedChannels.map((channel) => channel.name).join(', '))}</p>`
                    : '<p class="field-hint">아직 연결된 채널이 없습니다.</p>'
                }
              </div>
              <div class="inline-actions">
                <button type="button" class="btn-secondary" data-action="edit-connector" data-name="${escapeAttr(connector.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('edit', '수정')}</button>
                <button type="button" class="btn-danger" data-action="delete-connector" data-name="${escapeAttr(connector.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('trash', '삭제')}</button>
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderChannelList(channels, agents) {
  if (!channels.length) {
    return '<div class="empty-inline">채널이 없습니다.</div>';
  }

  const agentMap = new Map(agents.map((agent) => [agent.name, agent]));
  return `
    <div class="card-list">
      ${channels
        .map((channel) => {
          const owner = agentMap.get(channel.agent);
          const mode = channel.mode || (channel.reviewer || channel.arbiter ? 'tribunal' : 'single');
          const runtime = channel.runtime || {};
          const lastRun = runtime.lastRun || null;
          const runtimeSessions = sortRuntimeSessions(runtime.sessions || []);
          const claudeSessions = runtimeSessions.filter(
            (session) => session.runtimeBackend === 'claude-cli' && session.runtimeSessionId,
          );
          return `
            <article class="card card--stack">
              <div class="card-main">
                ${renderCardTitle('channels', channel.name, 'calm')}
                ${renderMetaText(`${localizeChannelMode(mode)} · ${localizeMessagingPlatform(channel.platform || 'discord')} · ${describeChannelConnector(channel)} · ${describeChannelTarget(channel)} · ${describeChannelWorkspace(channel)}`)}
                <div class="role-list">
                  <span class="role-item">${renderIcon('agents', 'ui-icon')}<strong>owner</strong><span>${escapeHtml(channel.agent)}</span></span>
                  ${
                    mode === 'tribunal' && channel.reviewer
                      ? `<span class="role-item">${renderIcon('agents', 'ui-icon')}<strong>reviewer</strong><span>${escapeHtml(channel.reviewer)}</span></span>`
                      : ''
                  }
                  ${
                    mode === 'tribunal' && channel.arbiter
                      ? `<span class="role-item">${renderIcon('agents', 'ui-icon')}<strong>arbiter</strong><span>${escapeHtml(channel.arbiter)}</span></span>`
                      : ''
                  }
                  ${
                    owner
                      ? `<span class="mini-chip">${renderIcon(resolveAgentTypeIcon(owner.agent), 'ui-icon')}${escapeHtml(localizeAgentTypeValue(owner.agent))}</span>`
                      : ''
                  }
                </div>
                ${
                  lastRun || runtime.pendingOutboxCount
                    ? `
                      <div class="card-tags">
                        ${
                          lastRun
                            ? `<span class="mini-chip ${escapeAttr(resolveRuntimeChipClass(lastRun.status))}">${renderIcon('server', 'ui-icon')}${escapeHtml(localizeRuntimeStatus(lastRun.status))}</span>`
                            : ''
                        }
                        ${
                          lastRun?.reviewerVerdict
                            ? `<span class="mini-chip">${renderIcon('shield', 'ui-icon')}${escapeHtml(localizeReviewerVerdict(lastRun.reviewerVerdict))}</span>`
                            : ''
                        }
                        ${
                          runtime.pendingOutboxCount
                            ? `<span class="mini-chip">${renderIcon('notice', 'ui-icon')}${escapeHtml(`발송 대기 ${runtime.pendingOutboxCount}`)}</span>`
                            : ''
                        }
                      </div>
                    `
                    : ''
                }
                ${renderChannelRuntimeSessions(channel, runtimeSessions)}
              </div>
              <div class="inline-actions">
                <button type="button" class="btn-secondary" data-action="edit-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('edit', '수정')}</button>
                ${
                  claudeSessions.length > 0
                    ? `<button type="button" class="btn-secondary" data-action="open-reset-channel-runtime-sessions" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('refresh', 'Claude 전체 초기화')}</button>`
                    : ''
                }
                <button type="button" class="btn-danger" data-action="delete-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('trash', '삭제')}</button>
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function sortRuntimeSessions(sessions) {
  const roleRank = new Map([
    ['owner', 0],
    ['reviewer', 1],
    ['arbiter', 2],
  ]);
  return [...sessions].sort((left, right) => {
    const leftRank = roleRank.get(left?.role) ?? 99;
    const rightRank = roleRank.get(right?.role) ?? 99;
    return leftRank - rightRank || String(left?.role || '').localeCompare(String(right?.role || ''));
  });
}

function renderChannelRuntimeSessions(channel, sessions) {
  if (!sessions.length) {
    return '';
  }
  const claudeCount = sessions.filter(
    (session) => session.runtimeBackend === 'claude-cli' && session.runtimeSessionId,
  ).length;
  return `
    <div class="runtime-session-panel" aria-label="채널 런타임 세션">
      <div class="runtime-session-head">
        <span>${renderIcon('ai', 'ui-icon')}${escapeHtml(`채널+역할 세션 ${sessions.length}`)}</span>
        <strong>${escapeHtml(claudeCount ? `Claude ${claudeCount}` : '재사용 세션 없음')}</strong>
      </div>
      <div class="runtime-session-list">
        ${sessions
          .map((session) => {
            const canReset = session.runtimeBackend === 'claude-cli' && session.runtimeSessionId;
            return `
              <div class="runtime-session-row">
                <div class="runtime-session-main">
                  <strong>${escapeHtml(`${channel.name}:${session.role || 'unknown'}`)}</strong>
                  <span>${escapeHtml([
                    session.agentName || 'agent 미지정',
                    localizeRuntimeBackend(session.runtimeBackend),
                    localizeSessionPolicy(session.sessionPolicy),
                    `run ${session.runCount || 0}`,
                  ].filter(Boolean).join(' · '))}</span>
                  ${
                    session.runtimeSessionId
                      ? `<code>${escapeHtml(formatRuntimeSessionId(session.runtimeSessionId))}</code>`
                      : ''
                  }
                </div>
                ${
                  canReset
                    ? `<button type="button" class="btn-secondary btn-compact" data-action="open-reset-channel-runtime-sessions" data-name="${escapeAttr(channel.name)}" data-role="${escapeAttr(session.role || '')}" ${state.busy ? 'disabled' : ''}>${escapeHtml(`${localizeAgentRole(session.role)} 초기화`)}</button>`
                    : `<span class="mini-chip">${escapeHtml(localizeSessionPolicy(session.sessionPolicy))}</span>`
                }
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAiList() {
  const baseEntries = (state.data.choices.agentTypes || []).filter(
    (entry) => !['command', 'local-llm'].includes(entry.value),
  );
  const localLlmConnections = getLocalLlmConnectionEntries();
  if (!baseEntries.length && !localLlmConnections.length) {
    return '<div class="empty-inline">AI가 없습니다.</div>';
  }

  return `
    <div class="card-list">
      ${baseEntries
        .map((entry) => {
          const status = state.aiStatuses[entry.value] || {};
          const ready = isAiReady(entry.value, status);
          const runtimeChip = buildAiRuntimeSourceMiniChip(
            entry.value,
            status.authResult?.details || {},
          );
          return `
            <article
              class="card card--clickable"
              data-action="open-ai-modal"
              data-agent-type="${escapeAttr(entry.value)}"
              data-clickable="true"
              role="button"
              tabindex="${state.busy ? '-1' : '0'}"
              aria-disabled="${state.busy ? 'true' : 'false'}"
            >
              <div class="card-main">
                ${renderCardTitle(resolveAgentTypeIcon(entry.value), localizeOptionLabel(entry), 'violet')}
                ${renderMetaText(localizeAiMeta(entry.value))}
                ${
                  ready || runtimeChip
                    ? `<div class="card-tags">${ready ? '<span class="mini-chip mini-chip--ok">사용 가능</span>' : ''}${runtimeChip}</div>`
                    : ''
                }
              </div>
            </article>
          `;
        })
        .join('')}
      ${localLlmConnections
        .map((connection) => {
          const status = state.aiStatuses['local-llm'] || {};
          const ready = isAiReady('local-llm', status);
          return `
            <article
              class="card card--clickable"
              data-action="open-local-llm-manager"
              data-agent-type="local-llm"
              data-local-llm-connection="${escapeAttr(connection.name)}"
              data-clickable="true"
              role="button"
              tabindex="${state.busy ? '-1' : '0'}"
              aria-disabled="${state.busy ? 'true' : 'false'}"
            >
              <div class="card-main">
                ${renderCardTitle('ai', connection.name, 'violet')}
                ${renderMetaText(`로컬 LLM · ${connection.baseUrl}`)}
                <div class="card-tags">
                  <span class="mini-chip ${connection.apiKey ? 'mini-chip--ok' : ''}">${renderIcon('shield', 'ui-icon')}${escapeHtml(connection.apiKey ? 'API 키' : 'API 키 없음')}</span>
                </div>
                ${
                  ready
                    ? `<div class="card-tags"><span class="mini-chip mini-chip--ok">사용 가능</span></div>`
                    : ''
                }
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderAgentModal() {
  const steps = getAgentWizardSteps(state.agentWizard?.draft || createBlankAgent());
  const currentStep = state.agentWizard?.step || 0;
  const step = steps[currentStep];
  const isEditing = Boolean(optionalDraftText(state.agentWizard?.currentName));
  const hasStepErrors = Object.keys(collectAgentWizardStepErrors()).length > 0;
  const stepErrorText = getFirstFormError('agentWizard');
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="에이전트 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-agent-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon('agents', 'ui-icon')}</span>
            <h2>에이전트 ${isEditing ? '수정' : '추가'}</h2>
          </div>
          <button type="button" class="btn-secondary" data-action="close-agent-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
        </div>
        <form data-form="agent-wizard" class="form wizard-form">
          ${renderFormErrorSummary('agentWizard')}
          <div class="wizard-head">
            <span class="wizard-count">${escapeHtml(`${currentStep + 1}/${steps.length}`)}</span>
            <h3 class="wizard-question">${escapeHtml(step.question)}</h3>
          </div>
          <div class="wizard-body">
            ${step.body}
          </div>
          <div class="actions wizard-actions">
            ${
              currentStep > 0
                ? `<button type="button" class="btn-secondary" data-action="prev-agent-step" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('refresh', '이전')}</button>`
                : ''
            }
            <button type="submit" class="btn-primary" ${state.busy || hasStepErrors ? 'disabled' : ''}${hasStepErrors && stepErrorText ? ` title="${escapeAttr(stepErrorText)}"` : ''}>
              ${currentStep === steps.length - 1 ? renderButtonLabel(isEditing ? 'edit' : 'plus', isEditing ? '저장' : '추가') : renderButtonLabel('play', '다음')}
            </button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderAiModal() {
  const entry = getAgentTypeChoice(state.aiManager?.type);
  if (!entry) {
    return '';
  }

  const selectedLocalLlmConnection = entry.value === 'local-llm'
    ? resolveLocalLlmConnectionEntry(
        optionalDraftText(state.aiManager?.localLlmConnection) ||
          optionalDraftText(state.aiManager?.testConfig?.localLlmConnection),
      )
    : null;
  const modalTitle = entry.value === 'local-llm'
    ? selectedLocalLlmConnection?.name || '로컬 LLM'
    : localizeOptionLabel(entry);

  const authSupported = isAiAuthSupported(entry.value);
  const statusSupported = isAiStatusSupported(entry.value);
  const credentialEditingSupported = supportsAiCredentialEditing(entry.value);
  const testSupported = isAiTestSupported(entry.value);
  const authResult = state.aiManager?.authResult;
  const testResult = state.aiManager?.testResult;
  const usageSummary =
    state.aiManager?.usageSummary ||
    state.aiStatuses?.[entry.value]?.usageSummary ||
    null;
  const ready = isAiReady(entry.value, {
    authResult,
    testResult,
  });
  const labels = getAiActionLabels(entry.value);

  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="AI 관리">
      <div class="modal-backdrop" data-action="close-ai-modal"></div>
      <div class="panel modal-card modal-card--small">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon(entry.value === 'local-llm' ? 'ai' : resolveAgentTypeIcon(entry.value), 'ui-icon')}</span>
            <h2>${escapeHtml(modalTitle)} 관리</h2>
          </div>
          <div class="inline-actions">
            ${
              entry.value === 'local-llm'
                ? `<button type="button" class="btn-secondary" data-action="open-local-llm-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('plus', '신규 LLM 추가')}</button>`
                : ''
            }
            <button type="button" class="btn-secondary" data-action="close-ai-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
          </div>
        </div>
        <div data-form="ai-manager" class="form">
          <div class="ai-modal-body">${renderAiStatusChips(entry.value, authResult, testResult, ready)}</div>
          ${renderAiUsageSummary(entry.value, usageSummary)}
          ${renderAiAuthFields(entry.value)}
          ${renderAiCredentialFields(entry.value)}
          ${renderAiTestFields(entry.value)}
          ${
            authSupported
              ? `<div class="wizard-auth-action-stack">
                  <div class="wizard-auth-actions">
                    <button type="button" class="btn-secondary" data-action="ai-auth-login" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('login', labels.login)}</button>
                    ${
                      entry.value === 'claude-code' || entry.value === 'gemini-cli'
                        ? `<button
                            type="button"
                            class="btn-secondary"
                            data-action="ai-auth-complete-login"
                            ${isAiCompleteLoginDisabled(entry.value, authResult) || state.busy ? 'disabled' : ''}
                          >
                            ${renderButtonLabel('shield', labels.complete)}
                          </button>`
                        : ''
                    }
                    <button type="button" class="btn-secondary" data-action="ai-auth-status" ${state.busy ? 'disabled' : ''}>
                      ${renderButtonLabel('server', labels.status)}
                    </button>
                    <button
                      type="button"
                      class="btn-primary"
                      data-action="ai-auth-test"
                      ${state.busy || !testSupported || !isAiTestReady(entry.value, ready) ? 'disabled' : ''}
                    >
                      ${renderButtonLabel('play', labels.test)}
                    </button>
                  </div>
                  <div class="wizard-auth-actions">
                    <button type="button" class="btn-secondary" data-action="ai-auth-logout" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '로그아웃')}</button>
                    ${
                      credentialEditingSupported && entry.value !== 'local-llm'
                        ? `<button
                            type="button"
                            class="btn-secondary"
                            data-action="ai-save-credentials"
                            ${state.busy ? 'disabled' : ''}
                          >
                            ${renderButtonLabel('shield', '자격정보 저장')}
                          </button>`
                        : ''
                    }
                    ${
                      entry.value === 'codex'
                        ? '<div class="field-hint">Codex는 hkclaw-lite 전용 저장소가 아니라 이 머신의 로컬 Codex 로그인 상태를 그대로 사용합니다.</div>'
                        : ''
                    }
                  </div>
                </div>`
              : ''
          }
          ${
            !authSupported
              ? `<div class="wizard-auth-actions">
                  ${
                    credentialEditingSupported && entry.value !== 'local-llm'
                      ? `<button
                          type="button"
                          class="btn-secondary"
                          data-action="ai-save-credentials"
                          ${state.busy ? 'disabled' : ''}
                        >
                          ${renderButtonLabel('shield', '자격정보 저장')}
                        </button>`
                      : ''
                  }
                  ${
                    statusSupported
                      ? `<button
                          type="button"
                          class="btn-secondary"
                          data-action="ai-auth-status"
                          ${state.busy ? 'disabled' : ''}
                        >
                          ${renderButtonLabel('server', labels.status)}
                        </button>`
                      : ''
                  }
                  <button
                    type="button"
                    class="btn-primary"
                    data-action="ai-auth-test"
                    ${state.busy || !testSupported ? 'disabled' : ''}
                  >
                    ${renderButtonLabel('play', labels.test)}
                  </button>
                </div>`
              : ''
          }
          ${renderAgentWizardResult(authResult)}
          ${renderAgentWizardResult(testResult)}
        </div>
      </div>
    </section>
  `;
}

function renderAiStatusChips(agentType, authResult, testResult, ready) {
  const chips = [];
  const primaryChip = buildAiPrimaryStatusChip(agentType, authResult);
  if (primaryChip) {
    chips.push(primaryChip);
  }
  const runtimeReady = Boolean(authResult?.details?.runtimeReady);
  if (authResult?.details?.runtimeReady !== undefined) {
    chips.push(
      `<div class="auth-chip ${runtimeReady ? 'is-ok' : 'is-warning'}">${renderIcon('server', 'ui-icon')}${escapeHtml(`런타임 ${runtimeReady ? '준비' : '미설치'}`)}</div>`,
    );
  }
  const runtimeSourceChip = buildAiRuntimeSourceChip(agentType, authResult?.details || {});
  if (runtimeSourceChip) {
    chips.push(runtimeSourceChip);
  }
  if (authResult?.details?.configured !== undefined && agentType !== 'codex') {
    const configured = Boolean(authResult?.details?.configured);
    const label = agentType === 'local-llm' ? '연결' : 'API 키';
    chips.push(
      `<div class="auth-chip ${configured ? 'is-ok' : 'is-warning'}">${renderIcon(agentType === 'local-llm' ? 'ai' : 'shield', 'ui-icon')}${escapeHtml(`${label} ${configured ? '완료' : '미완료'}`)}</div>`,
    );
  }
  if (authResult?.details?.pendingLogin) {
    chips.push(`<div class="auth-chip is-warning">${renderIcon('login', 'ui-icon')}브라우저 로그인 진행 중</div>`);
  }
  const testOk = Boolean(testResult?.details?.success);
  chips.push(
    `<div class="auth-chip ${testOk ? 'is-ok' : 'is-warning'}">${renderIcon('play', 'ui-icon')}${escapeHtml(`테스트 ${testOk ? '완료' : '미완료'}`)}</div>`,
  );
  if (ready) {
    chips.push(`<div class="auth-chip is-ok">${renderIcon('sparkles', 'ui-icon')}사용 가능</div>`);
  }
  return chips.join('');
}

function buildAiRuntimeSourceChip(agentType, details) {
  if (agentType !== 'claude-code') {
    return '';
  }
  const badge = getClaudeRuntimeSourceBadge(details);
  if (!badge) {
    return '';
  }
  return `<div class="auth-chip ${badge.ok ? 'is-ok' : ''}"${badge.title ? ` title="${escapeAttr(badge.title)}"` : ''}>${escapeHtml(badge.label)}</div>`;
}

function buildAiRuntimeSourceMiniChip(agentType, details) {
  if (agentType !== 'claude-code') {
    return '';
  }
  const badge = getClaudeRuntimeSourceBadge(details);
  if (!badge) {
    return '';
  }
  return `<span class="mini-chip ${badge.ok ? 'mini-chip--ok' : ''}"${badge.title ? ` title="${escapeAttr(badge.title)}"` : ''}>${escapeHtml(badge.label)}</span>`;
}

function renderAiUsageSummary(agentType, usageSummary) {
  const summary = usageSummary || {
    supported: ['claude-code', 'gemini-cli', 'local-llm'].includes(agentType),
    recordedEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    lastRecordedAt: null,
  };

  if (!summary.supported) {
    return `
      <div class="usage-summary-card">
        <strong>토큰 사용량</strong>
        <div class="field-hint">이 런타임은 토큰 사용량을 노출하지 않습니다.</div>
      </div>
    `;
  }

  if (!summary.recordedEvents) {
    return `
      <div class="usage-summary-card">
        <strong>토큰 사용량</strong>
        <div class="field-hint">아직 기록이 없습니다. 이 앱에서 테스트 호출이나 실제 채널 실행을 한 뒤부터 누적됩니다.</div>
      </div>
    `;
  }

  const chips = [
    `<div class="auth-chip is-ok">${renderIcon('tokens', 'ui-icon')}총 ${escapeHtml(formatTokenCount(summary.totalTokens))}</div>`,
    `<div class="auth-chip">${renderIcon('login', 'ui-icon')}입력 ${escapeHtml(formatTokenCount(summary.inputTokens))}</div>`,
    `<div class="auth-chip">${renderIcon('play', 'ui-icon')}출력 ${escapeHtml(formatTokenCount(summary.outputTokens))}</div>`,
  ];
  if (summary.cacheCreationInputTokens > 0) {
    chips.push(
      `<div class="auth-chip">${renderIcon('edit', 'ui-icon')}캐시 작성 ${escapeHtml(formatTokenCount(summary.cacheCreationInputTokens))}</div>`,
    );
  }
  if (summary.cacheReadInputTokens > 0) {
    chips.push(
      `<div class="auth-chip">${renderIcon('refresh', 'ui-icon')}캐시 읽기 ${escapeHtml(formatTokenCount(summary.cacheReadInputTokens))}</div>`,
    );
  }

  return `
    <div class="usage-summary-card">
      <strong>토큰 사용량</strong>
      <div class="ai-modal-body">${chips.join('')}</div>
      <div class="field-hint">이 앱이 관측한 누적값만 집계합니다. 외부에서 직접 사용한 내역은 포함되지 않습니다.</div>
      <div class="field-hint">기록 횟수 ${escapeHtml(formatTokenCount(summary.recordedEvents))}${summary.lastRecordedAt ? ` · 마지막 기록 ${escapeHtml(formatRelativeDateTime(summary.lastRecordedAt))}` : ''}</div>
    </div>
  `;
}

function isAiCompleteLoginDisabled(agentType, authResult) {
  if (agentType === 'claude-code') {
    const callbackUrl = optionalDraftText(state.aiManager?.authConfig?.callbackUrl);
    return !callbackUrl;
  }
  if (agentType === 'gemini-cli') {
    const authorizationCode = optionalDraftText(state.aiManager?.authConfig?.authorizationCode);
    return !authorizationCode;
  }
  if (!isAiAuthSupported(agentType)) {
    return true;
  }
  return false;
}

function isAiTestReady(agentType, ready) {
  if (agentType === 'codex' || agentType === 'claude-code' || agentType === 'gemini-cli') {
    return Boolean(ready);
  }
  return true;
}

function buildAiPrimaryStatusChip(agentType, authResult) {
  if (isAiAuthSupported(agentType)) {
    const loggedIn = Boolean(authResult?.details?.loggedIn);
    const label = agentType === 'codex' ? '인증' : '로그인';
    return `<div class="auth-chip ${loggedIn ? 'is-ok' : 'is-warning'}">${renderIcon('shield', 'ui-icon')}${escapeHtml(`${label} ${loggedIn ? '완료' : '미완료'}`)}</div>`;
  }

  const configured = Boolean(authResult?.details?.configured);
  const label = agentType === 'local-llm' ? '연결' : '자격정보';
  return `<div class="auth-chip ${configured ? 'is-ok' : 'is-warning'}">${renderIcon(agentType === 'local-llm' ? 'ai' : 'shield', 'ui-icon')}${escapeHtml(`${label} ${configured ? '완료' : '미완료'}`)}</div>`;
}

function renderAdminPasswordModal() {
  const hasErrors = Object.keys(getFormErrors('adminPassword')).length > 0;
  const errorText = getFirstFormError('adminPassword');
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="관리자 비밀번호 설정">
      <div class="modal-backdrop" data-action="close-admin-password-modal"></div>
      <div class="panel modal-card modal-card--small">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon('shield', 'ui-icon')}</span>
            <h2>관리자 비밀번호 설정</h2>
          </div>
          <button type="button" class="btn-secondary" data-action="close-admin-password-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
        </div>
        <form data-form="admin-password" class="form">
          ${renderFormErrorSummary('adminPassword')}
          <div class="form-grid">
            ${
              state.auth.enabled
                ? `
                    <div class="field field-full ${fieldErrorClass('adminPassword', 'currentPassword')}">
                      <label for="admin-current-password">${renderRequiredLabel('현재 비밀번호')}</label>
                      <input id="admin-current-password" type="password" name="currentPassword" />
                      ${renderFormError('adminPassword', 'currentPassword')}
                    </div>
                  `
                : ''
            }
            <div class="field field-full ${fieldErrorClass('adminPassword', 'newPassword')}">
              <label for="admin-new-password">${renderRequiredLabel('새 비밀번호')}</label>
              <input id="admin-new-password" type="password" name="newPassword" />
              ${renderFormError('adminPassword', 'newPassword')}
            </div>
            <div class="field field-full ${fieldErrorClass('adminPassword', 'confirmPassword')}">
              <label for="admin-confirm-password">${renderRequiredLabel('새 비밀번호 확인')}</label>
              <input id="admin-confirm-password" type="password" name="confirmPassword" />
              ${renderFormError('adminPassword', 'confirmPassword')}
            </div>
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy || hasErrors ? 'disabled' : ''}${hasErrors && errorText ? ` title="${escapeAttr(errorText)}"` : ''}>${renderButtonLabel('edit', '저장')}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderRuntimeResetModal() {
  const modal = state.runtimeResetModal || {};
  const channel = state.data?.channels?.find((entry) => entry.name === modal.channelName) || null;
  const sessions = sortRuntimeSessions(channel?.runtime?.sessions || []);
  const targetSessions = modal.role
    ? sessions.filter((session) => session.role === modal.role)
    : sessions.filter((session) => session.runtimeBackend === 'claude-cli');
  const scopeLabel = modal.role ? `${channel?.name || modal.channelName}:${modal.role}` : channel?.name || modal.channelName;
  const resetLabel = modal.role ? `${localizeAgentRole(modal.role)} role` : '채널 전체 Claude role';

  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="Claude 세션 초기화">
      <div class="modal-backdrop" data-action="close-runtime-reset-modal"></div>
      <div class="panel modal-card modal-card--small">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon('refresh', 'ui-icon')}</span>
            <h2>Claude 세션 초기화</h2>
          </div>
          <button type="button" class="btn-secondary" data-action="close-runtime-reset-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
        </div>
        <div class="runtime-reset-body">
          <p><strong>${escapeHtml(scopeLabel)}</strong>의 저장된 Claude CLI 세션 매핑을 지웁니다.</p>
          <p>삭제 대상은 ${escapeHtml(resetLabel)}입니다. 다음 실행부터 새 Claude 세션으로 시작하고, 과거 run 기록과 메시지는 유지됩니다.</p>
          ${
            targetSessions.length
              ? `
                  <div class="runtime-reset-targets">
                    ${targetSessions
                      .map((session) => `
                        <span class="mini-chip">${escapeHtml([
                          session.role || 'unknown',
                          session.agentName || 'agent 미지정',
                          formatRuntimeSessionId(session.runtimeSessionId),
                        ].filter(Boolean).join(' · '))}</span>
                      `)
                      .join('')}
                  </div>
                `
              : '<p class="field-hint">현재 지울 Claude 세션 매핑이 없습니다.</p>'
          }
        </div>
        <div class="actions">
          <button type="button" class="btn-danger" data-action="confirm-reset-channel-runtime-sessions" ${state.busy || !targetSessions.length ? 'disabled' : ''}>${renderButtonLabel('refresh', '초기화')}</button>
          <button type="button" class="btn-secondary" data-action="close-runtime-reset-modal" ${state.busy ? 'disabled' : ''}>취소</button>
        </div>
      </div>
    </section>
  `;
}

function renderConnectorModal() {
  const current = state.connectorDraft || createBlankConnector();
  const type = current.type || 'kakao';
  const isEditing = Boolean(optionalDraftText(current.currentName));
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="커넥터 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-connector-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon('link', 'ui-icon')}</span>
            <h2>커넥터 ${isEditing ? '수정' : '추가'}</h2>
          </div>
          <button type="button" class="btn-secondary" data-action="close-connector-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
        </div>
        <form data-form="connector" class="form">
          ${renderFormErrorSummary('connector')}
          <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
          <div class="form-grid">
            <div class="field ${fieldErrorClass('connector', 'name')}">
              <label for="connector-name">${renderRequiredLabel('이름')}</label>
              <input id="connector-name" name="name" value="${escapeAttr(current.name)}" placeholder="예: kakao-main" />
              ${renderFormError('connector', 'name')}
            </div>
            <div class="field ${fieldErrorClass('connector', 'type')}">
              <label for="connector-type">${renderRequiredLabel('타입')}</label>
              <select id="connector-type" name="type">${renderOptions(state.data.choices.messagingPlatforms, type)}</select>
              ${renderFormError('connector', 'type')}
            </div>
            <div class="field field-full">
              <label for="connector-description">설명</label>
              <input id="connector-description" name="description" value="${escapeAttr(current.description)}" placeholder="예: 운영 카카오 채널 계정" />
            </div>
            ${renderConnectorCredentialFields(current)}
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('save', '저장')}</button>
            <button type="button" class="btn-secondary" data-action="close-connector-modal" ${state.busy ? 'disabled' : ''}>취소</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderConnectorCredentialFields(current) {
  const type = current.type || 'kakao';
  if (type === 'telegram') {
    return `
      <div class="field field-full ${fieldErrorClass('connector', 'telegramBotToken')}">
        <label for="connector-telegram-token">${renderRequiredLabel('Telegram 봇 토큰')}</label>
        <input id="connector-telegram-token" name="telegramBotToken" value="${escapeAttr(current.telegramBotToken)}" />
        ${renderFormError('connector', 'telegramBotToken')}
      </div>
    `;
  }
  if (type === 'kakao') {
    return `
      <div class="field field-full">
        <label for="connector-kakao-relay">Kakao 릴레이 URL</label>
        <input id="connector-kakao-relay" name="kakaoRelayUrl" value="${escapeAttr(current.kakaoRelayUrl || getDefaultKakaoRelayUrl())}" />
        <div class="field-hint">비워도 기본 릴레이 URL을 사용합니다. hkclaw-lite 내장 릴레이를 쓰면 배포 주소를 넣습니다.</div>
      </div>
      <div class="field">
        <label for="connector-kakao-token">Kakao 연결 토큰</label>
        <input id="connector-kakao-token" name="kakaoRelayToken" value="${escapeAttr(current.kakaoRelayToken)}" placeholder="비우면 페어링 코드 생성" />
      </div>
      <div class="field">
        <label for="connector-kakao-session">Kakao 세션 토큰</label>
        <input id="connector-kakao-session" name="kakaoSessionToken" value="${escapeAttr(current.kakaoSessionToken)}" />
      </div>
    `;
  }
  return `
    <div class="field field-full ${fieldErrorClass('connector', 'discordToken')}">
      <label for="connector-discord-token">${renderRequiredLabel('Discord 봇 토큰')}</label>
      <input id="connector-discord-token" name="discordToken" value="${escapeAttr(current.discordToken)}" />
      ${renderFormError('connector', 'discordToken')}
    </div>
  `;
}

function renderChannelModal() {
  const current = state.channelDraft || createBlankChannel();
  const isTribunal = current.mode === 'tribunal';
  const platform = current.platform || 'discord';
  const isTelegram = platform === 'telegram';
  const isKakao = platform === 'kakao';
  const agentNames = (state.data.agents || []).map((entry) => entry.name);
  const isEditing = Boolean(optionalDraftText(current.currentName));
  const visibleErrors = getFormErrors('channel');
  const hasErrors = Object.keys(visibleErrors).length > 0;
  const errorText = getFirstFormError('channel');
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="채널 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-channel-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <div class="section-title-group">
            <span class="section-title-icon">${renderIcon('channels', 'ui-icon')}</span>
            <h2>채널 ${isEditing ? '수정' : '추가'}</h2>
          </div>
          <button type="button" class="btn-secondary" data-action="close-channel-modal" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('stop', '닫기')}</button>
        </div>
        <form data-form="channel" class="form">
          ${renderFormErrorSummary('channel')}
          <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
          <div class="form-grid">
            <div class="field">
              <label for="channel-platform">${renderRequiredLabel('플랫폼')}</label>
              <select id="channel-platform" name="platform">${renderOptions(state.data.choices.messagingPlatforms, current.platform || 'discord')}</select>
            </div>
            <div class="field">
              <label for="channel-connector">연결 커넥터</label>
              <select id="channel-connector" name="connector">${renderConnectorOptions(platform, current.connector, true)}</select>
              <div class="field-hint">커넥터는 Discord/Telegram/Kakao 계정·토큰 연결입니다. 하나의 커넥터를 여러 채널이 공유할 수 있고, 비우면 기존 에이전트 내 연결 설정을 호환 모드로 사용합니다.</div>
            </div>
            <div class="field ${fieldErrorClass('channel', 'name')}">
              <label for="channel-name">${renderRequiredLabel('이름')}</label>
              <input id="channel-name" name="name" value="${escapeAttr(current.name)}" />
              ${renderFormError('channel', 'name')}
            </div>
            ${
              isTelegram
                ? `
                    <div class="field ${fieldErrorClass('channel', 'telegramChatId')}">
                      <label for="channel-telegram-chat">${renderRequiredLabel('Telegram 채팅 ID')}</label>
                      <input id="channel-telegram-chat" name="telegramChatId" value="${escapeAttr(current.telegramChatId)}" />
                      ${renderFormError('channel', 'telegramChatId')}
                    </div>
                    <div class="field">
                      <label for="channel-telegram-thread">Telegram 스레드 ID</label>
                      <input id="channel-telegram-thread" name="telegramThreadId" value="${escapeAttr(current.telegramThreadId)}" />
                    </div>
                  `
                : isKakao
                  ? `
                    <div class="field ${fieldErrorClass('channel', 'kakaoChannelId')}">
                      <label for="channel-kakao-channel">${renderRequiredLabel('Kakao 수신 channelId 필터')}</label>
                      <input id="channel-kakao-channel" name="kakaoChannelId" value="${escapeAttr(current.kakaoChannelId || '*')}" placeholder="* = 모든 Kakao channelId 허용" />
                      <div class="field-hint">Kakao 연결은 커넥터가 열고, 이 값은 들어온 메시지를 이 hkclaw-lite 채널로 보낼지 고르는 필터입니다. 단일 Kakao 채널이면 * 로 두세요.</div>
                      ${renderFormError('channel', 'kakaoChannelId')}
                    </div>
                    <div class="field">
                      <label for="channel-kakao-user">Kakao 사용자 ID 필터</label>
                      <input id="channel-kakao-user" name="kakaoUserId" value="${escapeAttr(current.kakaoUserId)}" placeholder="선택: 특정 paired user만 이 채널로 라우팅" />
                    </div>
                  `
                : `
                    <div class="field ${fieldErrorClass('channel', 'discordChannelId')}">
                      <label for="channel-discord">${renderRequiredLabel('디스코드 채널 ID')}</label>
                      <input id="channel-discord" name="discordChannelId" value="${escapeAttr(current.discordChannelId)}" />
                      ${renderFormError('channel', 'discordChannelId')}
                    </div>
                    <div class="field">
                      <label for="channel-guild">길드 ID</label>
                      <input id="channel-guild" name="guildId" value="${escapeAttr(current.guildId)}" />
                    </div>
                  `
            }
            <div class="field ${fieldErrorClass('channel', 'workspace')}">
              <label for="channel-workspace">${renderRequiredLabel('워크스페이스')}</label>
              <input id="channel-workspace" name="workspace" value="${escapeAttr(current.workspace)}" />
              ${renderFormError('channel', 'workspace')}
            </div>
            <div class="field">
              <label for="channel-mode">${renderRequiredLabel('채널 모드')}</label>
              <select id="channel-mode" name="mode">${renderOptions(state.data.choices.channelModes, current.mode)}</select>
            </div>
            <div class="field ${fieldErrorClass('channel', 'agent')}">
              <label for="channel-agent">${renderRequiredLabel('owner 에이전트')}</label>
              <select id="channel-agent" name="agent">${renderNameOptions(agentNames, current.agent)}</select>
              ${renderFormError('channel', 'agent')}
            </div>
            ${
              isTribunal
                ? `
                    <div class="field field-full field-roles">
                      <label>역할 배치</label>
                      <div class="role-preview">
                        <span class="mini-chip">owner ${escapeHtml(current.agent || '선택')}</span>
                        <span class="mini-chip">reviewer ${escapeHtml(current.reviewer || '선택')}</span>
                        <span class="mini-chip">arbiter ${escapeHtml(current.arbiter || '선택')}</span>
                      </div>
                    </div>
                    <div class="field ${fieldErrorClass('channel', 'reviewer')}">
                      <label for="channel-reviewer">${renderRequiredLabel('reviewer 에이전트')}</label>
                      <select id="channel-reviewer" name="reviewer">${renderNameOptions(agentNames, current.reviewer, true)}</select>
                      ${renderFormError('channel', 'reviewer')}
                    </div>
                    <div class="field ${fieldErrorClass('channel', 'arbiter')}">
                      <label for="channel-arbiter">${renderRequiredLabel('arbiter 에이전트')}</label>
                      <select id="channel-arbiter" name="arbiter">${renderNameOptions(agentNames, current.arbiter, true)}</select>
                      ${renderFormError('channel', 'arbiter')}
                    </div>
                    <div class="field ${fieldErrorClass('channel', 'reviewRounds')}">
                      <label for="channel-rounds">검토 회차</label>
                      <input id="channel-rounds" name="reviewRounds" value="${escapeAttr(current.reviewRounds)}" />
                      ${renderFormError('channel', 'reviewRounds')}
                    </div>
                    <div class="field field-full">
                      <label>역할별 워크스페이스</label>
                      <div class="field-hint">비워두면 기본 워크스페이스를 그대로 씁니다.</div>
                    </div>
                    <div class="field">
                      <label for="channel-owner-workspace">owner 워크스페이스</label>
                      <input id="channel-owner-workspace" name="ownerWorkspace" value="${escapeAttr(current.ownerWorkspace)}" placeholder="${escapeAttr(current.workspace || getDefaultChannelWorkspace())}" />
                    </div>
                    <div class="field">
                      <label for="channel-reviewer-workspace">reviewer 워크스페이스</label>
                      <input id="channel-reviewer-workspace" name="reviewerWorkspace" value="${escapeAttr(current.reviewerWorkspace)}" placeholder="${escapeAttr(current.workspace || getDefaultChannelWorkspace())}" />
                    </div>
                    <div class="field">
                      <label for="channel-arbiter-workspace">arbiter 워크스페이스</label>
                      <input id="channel-arbiter-workspace" name="arbiterWorkspace" value="${escapeAttr(current.arbiterWorkspace)}" placeholder="${escapeAttr(current.workspace || getDefaultChannelWorkspace())}" />
                    </div>
                  `
                : ''
            }
            <div class="field field-full">
              <label for="channel-description">설명</label>
              <textarea id="channel-description" name="description">${escapeHtml(current.description)}</textarea>
            </div>
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy || hasErrors ? 'disabled' : ''}${hasErrors && errorText ? ` title="${escapeAttr(errorText)}"` : ''}>${isEditing ? '저장' : '추가'}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderLocalLlmConnectionEditor() {
  const current = state.localLlmDraft || createLocalLlmConnectionDraft();
  const isEditing = Boolean(optionalDraftText(current.currentName));
  const hasErrors = Object.keys(collectLocalLlmDraftErrors(current)).length > 0;
  const errorText = getFirstFormError('localLlm');
  return `
      <div class="local-llm-editor">
        <div class="section-head">
          <h3>로컬 LLM 연결 ${isEditing ? '수정' : '추가'}</h3>
          <button type="button" class="btn-secondary" data-action="close-local-llm-modal" ${state.busy ? 'disabled' : ''}>취소</button>
        </div>
        <form data-form="local-llm-connection" class="form">
        ${renderFormErrorSummary('localLlm')}
        <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
        <div class="form-grid">
          <div class="field ${fieldErrorClass('localLlm', 'name')}">
            <label for="local-llm-name">${renderRequiredLabel('이름')}</label>
            <input id="local-llm-name" name="name" value="${escapeAttr(current.name)}" />
            ${renderFormError('localLlm', 'name')}
          </div>
          <div class="field field-full ${fieldErrorClass('localLlm', 'baseUrl')}">
            <label for="local-llm-base-url">${renderRequiredLabel('주소')}</label>
            <input id="local-llm-base-url" name="baseUrl" value="${escapeAttr(current.baseUrl)}" placeholder="예: http://127.0.0.1:11434/v1" />
            ${renderFormError('localLlm', 'baseUrl')}
          </div>
          <div class="field field-full">
            <label for="local-llm-api-key">API 키</label>
            <input id="local-llm-api-key" name="apiKey" value="${escapeAttr(current.apiKey)}" placeholder="선택 사항" />
          </div>
          <div class="field field-full">
            <label for="local-llm-description">설명</label>
            <textarea id="local-llm-description" name="description">${escapeHtml(current.description)}</textarea>
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn-primary" ${state.busy || hasErrors ? 'disabled' : ''}${hasErrors && errorText ? ` title="${escapeAttr(errorText)}"` : ''}>${isEditing ? '저장' : '추가'}</button>
        </div>
      </form>
    </div>
  `;
}

function renderLoginScreen() {
  return `
    <section class="login-shell">
      <section class="panel login-panel">
        <div class="login-mark">${renderIcon('shield', 'ui-icon')}</div>
        <h1>관리 화면</h1>
        <p class="hero-description">콘솔 접근은 비밀번호로 보호됩니다. 로그인 후 에이전트, 채널, AI 런타임 구성을 바로 관리할 수 있습니다.</p>
        <div class="login-summary">
          ${renderDetailList([
            { label: '보호 변수', value: state.auth.passwordEnv || 'HKCLAW_LITE_ADMIN_PASSWORD' },
            { label: '현재 상태', value: state.auth.enabled ? '로그인 필요' : '보호 비활성화' },
          ])}
        </div>
        <form data-form="login" class="form">
          <div class="field">
            <label for="login-password">${renderRequiredLabel('비밀번호')}</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" />
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('login', '로그인')}</button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function renderEmptyState(title, loading = false) {
  return `
    <section class="empty-state ${loading ? 'is-loading' : ''}">
      <div class="login-mark">${renderIcon(loading ? 'sparkles' : 'server', 'ui-icon')}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(loading ? '상태와 구성을 불러오는 중입니다.' : '표시할 데이터가 없거나 아직 초기화되지 않았습니다.')}</p>
    </section>
  `;
}

function renderNotice() {
  if (!state.notice) {
    return '';
  }
  return `
    <div class="notice-stack" aria-live="polite" aria-atomic="true">
      <div class="notice ${state.notice.type === 'error' ? 'is-error' : 'is-info'}">
        <div class="notice-body">
          <span class="notice-icon">${renderIcon(state.notice.type === 'error' ? 'shield' : 'notice', 'ui-icon')}</span>
          <span>${escapeHtml(state.notice.text)}</span>
        </div>
        <button type="button" class="notice-close" data-action="close-notice" aria-label="알림 닫기">${renderButtonLabel('stop', '닫기')}</button>
      </div>
    </div>
  `;
}

function getFormErrors(scope) {
  return state.formErrors?.[scope] || {};
}

function setFormErrors(scope, errors = {}) {
  state.formErrors[scope] = errors || {};
}

function clearFormErrors(scope) {
  state.formErrors[scope] = {};
}

function refreshVisibleFormErrors(scope, errors = {}) {
  if (Object.keys(getFormErrors(scope)).length > 0) {
    setFormErrors(scope, errors);
  } else {
    clearFormErrors(scope);
  }
}

function renderFormError(scope, key) {
  const message = getFormErrors(scope)[key];
  return message ? `<div class="form-error">${escapeHtml(message)}</div>` : '';
}

function renderFormErrorSummary(scope) {
  const messages = Object.values(getFormErrors(scope)).filter(Boolean);
  if (messages.length <= 1) {
    return '';
  }
  return `<div class="form-error-summary">입력을 확인하세요.</div>`;
}

function getFirstFormError(scope) {
  return Object.values(getFormErrors(scope)).find(Boolean) || '';
}

function fieldErrorClass(scope, key) {
  return getFormErrors(scope)[key] ? 'field--error' : '';
}

function renderRequiredLabel(text) {
  return `${escapeHtml(text)}<span class="required-indicator" aria-hidden="true">*</span>`;
}

function createValidationError(scope, errors) {
  const error = new Error(Object.values(errors || {}).find(Boolean) || '입력을 확인하세요.');
  error.name = 'ValidationError';
  error.formScope = scope;
  error.formErrors = errors;
  return error;
}

function focusFirstInvalidField(scope) {
  const selectorMap = {
    agentWizard: '[data-form="agent-wizard"]',
    connector: '[data-form="connector"]',
    channel: '[data-form="channel"]',
    localLlm: '[data-form="local-llm-connection"]',
    adminPassword: '[data-form="admin-password"]',
  };
  const scopeSelector = selectorMap[scope];
  if (!scopeSelector) {
    return;
  }
  window.requestAnimationFrame(() => {
    const target = document.querySelector(
      `${scopeSelector} .field--error input, ${scopeSelector} .field--error select, ${scopeSelector} .field--error textarea`,
    );
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus?.();
  });
}

function getAgentWizardSteps(draft) {
  const selectableAgentTypes = getAgentTypeChoicesForDraft(draft);
  const steps = [
    {
      id: 'name',
      question: '이름은 뭘로 할까요?',
      body: `
        <div class="field ${fieldErrorClass('agentWizard', 'name')}">
          <label for="wizard-agent-name">${renderRequiredLabel('이름')}</label>
          <input id="wizard-agent-name" name="name" value="${escapeAttr(draft.name)}" autofocus />
          ${renderFormError('agentWizard', 'name')}
        </div>
      `,
    },
    {
      id: 'agent',
      question: 'AI 유형은 어떤 걸로 할까요?',
      body: `
        <div class="field ${fieldErrorClass('agentWizard', 'agent')}">
          <label for="wizard-agent-type">${renderRequiredLabel('AI 유형')}</label>
          <select id="wizard-agent-type" name="agent">${renderOptions(selectableAgentTypes, draft.agent)}</select>
          ${renderFormError('agentWizard', 'agent')}
        </div>
      `,
    },
  ];

  steps.push(
    {
      id: 'model',
      question: '모델은 뭘로 할까요?',
      body: renderModelField({
        inputId: 'wizard-agent-model',
        inputName: 'model',
        agentType: draft.agent,
        value: draft.model,
        modelMode: draft.modelMode,
        modelModeInputName: 'modelMode',
        catalogScope: 'agent-wizard',
        modelCatalog: state.agentWizard?.modelCatalog || null,
      }),
    },
    {
      id: 'fallback',
      question: '폴백 에이전트를 둘까요?',
      body: `
        <div class="field">
          <label for="wizard-agent-fallback">폴백 에이전트</label>
          <select id="wizard-agent-fallback" name="fallbackAgent">${renderNameOptions(state.data.agents.map((entry) => entry.name), draft.fallbackAgent, true)}</select>
        </div>
      `,
    },
    {
      id: 'execution',
      question: '실행 옵션을 정할까요?',
      body: `
        <div class="form-grid">
          ${renderEffortField(draft)}
          <div class="field ${fieldErrorClass('agentWizard', 'timeoutMs')}">
            <label for="wizard-agent-timeout">제한 시간(ms)</label>
            <input id="wizard-agent-timeout" name="timeoutMs" value="${escapeAttr(draft.timeoutMs)}" />
            ${renderFormError('agentWizard', 'timeoutMs')}
          </div>
        </div>
      `,
    },
    {
      id: 'runtime',
      question: '연결 옵션을 정할까요?',
      body: renderAgentWizardRuntimeStep(draft),
    },
    {
      id: 'context',
      question: '기본 지시와 참고 자료를 정할까요?',
      body: `
        <div class="form-grid">
          <div class="field field-full">
            <label for="wizard-agent-system">기본 지시문</label>
            <div class="field-hint">이 에이전트가 항상 지켜야 할 역할, 말투, 작업 규칙을 적습니다.</div>
            <textarea id="wizard-agent-system" name="systemPrompt" placeholder="예: 코드 리뷰어처럼 동작하고, 변경 이유와 위험 요소를 먼저 설명하세요.">${escapeHtml(draft.systemPrompt)}</textarea>
          </div>
          <div class="field field-full">
            <label for="wizard-agent-system-file">지시문 파일 경로</label>
            <div class="field-hint">긴 프롬프트를 파일로 관리하고 싶을 때 씁니다. 프로젝트 루트 기준 상대 경로를 넣으세요.</div>
            <input id="wizard-agent-system-file" name="systemPromptFile" value="${escapeAttr(draft.systemPromptFile)}" placeholder="예: prompts/reviewer.md" />
          </div>
          <div class="field field-full">
            <label for="wizard-agent-skills">불러올 스킬</label>
            <div class="field-hint">줄바꿈이나 쉼표로 여러 개를 넣을 수 있습니다. 비워두면 스킬 없이 실행합니다.</div>
            <textarea id="wizard-agent-skills" name="skillsText" placeholder="예: reviewer&#10;backend">${escapeHtml(draft.skillsText)}</textarea>
          </div>
          <div class="field field-full">
            <label for="wizard-agent-context">같이 읽을 파일</label>
            <div class="field-hint">처음 실행할 때 함께 읽게 할 문서나 설정 파일 경로입니다. 줄바꿈이나 쉼표로 구분하세요.</div>
            <textarea id="wizard-agent-context" name="contextFilesText" placeholder="예: README.md&#10;docs/architecture.md">${escapeHtml(draft.contextFilesText)}</textarea>
          </div>
        </div>
      `,
    },
  );

  return steps;
}

function renderAgentWizardRuntimeStep(draft) {
  const platform = optionalDraftText(draft.platform) || 'discord';
  const codexAccess = optionalDraftText(draft.codexAccess) || 'workspace-write';
  const tokenFieldName =
    platform === 'telegram'
      ? 'telegramBotToken'
      : platform === 'kakao'
        ? 'kakaoRelayToken'
        : 'discordToken';
  const blocks = [
    `
      <div class="field">
        <label for="wizard-agent-platform">${renderRequiredLabel('메시징 플랫폼')}</label>
        <select id="wizard-agent-platform" name="platform">
          ${renderOptions(state.data.choices.messagingPlatforms, platform)}
        </select>
      </div>
    `,
    platform === 'kakao'
      ? `
        <div class="field">
          <label for="wizard-agent-kakao-relay">Kakao 연결 릴레이 URL</label>
          <input
            id="wizard-agent-kakao-relay"
            name="kakaoRelayUrl"
            value="${escapeAttr(draft.kakaoRelayUrl || getDefaultKakaoRelayUrl())}"
            placeholder="${escapeAttr(getDefaultKakaoRelayUrl())}"
          />
          <div class="field-hint">이 Agent/worker가 SSE를 붙을 Kakao 릴레이 주소입니다. hkclaw-lite 내장 릴레이를 쓰면 배포 환경 기본값을 사용합니다.</div>
        </div>
        <div class="field field-full ${fieldErrorClass('agentWizard', tokenFieldName)}">
          <label for="wizard-agent-platform-token">Kakao 연결 토큰</label>
          <input
            id="wizard-agent-platform-token"
            name="kakaoRelayToken"
            value="${escapeAttr(draft.kakaoRelayToken || '')}"
            placeholder="선택: 비우면 시작 시 페어링 코드를 생성"
          />
          <div class="field-hint">비워두면 워커 시작 후 Kakao 채널에 입력할 /pair 코드가 생성됩니다.</div>
          ${renderFormError('agentWizard', tokenFieldName)}
        </div>
        <div class="field field-full">
          <label for="wizard-agent-kakao-session">Kakao 세션 토큰</label>
          <input
            id="wizard-agent-kakao-session"
            name="kakaoSessionToken"
            value="${escapeAttr(draft.kakaoSessionToken || '')}"
            placeholder="선택: 기존 세션 재사용"
          />
        </div>
      `
      : `
        <div class="field field-full ${fieldErrorClass('agentWizard', tokenFieldName)}">
          <label for="wizard-agent-platform-token">${renderRequiredLabel(platform === 'telegram' ? 'Telegram 봇 토큰' : 'Discord 토큰')}</label>
          <input
            id="wizard-agent-platform-token"
            name="${tokenFieldName}"
            value="${escapeAttr(platform === 'telegram' ? draft.telegramBotToken || '' : draft.discordToken || '')}"
            placeholder="${platform === 'telegram' ? 'Telegram bot token' : 'Discord bot token'}"
          />
          <div class="field-hint">선택한 메시징 플랫폼에 이 에이전트를 연결할 때 사용하는 토큰입니다.</div>
          ${renderFormError('agentWizard', tokenFieldName)}
        </div>
      `,
  ];

  if (draft.agent === 'codex') {
    blocks.push(`
      <div class="field">
        <label for="wizard-agent-codex-access">접근 범위</label>
        <select id="wizard-agent-codex-access" name="codexAccess">${renderOptions([
          { value: 'read-only', label: '읽기 전용', description: '파일 수정 없이 읽기와 점검만 허용' },
          { value: 'workspace-write', label: '작업 디렉터리만 수정', description: '워크스페이스 안에서만 수정 허용' },
          { value: 'danger-full-access', label: '전체 허용', description: '명령 실행과 파일 접근을 전부 허용' },
        ], codexAccess, false)}</select>
        <div class="field-hint">전체 허용은 Codex의 제한과 승인 확인을 모두 우회합니다.</div>
      </div>
    `);
  }

  if (draft.agent === 'claude-code') {
    blocks.push(`
      <div class="field">
        <label for="wizard-agent-permission">Claude 권한 모드</label>
        <select id="wizard-agent-permission" name="permissionMode">${renderOptions(state.data.choices.claudePermissionModes, draft.permissionMode, true)}</select>
      </div>
    `);
  }

  if (draft.agent === 'local-llm') {
    blocks.push(`
      <div class="field ${fieldErrorClass('agentWizard', 'baseUrl')}">
        <label for="wizard-agent-local-llm-connection">로컬 LLM 연결</label>
        <select id="wizard-agent-local-llm-connection" name="localLlmConnection">
          ${renderLocalLlmConnectionOptions(draft.localLlmConnection, true)}
        </select>
        ${renderFormError('agentWizard', 'baseUrl')}
      </div>
    `);
    if (!optionalDraftText(draft.localLlmConnection)) {
      blocks.push(`
        <div class="field ${fieldErrorClass('agentWizard', 'baseUrl')}">
          <label for="wizard-agent-base-url">${renderRequiredLabel('직접 입력 주소')}</label>
          <input id="wizard-agent-base-url" name="baseUrl" value="${escapeAttr(draft.baseUrl)}" />
          ${renderFormError('agentWizard', 'baseUrl')}
        </div>
      `);
    }
  }

  if (draft.agent === 'command') {
    blocks.push(`
      <div class="field ${fieldErrorClass('agentWizard', 'command')}">
        <label for="wizard-agent-command">${renderRequiredLabel('명령어')}</label>
        <input id="wizard-agent-command" name="command" value="${escapeAttr(draft.command)}" />
        ${renderFormError('agentWizard', 'command')}
      </div>
    `);
  }

  return `<div class="form-grid">${blocks.join('')}</div>`;
}

function renderAgentWizardResult(result) {
  if (!result) {
    return '';
  }

  const details = result.details || {};
  const runtimeHints = getClaudeRuntimeSourceHintLines(details);
  const links = [];
  if (details.url) {
    links.push(
      `<a class="result-link" href="${escapeAttr(details.url)}" target="_blank" rel="noreferrer">${escapeHtml(details.url)}</a>`,
    );
  }
  if (details.manualUrl && details.manualUrl !== details.url) {
    links.push(
      `<a class="result-link" href="${escapeAttr(details.manualUrl)}" target="_blank" rel="noreferrer">manual: ${escapeHtml(details.manualUrl)}</a>`,
    );
  }
  if (details.automaticUrl) {
    links.push(
      `<a class="result-link" href="${escapeAttr(details.automaticUrl)}" target="_blank" rel="noreferrer">automatic: ${escapeHtml(details.automaticUrl)}</a>`,
    );
  }
  return `
    <div class="wizard-result">
      <strong>${escapeHtml(details.summary || result.output || '완료')}</strong>
      ${runtimeHints.map((hint) => `<div class="field-hint">${escapeHtml(hint)}</div>`).join('')}
      ${links.join('')}
      ${details.commandHint ? `<div class="result-code">${escapeHtml(details.commandHint)}</div>` : ''}
      ${details.code ? `<div class="result-code">${escapeHtml(details.code)}</div>` : ''}
      ${
        details.requiresCode
          ? `<div class="field-hint">${escapeHtml(details.completionHint || '브라우저 인증 후 표시되는 코드를 붙여넣고 로그인 완료를 누르세요.')}</div>`
          : ''
      }
      ${
        !links.length && !details.code && result.output
          ? `<pre class="result-output">${escapeHtml(result.output)}</pre>`
          : ''
      }
    </div>
  `;
}

function validateAgentWizardStep() {
  if (!state.agentWizard) {
    return true;
  }

  const { draft, step } = state.agentWizard;
  const currentStep = getAgentWizardSteps(draft)[step];
  if (!currentStep) {
    return true;
  }

  if (currentStep.id === 'name') {
    requiredDraftText(draft.name, 'name');
  }

  if (currentStep.id === 'agent') {
    requiredDraftText(draft.agent, 'agent');
    assertSelectableAgentType(draft.agent);
  }

  if (currentStep.id === 'model' && draft.agent === 'local-llm') {
    requiredDraftText(draft.model, 'model');
  }

  if (
    currentStep.id === 'model' &&
    supportsDefaultModelMode(draft.agent) &&
    draft.modelMode === 'custom'
  ) {
    requiredDraftText(draft.model, 'model');
  }

  if (
    currentStep.id === 'fallback' &&
    optionalDraftText(draft.fallbackAgent) &&
    optionalDraftText(draft.fallbackAgent) === optionalDraftText(draft.name)
  ) {
    throw new Error('폴백 에이전트는 자기 자신과 같을 수 없습니다.');
  }

  if (currentStep.id === 'execution' && optionalDraftText(draft.timeoutMs)) {
    const timeout = Number(optionalDraftText(draft.timeoutMs));
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error('제한 시간은 1 이상의 정수여야 합니다.');
    }
  }

  if (currentStep.id === 'execution' && optionalDraftText(draft.effort)) {
    const efforts = getEffortChoices(draft.agent, draft.model);
    if (efforts.length > 0 && !efforts.includes(optionalDraftText(draft.effort))) {
      throw new Error('선택한 모델에서 지원하지 않는 추론 강도입니다.');
    }
  }

  if (currentStep.id === 'runtime') {
    const platform = optionalDraftText(draft.platform) || 'discord';
    if (platform === 'telegram') {
      requiredDraftText(draft.telegramBotToken, 'telegramBotToken');
    } else if (platform !== 'kakao') {
      requiredDraftText(draft.discordToken, 'discordToken');
    }
    if (draft.agent === 'command') {
      requiredDraftText(draft.command, 'command');
    }
    if (
      draft.agent === 'local-llm' &&
      !optionalDraftText(draft.localLlmConnection) &&
      !optionalDraftText(draft.baseUrl)
    ) {
      throw new Error('로컬 LLM 연결을 고르거나 직접 입력 주소를 넣으세요.');
    }
  }

  return true;
}

function isSafeEntityName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(value || '').trim());
}

function collectAgentWizardStepErrors() {
  const errors = {};
  if (!state.agentWizard) {
    return errors;
  }
  const { draft, step } = state.agentWizard;
  const currentStep = getAgentWizardSteps(draft)[step];
  if (!currentStep) {
    return errors;
  }

  if (currentStep.id === 'name') {
    const value = optionalDraftText(draft.name);
    if (!value) {
      errors.name = '이름을 입력하세요.';
    } else if (!isSafeEntityName(value)) {
      errors.name = '영문, 숫자, .-_ 만 가능합니다.';
    }
  }

  if (currentStep.id === 'agent' && !optionalDraftText(draft.agent)) {
    errors.agent = 'AI 유형을 선택하세요.';
  }

  if (currentStep.id === 'model') {
    if (draft.agent === 'local-llm' && !optionalDraftText(draft.model)) {
      errors.model = '모델을 입력하세요.';
    }
    if (
      supportsDefaultModelMode(draft.agent) &&
      draft.modelMode === 'custom' &&
      !optionalDraftText(draft.model)
    ) {
      errors.model = '모델을 입력하세요.';
    }
  }

  if (currentStep.id === 'fallback') {
    if (
      optionalDraftText(draft.fallbackAgent) &&
      optionalDraftText(draft.fallbackAgent) === optionalDraftText(draft.name)
    ) {
      errors.fallbackAgent = '자기 자신은 폴백으로 쓸 수 없습니다.';
    }
  }

  if (currentStep.id === 'execution') {
    if (optionalDraftText(draft.timeoutMs)) {
      const timeout = Number(optionalDraftText(draft.timeoutMs));
      if (!Number.isInteger(timeout) || timeout <= 0) {
        errors.timeoutMs = '1 이상의 정수만 입력하세요.';
      }
    }
    if (optionalDraftText(draft.effort)) {
      const efforts = getEffortChoices(draft.agent, draft.model);
      if (efforts.length > 0 && !efforts.includes(optionalDraftText(draft.effort))) {
        errors.effort = '이 모델에서 지원하지 않는 강도입니다.';
      }
    }
  }

  if (currentStep.id === 'runtime') {
    const platform = optionalDraftText(draft.platform) || 'discord';
    if (platform === 'telegram') {
      if (!optionalDraftText(draft.telegramBotToken)) {
        errors.telegramBotToken = 'Telegram 봇 토큰을 입력하세요.';
      }
    } else if (platform === 'kakao') {
      if (
        optionalDraftText(draft.kakaoRelayUrl) &&
        !/^https?:\/\//iu.test(optionalDraftText(draft.kakaoRelayUrl))
      ) {
        errors.kakaoRelayUrl = 'http 또는 https URL을 입력하세요.';
      }
    } else if (!optionalDraftText(draft.discordToken)) {
      errors.discordToken = 'Discord 토큰을 입력하세요.';
    }
    if (draft.agent === 'command' && !optionalDraftText(draft.command)) {
      errors.command = '명령어를 입력하세요.';
    }
    if (
      draft.agent === 'local-llm' &&
      !optionalDraftText(draft.localLlmConnection) &&
      !optionalDraftText(draft.baseUrl)
    ) {
      errors.baseUrl = '연결을 고르거나 주소를 입력하세요.';
    }
  }

  return errors;
}

function collectConnectorDraftErrors(draft = state.connectorDraft || {}) {
  const errors = {};
  const name = optionalDraftText(draft.name);
  const type = optionalDraftText(draft.type) || 'kakao';
  const validTypes = new Set((state.data?.choices?.messagingPlatforms || []).map((entry) => entry.value));
  if (!name) {
    errors.name = '이름을 입력하세요.';
  } else if (!isSafeEntityName(name)) {
    errors.name = '영문, 숫자, .-_ 만 가능합니다.';
  }
  if (!validTypes.has(type)) {
    errors.type = '지원하는 커넥터 타입을 고르세요.';
  }
  if (type === 'discord' && !optionalDraftText(draft.discordToken)) {
    errors.discordToken = 'Discord 토큰을 입력하세요.';
  }
  if (type === 'telegram' && !optionalDraftText(draft.telegramBotToken)) {
    errors.telegramBotToken = 'Telegram 봇 토큰을 입력하세요.';
  }
  return errors;
}

function collectChannelDraftErrors(draft = state.channelDraft || {}) {
  const errors = {};
  const name = optionalDraftText(draft.name);
  const platform = optionalDraftText(draft.platform) || 'discord';
  const mode = optionalDraftText(draft.mode) || 'single';
  if (!name) {
    errors.name = '이름을 입력하세요.';
  } else if (!isSafeEntityName(name)) {
    errors.name = '영문, 숫자, .-_ 만 가능합니다.';
  }
  if (platform === 'telegram') {
    if (!optionalDraftText(draft.telegramChatId)) {
      errors.telegramChatId = 'Telegram 채팅 ID를 입력하세요.';
    }
  } else if (platform === 'kakao') {
    if (!optionalDraftText(draft.kakaoChannelId)) {
      errors.kakaoChannelId = 'Kakao 수신 channelId 필터를 입력하세요. 전체 허용은 * 를 사용하세요.';
    }
  } else if (!optionalDraftText(draft.discordChannelId)) {
    errors.discordChannelId = '디스코드 채널 ID를 입력하세요.';
  }
  if (!optionalDraftText(draft.workspace)) {
    errors.workspace = '워크스페이스를 입력하세요.';
  }
  if (!optionalDraftText(draft.agent)) {
    errors.agent = 'owner 에이전트를 고르세요.';
  }
  if (platform === 'kakao') {
    const conflictingChannel = findKakaoChannelRouteConflict(draft);
    if (conflictingChannel) {
      errors.kakaoChannelId = `채널 "${conflictingChannel.name}"과 Kakao 라우팅 필터가 겹칩니다. channelId 또는 사용자 ID 필터를 좁혀주세요.`;
    }
  }
  if (mode === 'tribunal') {
    if (!optionalDraftText(draft.reviewer)) {
      errors.reviewer = 'reviewer 에이전트를 고르세요.';
    }
    if (!optionalDraftText(draft.arbiter)) {
      errors.arbiter = 'arbiter 에이전트를 고르세요.';
    }
    if (
      optionalDraftText(draft.reviewer) &&
      optionalDraftText(draft.reviewer) === optionalDraftText(draft.agent)
    ) {
      errors.reviewer = 'owner 와 다른 에이전트를 고르세요.';
    }
    if (
      optionalDraftText(draft.arbiter) &&
      optionalDraftText(draft.arbiter) === optionalDraftText(draft.agent)
    ) {
      errors.arbiter = 'owner 와 다른 에이전트를 고르세요.';
    }
    if (
      optionalDraftText(draft.arbiter) &&
      optionalDraftText(draft.arbiter) === optionalDraftText(draft.reviewer)
    ) {
      errors.arbiter = 'reviewer 와 다른 에이전트를 고르세요.';
    }
    if (optionalDraftText(draft.reviewRounds)) {
      const rounds = Number(optionalDraftText(draft.reviewRounds));
      if (!Number.isInteger(rounds) || rounds <= 0) {
        errors.reviewRounds = '1 이상의 정수만 입력하세요.';
      }
    }
  }
  return errors;
}

function findKakaoChannelRouteConflict(draft) {
  const candidateName = optionalDraftText(draft.currentName) || optionalDraftText(draft.name);
  const routeKey = getKakaoDraftRouteKey(draft);
  if (!routeKey) {
    return null;
  }
  return (state.data?.channels || []).find((channel) => {
    if (channel.name === candidateName) {
      return false;
    }
    if ((channel.platform || 'discord') !== 'kakao') {
      return false;
    }
    return (
      getKakaoDraftRouteKey(channel) === routeKey &&
      kakaoChannelIdFiltersOverlap(draft.kakaoChannelId, channel.kakaoChannelId) &&
      kakaoUserIdFiltersOverlap(draft.kakaoUserId, channel.kakaoUserId)
    );
  }) || null;
}

function getKakaoDraftRouteKey(channel) {
  const connector = optionalDraftText(channel.connector);
  if (connector) {
    return `connector:${connector}`;
  }
  const agent = optionalDraftText(channel.agent);
  return agent ? `legacy:${agent}` : '';
}

function kakaoChannelIdFiltersOverlap(left, right) {
  const leftValue = optionalDraftText(left) || '*';
  const rightValue = optionalDraftText(right) || '*';
  return leftValue === '*' || rightValue === '*' || leftValue === rightValue;
}

function kakaoUserIdFiltersOverlap(left, right) {
  const leftValue = optionalDraftText(left);
  const rightValue = optionalDraftText(right);
  return !leftValue || !rightValue || leftValue === rightValue;
}

function collectLocalLlmDraftErrors(draft = state.localLlmDraft || {}) {
  const errors = {};
  const name = optionalDraftText(draft.name);
  if (!name) {
    errors.name = '이름을 입력하세요.';
  } else if (!isSafeEntityName(name)) {
    errors.name = '영문, 숫자, .-_ 만 가능합니다.';
  }
  if (!optionalDraftText(draft.baseUrl)) {
    errors.baseUrl = '주소를 입력하세요.';
  }
  return errors;
}

function collectAdminPasswordErrors(formData) {
  const errors = {};
  const currentPassword = optionalText(formData, 'currentPassword');
  const newPassword = optionalText(formData, 'newPassword');
  const confirmPassword = optionalText(formData, 'confirmPassword');
  if (state.auth.enabled && !currentPassword) {
    errors.currentPassword = '현재 비밀번호를 입력하세요.';
  }
  if (!newPassword) {
    errors.newPassword = '새 비밀번호를 입력하세요.';
  } else if (newPassword.length < 8) {
    errors.newPassword = '8자 이상 입력하세요.';
  }
  if (!confirmPassword) {
    errors.confirmPassword = '비밀번호 확인을 입력하세요.';
  } else if (newPassword && newPassword !== confirmPassword) {
    errors.confirmPassword = '새 비밀번호와 같아야 합니다.';
  }
  return errors;
}

function createBlankAgent(agentType = null) {
  const selectableAgentTypes = getSelectableAgentTypes();
  const resolvedAgentType = agentType || selectableAgentTypes[0]?.value || '';
  const defaultClaudePermissionMode =
    state.data.choices.claudePermissionModes.find((entry) => entry.value === 'bypassPermissions')?.value ||
    state.data.choices.claudePermissionModes[0]?.value ||
    '';
  return {
    name: '',
    agent: resolvedAgentType,
    platform: 'discord',
    fallbackAgent: '',
    modelMode: defaultModelModeForAgent(resolvedAgentType),
    model: '',
    effort: '',
    timeoutMs: '',
    systemPrompt: '',
    systemPromptFile: '',
    skillsText: '',
    contextFilesText: '',
    sandbox: state.data.choices.codexSandboxes[0]?.value || '',
    codexAccess: 'workspace-write',
    permissionMode: defaultClaudePermissionMode,
    dangerous: false,
    discordToken: '',
    telegramBotToken: '',
    kakaoRelayUrl: getDefaultKakaoRelayUrl(),
    kakaoRelayToken: '',
    kakaoSessionToken: '',
    localLlmConnection: getDefaultLocalLlmConnectionName(),
    baseUrl: '',
    command: '',
  };
}

function createAgentDraft(agent) {
  const resolvedAgentType = optionalDraftText(agent?.agent) || getSelectableAgentTypes()[0]?.value || '';
  const model = optionalDraftText(agent?.model);
  return {
    name: agent?.name || '',
    agent: resolvedAgentType,
    platform: optionalDraftText(agent?.platform) || 'discord',
    fallbackAgent: optionalDraftText(agent?.fallbackAgent),
    modelMode: supportsDefaultModelMode(resolvedAgentType) ? (model ? 'custom' : 'default') : 'custom',
    model: model || '',
    effort: optionalDraftText(agent?.effort),
    timeoutMs: agent?.timeoutMs ? String(agent.timeoutMs) : '',
    systemPrompt: agent?.systemPrompt || '',
    systemPromptFile: agent?.systemPromptFile || '',
    skillsText: Array.isArray(agent?.skills) ? agent.skills.join('\n') : '',
    contextFilesText: Array.isArray(agent?.contextFiles) ? agent.contextFiles.join('\n') : '',
    sandbox: optionalDraftText(agent?.sandbox) || state.data?.choices?.codexSandboxes?.[0]?.value || '',
    codexAccess: resolveCodexAccessMode(agent),
    permissionMode:
      optionalDraftText(agent?.permissionMode) ||
      state.data?.choices?.claudePermissionModes?.find((entry) => entry.value === 'bypassPermissions')?.value ||
      state.data?.choices?.claudePermissionModes?.[0]?.value ||
      '',
    dangerous: Boolean(agent?.dangerous),
    discordToken: optionalDraftText(agent?.discordToken),
    telegramBotToken: optionalDraftText(agent?.telegramBotToken),
    kakaoRelayUrl: optionalDraftText(agent?.kakaoRelayUrl) || getDefaultKakaoRelayUrl(),
    kakaoRelayToken: optionalDraftText(agent?.kakaoRelayToken),
    kakaoSessionToken: optionalDraftText(agent?.kakaoSessionToken),
    localLlmConnection: optionalDraftText(agent?.localLlmConnection) || getDefaultLocalLlmConnectionName(),
    baseUrl: optionalDraftText(agent?.baseUrl),
    command: agent?.command || '',
  };
}

function resolveCodexAccessMode(source) {
  const explicit = optionalDraftText(source?.codexAccess);
  if (explicit) {
    return explicit;
  }
  if (Boolean(source?.dangerous) || optionalDraftText(source?.sandbox) === 'danger-full-access') {
    return 'danger-full-access';
  }
  if (optionalDraftText(source?.sandbox) === 'read-only') {
    return 'read-only';
  }
  return 'workspace-write';
}

function createChannelDraft(channel) {
  return {
    currentName: channel?.name || '',
    name: channel?.name || '',
    platform: channel?.platform || 'discord',
    connector: optionalDraftText(channel?.connector),
    mode: channel?.mode || 'single',
    discordChannelId: channel?.discordChannelId || '',
    guildId: channel?.guildId || '',
    telegramChatId: channel?.telegramChatId || '',
    telegramThreadId: channel?.telegramThreadId || '',
    kakaoChannelId: channel?.kakaoChannelId || '*',
    kakaoUserId: channel?.kakaoUserId || '',
    workspace: channel?.workspace || getDefaultChannelWorkspace(),
    ownerWorkspace: channel?.ownerWorkspace || '',
    reviewerWorkspace: channel?.reviewerWorkspace || '',
    arbiterWorkspace: channel?.arbiterWorkspace || '',
    agent: channel?.agent || '',
    reviewer: channel?.reviewer || '',
    arbiter: channel?.arbiter || '',
    reviewRounds: channel?.reviewRounds ? String(channel.reviewRounds) : '',
    description: channel?.description || '',
  };
}

function getAgentTypeChoice(agentType) {
  return (state.data?.choices?.agentTypes || []).find((entry) => entry.value === agentType) || null;
}

function getSelectableAgentTypes() {
  return (state.data?.choices?.agentTypes || []).filter((entry) => {
    if (entry.value === 'command') {
      return false;
    }
    if (!isAiAuthSupported(entry.value)) {
      return true;
    }
    return isAiReady(entry.value, state.aiStatuses[entry.value] || {});
  });
}

function getAgentTypeChoicesForDraft(draft) {
  const choices = getSelectableAgentTypes();
  const currentAgentType = optionalDraftText(draft?.agent);
  if (!currentAgentType || choices.some((entry) => entry.value === currentAgentType)) {
    return choices;
  }
  const currentEntry = getAgentTypeChoice(currentAgentType);
  return currentEntry ? [...choices, currentEntry] : choices;
}

function assertSelectableAgentType(agentType) {
  const exists = getAgentTypeChoicesForDraft(state.agentWizard?.draft).some((entry) => entry.value === agentType);
  if (!exists) {
    throw new Error('사용 가능한 AI만 선택할 수 있습니다.');
  }
}

function createAiManager(agentType, options = {}) {
  const cached = state.aiStatuses[agentType] || {};
  const localLlmConnections = getLocalLlmConnectionEntries();
  const requestedLocalLlmConnection = optionalDraftText(options?.localLlmConnection);
  const defaultLocalLlmConnection =
    requestedLocalLlmConnection ||
    localLlmConnections[0]?.name ||
    '';
  return {
    type: agentType,
    localLlmConnection: agentType === 'local-llm' ? defaultLocalLlmConnection : '',
    authResult: cached.authResult || null,
    testResult: cached.testResult || null,
    usageSummary: cached.usageSummary || null,
    modelCatalog: null,
    authConfig: buildAiAuthDraft(agentType),
    credentials: buildAiCredentialDraft(agentType),
    testConfig: {
      modelMode: defaultModelModeForAgent(agentType),
      model: '',
      localLlmConnection: defaultLocalLlmConnection,
    },
  };
}

async function runAiManagerAction(action, options = {}) {
  if (!state.aiManager) {
    return;
  }

  const agentType = optionalDraftText(state.aiManager.type);
  if (!agentType) {
    return;
  }

  if (action === 'test' && !isAiTestSupported(agentType)) {
    throw new Error('이 AI 유형은 테스트 호출을 지원하지 않습니다.');
  }

  if (action === 'status' && !isAiStatusSupported(agentType)) {
    throw new Error('이 AI 유형은 상태 확인을 지원하지 않습니다.');
  }

  if (action !== 'test' && action !== 'status' && !isAiAuthSupported(agentType)) {
    throw new Error('이 AI 유형은 인증 관리를 지원하지 않습니다.');
  }

  const body = {
    agentType,
    action,
  };

  if (action === 'login') {
    body.options = buildAiManagerAuthOptions(agentType);
  }

  if (action === 'complete-login') {
    if (agentType === 'claude-code') {
      body.callbackUrl = optionalDraftText(state.aiManager?.authConfig?.callbackUrl);
    } else {
      body.authorizationCode = optionalDraftText(state.aiManager?.authConfig?.authorizationCode);
    }
  }

  if (action === 'test') {
    body.definition = buildAiManagerTestDefinition(agentType);
    body.workdir = '.';
  }

  try {
    const response = await mutateJson('/api/agent-auth', {
      method: 'POST',
      body,
    });

    handleLoginLaunch(response.result, options.popup);

    if (!state.aiManager || state.aiManager.type !== agentType) {
      return;
    }

    if (action === 'test') {
      state.aiManager.testResult = response.result;
      state.aiManager.usageSummary = response.result?.details?.usageSummary || state.aiManager.usageSummary;
    } else {
      applyAiManagerAuthResult(agentType, response.result, action);
      if (action === 'logout') {
        stopAiManagerStatusPolling();
      } else if (action === 'login' && agentType === 'codex' && response.result?.details?.pendingLogin) {
        startAiManagerStatusPolling(agentType);
      } else if (action === 'status' && !response.result?.details?.pendingLogin) {
        stopAiManagerStatusPolling();
      }
    }

    if (!(action === 'login' && response.result?.details?.url)) {
      state.notice = null;
    }
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

async function saveAiCredentials() {
  if (!state.aiManager || !supportsAiCredentialEditing(state.aiManager.type)) {
    return;
  }

  const agentType = optionalDraftText(state.aiManager.type);
  try {
    const response = await mutateJson('/api/local-llm-connections', {
      method: 'PUT',
      body: {
        connections: parseLocalLlmConnectionEntries(state.aiManager.credentials.connections),
      },
    });

    state.data = response.state;
    await refreshAiStatuses();
    state.aiManager = createAiManager(agentType);
    setNotice('info', '로컬 LLM 연결 목록을 저장했습니다.');
    render();
  } catch (error) {
    setNotice('error', localizeErrorMessage(error.message));
    render();
  }
}

function buildAiManagerTestDefinition(agentType) {
  const config = state.aiManager?.testConfig || {};
  const definition = {
    name: 'ai-manager-test',
    agent: agentType,
    model: resolveConfiguredModel(agentType, config),
  };

  if (agentType === 'codex') {
    definition.sandbox = state.data?.choices?.codexSandboxes?.[0]?.value || 'read-only';
  }

  if (agentType === 'claude-code') {
    definition.permissionMode =
      state.data?.choices?.claudePermissionModes?.find((entry) => entry.value === 'bypassPermissions')?.value ||
      state.data?.choices?.claudePermissionModes?.[0]?.value ||
      '';
  }

  if (agentType === 'local-llm') {
    definition.localLlmConnection = optionalDraftText(config.localLlmConnection);
  }

  return definition;
}

function renderAiTestFields(agentType) {
  if (!isAiTestSupported(agentType)) {
    return '';
  }

  const config = state.aiManager?.testConfig || {};
  const fields = [];

  if (['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType)) {
    fields.push(
      renderModelField({
        inputId: 'ai-manager-model',
        inputName: 'model',
        agentType,
        value: config.model || '',
        modelMode: config.modelMode,
        modelModeInputName: 'modelMode',
        catalogScope: 'ai-manager',
        modelCatalog: state.aiManager?.modelCatalog || null,
      }),
    );
  }

  if (agentType === 'local-llm') {
    fields.push(`
      <div class="field field-full">
        <label>테스트 대상 연결</label>
        <div class="field-hint">${escapeHtml(describeSelectedLocalLlmConnection(config.localLlmConnection))}</div>
      </div>
    `);
  }

  if (agentType === 'local-llm' && !getLocalLlmConnectionEntries().length) {
    fields.push(`
      <div class="field field-full">
        <div class="field-hint">저장된 연결이 없습니다. 먼저 위에서 연결을 추가하세요.</div>
      </div>
    `);
  }

  return `<div class="form-grid">${fields.join('')}</div>`;
}

function renderAiCredentialFields(agentType) {
  if (!supportsAiCredentialEditing(agentType)) {
    return '';
  }

  const selectedConnection = resolveLocalLlmConnectionEntry(
    optionalDraftText(state.aiManager?.localLlmConnection) ||
      optionalDraftText(state.aiManager?.testConfig?.localLlmConnection),
  );
  return `
    <div class="form-grid">
      <div class="field field-full">
        <label>로컬 LLM 연결</label>
        <div class="field-hint">AI 목록의 각 로컬 LLM 항목이 연결 하나입니다. 여기서는 현재 항목만 수정합니다.</div>
        ${
          selectedConnection
            ? `<div class="local-llm-current">
                <strong>${escapeHtml(selectedConnection.name)}</strong>
                <span>${escapeHtml(selectedConnection.baseUrl)}</span>
                <span>${selectedConnection.apiKey ? 'API 키 설정됨' : 'API 키 없음'}${selectedConnection.description ? ` · ${escapeHtml(selectedConnection.description)}` : ''}</span>
              </div>`
            : ''
        }
        ${
          state.localLlmDraft
            ? renderLocalLlmConnectionEditor()
            : `<div class="actions env-editor-actions">
                <button type="button" class="btn-secondary btn-inline" data-action="edit-local-llm-connection" data-name="${escapeAttr(selectedConnection?.name || '')}" ${state.busy || !selectedConnection ? 'disabled' : ''}>현재 연결 수정</button>
                <button type="button" class="btn-secondary btn-inline" data-action="open-local-llm-modal" ${state.busy ? 'disabled' : ''}>신규 LLM 추가</button>
              </div>`
        }
      </div>
    </div>
  `;
}

function renderAiAuthFields(agentType) {
  const authConfig = state.aiManager?.authConfig || buildAiAuthDraft(agentType);
  if (agentType === 'claude-code') {
    return `
      <div class="form-grid">
        <div class="field">
          <label for="ai-manager-claude-login-mode">로그인 방식</label>
          <select id="ai-manager-claude-login-mode" name="claudeLoginMode" data-ai-auth-key="loginMode">
            <option value="claudeai" ${authConfig.loginMode !== 'console' ? 'selected' : ''}>claude.ai</option>
            <option value="console" ${authConfig.loginMode === 'console' ? 'selected' : ''}>console</option>
          </select>
          <div class="field-hint">claude.ai 는 개인 Claude 구독 계정이고, console 은 Anthropic Console 조직/API 계정입니다.</div>
        </div>
        <div class="field field-full">
          <label for="ai-manager-claude-callback-url">callback URL 전체 붙여넣기</label>
          <textarea
            id="ai-manager-claude-callback-url"
            name="claudeCallbackUrl"
            data-ai-auth-key="callbackUrl"
            placeholder="브라우저 로그인 완료 후 최종 callback URL 전체"
          >${escapeHtml(authConfig.callbackUrl || '')}</textarea>
          <div class="field-hint">번들 Claude Code CLI 로그인에서는 브라우저 인증 뒤 최종 callback URL 전체를 붙여넣습니다. 외부 CLI를 쓰는 경우에는 터미널에서 <code>claude auth login</code> 후 상태 확인만 누르면 됩니다.</div>
        </div>
      </div>
    `;
  }
  if (agentType === 'gemini-cli') {
    return `
      <div class="form-grid">
        <div class="field field-full">
          <label for="ai-manager-gemini-authorization-code">Authorization code 붙여넣기</label>
          <textarea
            id="ai-manager-gemini-authorization-code"
            name="geminiAuthorizationCode"
            data-ai-auth-key="authorizationCode"
            placeholder="브라우저 로그인 완료 후 표시된 authorization code"
          >${escapeHtml(authConfig.authorizationCode || '')}</textarea>
          <div class="field-hint">로그인 버튼을 누른 뒤 Google 브라우저 인증을 마치면 authorization code가 표시됩니다. 그 코드를 그대로 붙여넣고 로그인 완료를 누르세요.</div>
        </div>
      </div>
    `;
  }
  return '';
}

function buildAiAuthDraft(agentType) {
  if (agentType === 'claude-code') {
    return {
      loginMode: 'claudeai',
      callbackUrl: '',
    };
  }
  if (agentType === 'gemini-cli') {
    return {
      authorizationCode: '',
    };
  }
  return {};
}

function buildAiManagerAuthOptions(agentType) {
  if (agentType === 'claude-code') {
    const authConfig = state.aiManager?.authConfig || {};
    return {
      loginMode: authConfig.loginMode === 'console' ? 'console' : 'claudeai',
    };
  }
  if (agentType === 'gemini-cli') {
    const authConfig = state.aiManager?.authConfig || {};
    return {
      authorizationCode: optionalDraftText(authConfig.authorizationCode),
    };
  }
  return {};
}

function openLoginPopup() {
  try {
    return window.open('about:blank', '_blank');
  } catch {
    return null;
  }
}

function handleLoginLaunch(result, popup) {
  const url = optionalDraftText(result?.details?.url);
  if (!url) {
    if (popup && !popup.closed) {
      popup.close();
    }
    return;
  }

  if (popup && !popup.closed) {
    popup.location.replace(url);
  } else {
    window.open(url, '_blank');
  }
  if (result?.details?.requiresCode) {
    setNotice(
      'info',
      optionalDraftText(result?.details?.completionHint) ||
        '로그인 창을 열었습니다. 브라우저 인증 뒤 표시된 코드를 붙여넣고 로그인 완료를 누르세요.',
    );
    return;
  }
  if (result?.agentType === 'codex' && result?.details?.pendingLogin) {
    setNotice('info', '로그인 창을 열었습니다. 브라우저에서 완료하면 상태를 자동으로 다시 확인합니다.');
    return;
  }
  setNotice('info', '로그인 창을 열었습니다. 브라우저에서 완료한 뒤 상태 확인을 누르세요.');
}

function applyAiManagerAuthResult(agentType, result, action = 'status') {
  if (!state.aiManager || state.aiManager.type !== agentType) {
    return;
  }

  state.aiManager.authResult = result;
  if (action === 'logout') {
    state.aiManager.testResult = null;
  }
  if (action === 'status' && isAuthRequiredAgent(agentType) && !result?.details?.loggedIn) {
    state.aiManager.testResult = null;
  }
  syncAiStatus(agentType, state.aiManager);
}

function stopAiManagerStatusPolling() {
  aiManagerStatusPollSession += 1;
  if (aiManagerStatusPollTimer) {
    window.clearTimeout(aiManagerStatusPollTimer);
    aiManagerStatusPollTimer = null;
  }
}

function maybeResumeAiManagerStatusPolling(manager = state.aiManager) {
  if (
    manager?.type === 'codex' &&
    manager?.authResult?.details?.pendingLogin &&
    !manager?.authResult?.details?.loggedIn
  ) {
    startAiManagerStatusPolling('codex');
  }
}

function startAiManagerStatusPolling(agentType) {
  stopAiManagerStatusPolling();
  const sessionId = aiManagerStatusPollSession;
  let attempts = 0;

  const poll = async () => {
    if (sessionId !== aiManagerStatusPollSession) {
      return;
    }
    if (!state.aiManager || state.aiManager.type !== agentType) {
      stopAiManagerStatusPolling();
      return;
    }

    attempts += 1;
    try {
      const previousFingerprint = buildAiAuthResultFingerprint(state.aiManager?.authResult);
      const response = await requestJson('/api/agent-auth', {
        method: 'POST',
        body: {
          agentType,
          action: 'status',
        },
      });

      if (sessionId !== aiManagerStatusPollSession) {
        return;
      }
      applyAiManagerAuthResult(agentType, response.result, 'status');
      const nextFingerprint = buildAiAuthResultFingerprint(state.aiManager?.authResult);
      const statusChanged = previousFingerprint !== nextFingerprint;
      const loggedIn = Boolean(response.result?.details?.loggedIn);
      const pendingLogin = Boolean(response.result?.details?.pendingLogin);
      if (loggedIn) {
        stopAiManagerStatusPolling();
        setNotice('info', 'Codex 로그인 상태가 확인되었습니다.');
        render();
        return;
      }
      if (!pendingLogin || attempts >= AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS) {
        stopAiManagerStatusPolling();
        if (statusChanged) {
          render();
        }
        return;
      }
    } catch (error) {
      if (sessionId !== aiManagerStatusPollSession) {
        return;
      }
      if (handleAuthError(error)) {
        stopAiManagerStatusPolling();
        render();
        return;
      }
      if (attempts >= AI_MANAGER_STATUS_POLL_MAX_ATTEMPTS) {
        stopAiManagerStatusPolling();
        setNotice('error', localizeErrorMessage(error.message));
        render();
        return;
      }
    }

    aiManagerStatusPollTimer = window.setTimeout(
      poll,
      getAiManagerStatusPollDelay(attempts + 1),
    );
  };

  aiManagerStatusPollTimer = window.setTimeout(poll, getAiManagerStatusPollDelay(1));
}

function buildAiAuthResultFingerprint(result) {
  const details = result?.details || {};
  return JSON.stringify({
    summary: details.summary || '',
    pendingLogin: Boolean(details.pendingLogin),
    loggedIn: Boolean(details.loggedIn),
    runtimeReady: Boolean(details.runtimeReady),
    runtimeSource: details.runtimeSource || '',
    runtimeDetail: details.runtimeDetail || '',
    externalCli: Boolean(details.externalCli),
    commandHint: details.commandHint || '',
    configured: Boolean(details.configured),
    url: details.url || '',
    code: details.code || '',
    requiresCode: Boolean(details.requiresCode),
    completionHint: details.completionHint || '',
    output: result?.output || '',
  });
}

function buildAiCredentialDraft(agentType) {
  if (agentType === 'local-llm') {
    return {
      connections: [],
    };
  }
  return {};
}

async function loadModelCatalog(scope) {
  const payload = buildModelCatalogRequest(scope);
  const response = await mutateJson('/api/agent-models', {
    method: 'POST',
    body: payload,
  });

  if (scope === 'agent-wizard' && state.agentWizard) {
    state.agentWizard.modelCatalog = response.result;
  } else if (scope === 'ai-manager' && state.aiManager) {
    state.aiManager.modelCatalog = response.result;
  }

  setNotice('info', response.result?.summary || '모델 목록을 불러왔습니다.');
  render();
}

function buildModelCatalogRequest(scope) {
  if (scope === 'agent-wizard' && state.agentWizard) {
    const draft = state.agentWizard.draft || {};
    const payload = {
      agentType: optionalDraftText(draft.agent),
    };
    if (draft.agent === 'local-llm') {
      const selectedConnection = resolveLocalLlmConnectionEntry(
        optionalDraftText(draft.localLlmConnection),
      );
      const baseUrl = selectedConnection?.baseUrl || optionalDraftText(draft.baseUrl);
      if (baseUrl) {
        payload.baseUrl = baseUrl;
      }
    }
    return payload;
  }

  if (scope === 'ai-manager' && state.aiManager) {
    const payload = {
      agentType: optionalDraftText(state.aiManager.type),
    };
    if (state.aiManager.type === 'local-llm') {
      const selectedConnection = resolveLocalLlmConnectionEntry(
        optionalDraftText(state.aiManager.testConfig?.localLlmConnection),
      );
      if (selectedConnection?.baseUrl) {
        payload.baseUrl = selectedConnection.baseUrl;
      }
    }
    return payload;
  }

  throw new Error('모델 목록을 불러올 대상을 찾지 못했습니다.');
}

function applyDefaultModelSelection(scope) {
  const catalog =
    scope === 'agent-wizard'
      ? state.agentWizard?.modelCatalog
      : scope === 'ai-manager'
        ? state.aiManager?.modelCatalog
        : null;
  const model =
    optionalDraftText(catalog?.defaultModel) ||
    optionalDraftText(catalog?.models?.[0]?.value);
  if (!model) {
    throw new Error('적용할 기본 모델이 없습니다.');
  }
  applyModelSelection(scope, model);
}

function applyModelSelection(scope, model) {
  const resolvedModel = optionalDraftText(model);
  if (!resolvedModel) {
    return;
  }

  if (scope === 'agent-wizard' && state.agentWizard) {
    state.agentWizard.draft.modelMode = 'custom';
    state.agentWizard.draft.model = resolvedModel;
    state.agentWizard.draft.effort = normalizeEffortValue(
      state.agentWizard.draft.agent,
      resolvedModel,
      state.agentWizard.draft.effort,
    );
    render();
    return;
  }

  if (scope === 'ai-manager' && state.aiManager) {
    state.aiManager.testConfig.modelMode = 'custom';
    state.aiManager.testConfig.model = resolvedModel;
    render();
  }
}

function renderModelCatalogResult(modelCatalog, scope, selectedModel) {
  if (!modelCatalog) {
    return '';
  }

  const models = Array.isArray(modelCatalog.models) ? modelCatalog.models : [];
  if (!models.length) {
    return `
      <div class="wizard-result">
        <strong>${escapeHtml(modelCatalog.summary || '조회된 모델이 없습니다.')}</strong>
      </div>
    `;
  }

  return `
    <div class="wizard-result">
      <strong>${escapeHtml(modelCatalog.summary || '모델 목록')}</strong>
      <div class="field-hint">
        ${escapeHtml(modelCatalog.source === 'live' ? '실시간 조회 결과' : '권장 기본값 목록')}
        ${modelCatalog.defaultModel ? ` · 기본 추천 ${escapeHtml(modelCatalog.defaultModel)}` : ''}
      </div>
      <div class="option-list">
        ${models
          .map((entry) => {
            const modelValue = optionalDraftText(entry?.value);
            const isActive = optionalDraftText(selectedModel) === modelValue;
            return `
              <button
                type="button"
                class="option-chip ${isActive ? 'is-active' : ''}"
                data-action="apply-model-suggestion"
                data-scope="${escapeAttr(scope)}"
                data-model="${escapeAttr(modelValue)}"
                ${state.busy ? 'disabled' : ''}
              >
                ${escapeHtml(entry?.label || modelValue)}
              </button>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function supportsAiCredentialEditing(agentType) {
  return ['local-llm'].includes(agentType);
}

function supportsModelCatalogLookup(agentType) {
  return ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
}

function isAiStatusSupported(agentType) {
  return ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
}

function renderModelField({
  inputId,
  inputName,
  agentType,
  value,
  modelMode = defaultModelModeForAgent(agentType),
  modelModeInputName = 'modelMode',
  catalogScope = '',
  modelCatalog = null,
}) {
  const examples = getModelExamples(agentType);
  const placeholder = examples[0] || '';
  const canUseDefault = supportsDefaultModelMode(agentType);
  const canLookupCatalog = supportsModelCatalogLookup(agentType);
  return `
    <div class="field field-full">
      <label for="${escapeAttr(inputId)}">${renderRequiredLabel('모델')}</label>
      ${
        canUseDefault
          ? `
              <select name="${escapeAttr(modelModeInputName)}">
                <option value="default" ${modelMode !== 'custom' ? 'selected' : ''}>default</option>
                <option value="custom" ${modelMode === 'custom' ? 'selected' : ''}>custom</option>
              </select>
            `
          : ''
      }
      ${
        !canUseDefault || modelMode === 'custom'
          ? `
              <input
                id="${escapeAttr(inputId)}"
                name="${escapeAttr(inputName)}"
                value="${escapeAttr(value || '')}"
                placeholder="${escapeAttr(placeholder)}"
              />
              ${renderFormError('agentWizard', inputName)}
            `
          : ''
      }
      ${
        canUseDefault && modelMode !== 'custom'
          ? '<div class="field-hint">기본 모델 사용</div>'
          : ''
      }
      ${examples.length ? `<div class="field-hint">예: ${escapeHtml(examples.join(', '))}</div>` : ''}
      ${
        canLookupCatalog
          ? `
              <div class="wizard-auth-actions">
                <button
                  type="button"
                  class="btn-secondary"
                  data-action="load-model-catalog"
                  data-scope="${escapeAttr(catalogScope)}"
                  ${state.busy ? 'disabled' : ''}
                >
                  모델 불러오기
                </button>
                ${
                  modelCatalog?.defaultModel
                    ? `<button
                        type="button"
                        class="btn-secondary"
                        data-action="apply-default-model"
                        data-scope="${escapeAttr(catalogScope)}"
                        ${state.busy ? 'disabled' : ''}
                      >
                        권장 기본값 적용
                      </button>`
                    : ''
                }
              </div>
            `
          : ''
      }
      ${renderModelCatalogResult(modelCatalog, catalogScope, value)}
    </div>
  `;
}

function renderEffortField(draft) {
  const efforts = getEffortChoices(draft.agent, draft.model);
  if (!efforts.length) {
    return '';
  }

  return `
    <div class="field ${fieldErrorClass('agentWizard', 'effort')}">
      <label for="wizard-agent-effort">추론 강도</label>
      <select id="wizard-agent-effort" name="effort">
        <option value="">기본값</option>
        ${efforts
          .map(
            (value) =>
              `<option value="${escapeAttr(value)}" ${value === draft.effort ? 'selected' : ''}>${escapeHtml(localizeEffortLabel(value))}</option>`,
          )
          .join('')}
      </select>
      ${renderFormError('agentWizard', 'effort')}
    </div>
  `;
}

function createConnectorDraft(connector) {
  return {
    currentName: connector?.name || '',
    name: connector?.name || '',
    type: connector?.type || 'kakao',
    description: connector?.description || '',
    discordToken: connector?.discordToken || '',
    telegramBotToken: connector?.telegramBotToken || '',
    kakaoRelayUrl: connector?.kakaoRelayUrl || getDefaultKakaoRelayUrl(),
    kakaoRelayToken: connector?.kakaoRelayToken || '',
    kakaoSessionToken: connector?.kakaoSessionToken || '',
  };
}

function createBlankConnector() {
  return createConnectorDraft({
    type: 'kakao',
    kakaoRelayUrl: getDefaultKakaoRelayUrl(),
  });
}

function createBlankChannel() {
  return {
    platform: 'discord',
    connector: getDefaultConnectorNameForPlatform('discord'),
    name: '',
    mode: 'single',
    discordChannelId: '',
    guildId: '',
    telegramChatId: '',
    telegramThreadId: '',
    kakaoChannelId: '*',
    kakaoUserId: '',
    workspace: getDefaultChannelWorkspace(),
    ownerWorkspace: '',
    reviewerWorkspace: '',
    arbiterWorkspace: '',
    agent: state.data.agents?.[0]?.name || '',
    reviewer: '',
    arbiter: '',
    reviewRounds: '',
    description: '',
  };
}

function getDefaultChannelWorkspace() {
  return state.data?.defaults?.channelWorkspace || DEFAULT_CHANNEL_WORKSPACE;
}

function parseListText(rawValue) {
  return String(rawValue || '')
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createLocalLlmConnectionEntry(
  name = 'LLM1',
  baseUrl = 'http://127.0.0.1:11434/v1',
  apiKey = '',
  description = '',
) {
  return {
    name: String(name),
    baseUrl: String(baseUrl),
    apiKey: String(apiKey),
    description: String(description),
  };
}

function createLocalLlmConnectionDraft(entry = null) {
  const source = entry || createLocalLlmConnectionEntry(`LLM${getLocalLlmConnectionEntries().length + 1}`);
  return {
    currentName: entry?.name || '',
    name: source.name || '',
    baseUrl: source.baseUrl || 'http://127.0.0.1:11434/v1',
    apiKey: source.apiKey || '',
    description: source.description || '',
  };
}

function normalizeLocalLlmConnectionEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [createLocalLlmConnectionEntry()];
  }
  return entries.map((entry, index) =>
    createLocalLlmConnectionEntry(
      entry?.name || `LLM${index + 1}`,
      entry?.baseUrl,
      entry?.apiKey,
      entry?.description,
    ),
  );
}

function parseLocalLlmConnectionEntries(entries) {
  const output = [];
  const usedNames = new Set();

  for (const [index, entry] of normalizeLocalLlmConnectionEntries(entries).entries()) {
    const name = String(entry.name || '').trim();
    const baseUrl = String(entry.baseUrl || '').trim();
    const apiKey = String(entry.apiKey || '');
    const description = String(entry.description || '').trim();
    if (!name) {
      throw new Error(`로컬 LLM 연결 ${index + 1}의 이름을 입력하세요.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new Error(`로컬 LLM 연결 "${name}" 이름 형식이 올바르지 않습니다.`);
    }
    if (usedNames.has(name)) {
      throw new Error(`로컬 LLM 연결 이름 "${name}"이 중복되었습니다.`);
    }
    if (!baseUrl) {
      throw new Error(`로컬 LLM 연결 "${name}"의 주소를 입력하세요.`);
    }
    usedNames.add(name);
    output.push({
      name,
      baseUrl,
      apiKey,
      description,
    });
  }

  return output;
}

function upsertLocalLlmConnectionEntries(entries, draft) {
  const currentName = optionalDraftText(draft.currentName);
  const nextEntries = normalizeLocalLlmConnectionEntries(entries).map((entry) =>
    currentName && entry.name === currentName ? createLocalLlmConnectionEntry(draft.name, draft.baseUrl, draft.apiKey, draft.description) : entry,
  );
  if (!currentName) {
    nextEntries.push(
      createLocalLlmConnectionEntry(draft.name, draft.baseUrl, draft.apiKey, draft.description),
    );
  }
  return parseLocalLlmConnectionEntries(nextEntries);
}

function renderLocalLlmConnectionList(entries) {
  const normalized = normalizeLocalLlmConnectionEntries(entries);
  return `
    <div class="card-list">
        ${normalized
          .map(
            (entry) => `
              <article class="card">
                <div class="card-main">
                  ${renderCardTitle('ai', entry.name, 'violet')}
                  ${renderMetaText(entry.baseUrl)}
                  <div class="field-hint">${entry.apiKey ? 'API 키 설정됨' : 'API 키 없음'}${entry.description ? ` · ${escapeHtml(entry.description)}` : ''}</div>
                </div>
                <div class="inline-actions">
                  <button type="button" class="btn-secondary" data-action="edit-local-llm-connection" data-name="${escapeAttr(entry.name)}" ${state.busy ? 'disabled' : ''}>${renderButtonLabel('edit', '수정')}</button>
                  <button type="button" class="btn-danger" data-action="delete-local-llm-connection" data-name="${escapeAttr(entry.name)}" ${state.busy || normalized.length <= 1 ? 'disabled' : ''}>${renderButtonLabel('trash', '삭제')}</button>
                </div>
              </article>
            `,
          )
          .join('')}
    </div>
  `;
}

function getLocalLlmConnectionEntries() {
  const entries = state.data?.localLlmConnections;
  return normalizeLocalLlmConnectionEntries(entries);
}

function getDefaultLocalLlmConnectionName() {
  return getLocalLlmConnectionEntries()[0]?.name || '';
}

function getConnectorEntries(platform = '') {
  const selectedPlatform = optionalDraftText(platform);
  return (state.data?.connectors || [])
    .filter((entry) => !selectedPlatform || entry.type === selectedPlatform)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getDefaultConnectorNameForPlatform(platform = '') {
  return getConnectorEntries(platform)[0]?.name || '';
}

function renderConnectorOptions(platform, selectedValue, allowEmpty = false) {
  const selected = optionalDraftText(selectedValue);
  const entries = getConnectorEntries(platform);
  const options = [];
  if (allowEmpty) {
    options.push(`<option value="" ${!selected ? 'selected' : ''}>호환 모드: 에이전트 내 연결 설정</option>`);
  }
  for (const entry of entries) {
    options.push(
      `<option value="${escapeAttr(entry.name)}" ${selected === entry.name ? 'selected' : ''}>${escapeHtml(entry.name)} · ${escapeHtml(localizeMessagingPlatform(entry.type))}</option>`,
    );
  }
  return options.join('');
}

function resolveLocalLlmConnectionEntry(name) {
  const selected = optionalDraftText(name);
  return getLocalLlmConnectionEntries().find((entry) => entry.name === selected) || null;
}

function renderLocalLlmConnectionOptions(selectedValue, allowCustom = false) {
  const selected = optionalDraftText(selectedValue);
  const entries = getLocalLlmConnectionEntries();
  const options = entries.map(
    (entry) =>
      `<option value="${escapeAttr(entry.name)}" ${selected === entry.name ? 'selected' : ''}>${escapeHtml(entry.name)} · ${escapeHtml(entry.baseUrl)}</option>`,
  );
  if (allowCustom) {
    options.push(
      `<option value="" ${!selected ? 'selected' : ''}>직접 입력</option>`,
    );
  }
  return options.join('');
}

function describeSelectedLocalLlmConnection(selectedValue) {
  const selected = optionalDraftText(selectedValue);
  const entry = getLocalLlmConnectionEntries().find((item) => item.name === selected);
  if (!entry) {
    return '저장된 연결을 고르면 그 주소와 API 키를 그대로 사용합니다.';
  }
  return `${entry.name} -> ${entry.baseUrl}${entry.apiKey ? ' · API 키 설정됨' : ''}`;
}

function agentTypeUsesLocalLlmConnections(agentType) {
  return agentType === 'local-llm';
}

function requiredText(formData, key) {
  const value = optionalText(formData, key);
  if (!value) {
    throw new Error(`${localizeFieldName(key)} 항목은 필수입니다.`);
  }
  return value;
}

function requiredDraftText(value, key) {
  const normalized = optionalDraftText(value);
  if (!normalized) {
    throw new Error(`${localizeFieldName(key)} 항목은 필수입니다.`);
  }
  return normalized;
}

function optionalDraftText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function getDefaultKakaoRelayUrl() {
  return optionalDraftText(state.data?.defaults?.kakaoRelayUrl) || FALLBACK_KAKAO_RELAY_URL;
}

function optionalText(formData, key) {
  const value = formData.get(key);
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function renderOptions(options, selectedValue, allowEmpty = false) {
  const entries = [];
  if (allowEmpty) {
    entries.push('<option value="">선택 안 함</option>');
  }
  for (const option of options || []) {
    entries.push(
      `<option value="${escapeAttr(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${escapeHtml(localizeOptionLabel(option))}</option>`,
    );
  }
  return entries.join('');
}

function renderNameOptions(names, selectedValue, allowEmpty = false) {
  const entries = [];
  if (allowEmpty) {
    entries.push('<option value="">선택 안 함</option>');
  }
  for (const name of names) {
    entries.push(
      `<option value="${escapeAttr(name)}" ${name === selectedValue ? 'selected' : ''}>${escapeHtml(name)}</option>`,
    );
  }
  return entries.join('');
}

function localizeKind(kind) {
  if (kind === 'agent') {
    return '에이전트';
  }
  if (kind === 'connector') {
    return '커넥터';
  }
  if (kind === 'channel') {
    return '채널';
  }
  if (kind === 'dashboard') {
    return '대시보드';
  }
  return kind;
}

function localizeChannelMode(value) {
  if (value === 'tribunal') {
    return 'Tribunal';
  }
  if (value === 'single') {
    return '단일';
  }
  return value || '';
}

function localizeMessagingPlatform(value) {
  if (value === 'kakao') {
    return 'KakaoTalk';
  }
  if (value === 'telegram') {
    return 'Telegram';
  }
  if (value === 'discord') {
    return 'Discord';
  }
  return value || '';
}

function describeChannelTarget(channel) {
  const platform = channel?.platform || 'discord';
  if (platform === 'telegram') {
    const threadSuffix = channel?.telegramThreadId ? ` / ${channel.telegramThreadId}` : '';
    return `${channel?.telegramChatId || '-'}${threadSuffix}`;
  }
  if (platform === 'kakao') {
    const userSuffix = channel?.kakaoUserId ? ` / ${channel.kakaoUserId}` : '';
    return `${channel?.kakaoChannelId || '*'}${userSuffix}`;
  }
  const guildSuffix = channel?.guildId ? ` / ${channel.guildId}` : '';
  return `${channel?.discordChannelId || '-'}${guildSuffix}`;
}

function describeChannelConnector(channel) {
  return channel?.connector ? `커넥터 ${channel.connector}` : '호환 연결';
}

function describeChannelWorkspace(channel) {
  const baseWorkspace = channel?.workspace || getDefaultChannelWorkspace();
  const overrides = [
    channel?.ownerWorkspace ? `owner=${channel.ownerWorkspace}` : null,
    channel?.reviewerWorkspace ? `reviewer=${channel.reviewerWorkspace}` : null,
    channel?.arbiterWorkspace ? `arbiter=${channel.arbiterWorkspace}` : null,
  ].filter(Boolean);
  return overrides.length > 0
    ? `${baseWorkspace} · ${overrides.join(' · ')}`
    : baseWorkspace;
}

function localizeRuntimeStatus(value) {
  if (value === 'completed') {
    return '최근 완료';
  }
  if (value === 'failed') {
    return '실패';
  }
  if (value === 'owner_running') {
    return 'owner 실행 중';
  }
  if (value === 'reviewer_running') {
    return 'reviewer 실행 중';
  }
  if (value === 'arbiter_running') {
    return 'arbiter 실행 중';
  }
  if (value === 'awaiting_revision') {
    return '수정 대기';
  }
  if (value === 'queued') {
    return '대기';
  }
  return value || '';
}

function localizeRuntimeBackend(value) {
  if (value === 'claude-cli') {
    return 'Claude CLI';
  }
  return value || 'backend 없음';
}

function localizeSessionPolicy(value) {
  if (value === 'sticky') {
    return 'sticky';
  }
  if (value === 'ephemeral') {
    return 'ephemeral';
  }
  return value || 'policy 없음';
}

function formatRuntimeSessionId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

function localizeReviewerVerdict(value) {
  if (value === 'approved') {
    return '승인';
  }
  if (value === 'blocked') {
    return '수정 필요';
  }
  if (value === 'invalid') {
    return '판정 오류';
  }
  return value || '';
}

function resolveRuntimeChipClass(status) {
  if (status === 'completed') {
    return 'mini-chip--ok';
  }
  if (status === 'failed') {
    return 'mini-chip--danger';
  }
  return '';
}

function localizeAgentTypeValue(value) {
  const labels = {
    codex: 'Codex',
    'claude-code': 'Claude Code CLI',
    'gemini-cli': 'Gemini CLI',
    'local-llm': '로컬 LLM',
    command: '사용자 명령어',
  };
  return labels[value] || value || '';
}

function localizeEffortLabel(value) {
  const labels = {
    none: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  };
  return labels[value] || value || '';
}

function localizeAiMeta(value) {
  const labels = {
    codex: '로컬 Codex 로그인 공유 · 테스트',
    'claude-code': 'Claude CLI 로그인 공유 · 테스트',
    'gemini-cli': 'Google 로그인 · 테스트',
    'local-llm': '연결별 관리 · 테스트',
    command: '명령 테스트',
  };
  return labels[value] || '';
}

function isAuthRequiredAgent(agentType) {
  return ['codex'].includes(agentType);
}

function isAiAuthSupported(agentType) {
  return ['codex', 'claude-code', 'gemini-cli'].includes(agentType);
}

function isAiTestSupported(agentType) {
  return ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
}

function defaultModelModeForAgent(agentType) {
  return supportsDefaultModelMode(agentType) ? 'default' : 'custom';
}

function supportsDefaultModelMode(agentType) {
  return ['codex', 'claude-code', 'gemini-cli'].includes(agentType);
}

function resolveConfiguredModel(agentType, config) {
  if (agentType === 'local-llm') {
    return requiredDraftText(config?.model, 'model');
  }
  if (supportsDefaultModelMode(agentType)) {
    return optionalDraftText(config?.modelMode) === 'custom'
      ? requiredDraftText(config?.model, 'model')
      : '';
  }
  return optionalDraftText(config?.model);
}

function syncAiStatus(agentType, value) {
  state.aiStatuses[agentType] = {
    authResult: value?.authResult || null,
    testResult: value?.testResult || null,
    usageSummary: value?.usageSummary || state.aiStatuses[agentType]?.usageSummary || null,
  };
}

function mergeAiStatuses(currentStatuses, nextStatuses) {
  const output = { ...(currentStatuses || {}) };
  for (const [agentType, status] of Object.entries(nextStatuses || {})) {
    output[agentType] = {
      authResult: status?.authResult || null,
      testResult: output[agentType]?.testResult || null,
      usageSummary: status?.usageSummary || output[agentType]?.usageSummary || null,
    };
  }
  return output;
}

function formatTokenCount(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toLocaleString('ko-KR') : '0';
}

function formatUsageBreakdownLabel(value, field) {
  const text = String(value || '').trim();
  if (text) {
    return text;
  }
  if (field === 'model') {
    return '(기본값/미기록)';
  }
  if (field === 'agentName') {
    return '(미지정 에이전트)';
  }
  return '(미기록)';
}

function renderUsageBreakdownPanel(entries, { field, emptyText = '기록이 없습니다.' } = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) {
    return `<div class="field-hint">${escapeHtml(emptyText)}</div>`;
  }

  const topEntries = list.slice(0, 8);
  const tableEntries = list.slice(0, 12);
  const maxTokens = Math.max(...topEntries.map((entry) => Number(entry.totalTokens || 0)), 1);

  return `
    <div class="usage-breakdown-panel">
      <div class="usage-breakdown-bars">
        ${topEntries
          .map((entry) => {
            const totalTokens = Number(entry.totalTokens || 0);
            const width =
              totalTokens > 0 ? Math.max(4, Math.round((totalTokens / maxTokens) * 100)) : 0;
            const label = formatUsageBreakdownLabel(entry[field], field);
            return `
              <div class="usage-breakdown-bar-row">
                <div class="usage-breakdown-label-row">
                  <span class="usage-breakdown-label" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
                  <strong class="usage-breakdown-total">${escapeHtml(formatTokenCount(totalTokens))}</strong>
                </div>
                <div class="usage-breakdown-bar-track">
                  <div class="usage-breakdown-bar" style="width:${width}%"></div>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
      <div class="usage-breakdown-table">
        <div class="usage-breakdown-table-head">
          <span>${field === 'model' ? '모델' : '에이전트'}</span>
          <span>기록</span>
          <span>입력</span>
          <span>출력</span>
          <span>총합</span>
        </div>
        <div class="usage-breakdown-table-body">
          ${tableEntries
            .map((entry) => {
              const label = formatUsageBreakdownLabel(entry[field], field);
              return `
                <div class="usage-breakdown-table-row">
                  <span class="usage-breakdown-table-name" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
                  <span>${escapeHtml(formatTokenCount(entry.recordedEvents))}</span>
                  <span>${escapeHtml(formatTokenCount(entry.inputTokens))}</span>
                  <span>${escapeHtml(formatTokenCount(entry.outputTokens))}</span>
                  <strong>${escapeHtml(formatTokenCount(entry.totalTokens))}</strong>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function formatRelativeDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || '');
  }
  return date.toLocaleString('ko-KR');
}

function isAiReady(agentType, status) {
  const ready = status?.authResult?.details?.ready;
  if (typeof ready === 'boolean') {
    return ready;
  }
  const loggedIn = Boolean(status?.authResult?.details?.loggedIn);
  const testOk = Boolean(status?.testResult?.details?.success);
  return isAiAuthSupported(agentType) ? loggedIn : testOk;
}

function usesModelField(agentType) {
  return ['codex', 'claude-code', 'gemini-cli', 'local-llm'].includes(agentType);
}

function getEffortChoices(agentType, model) {
  const id = String(model || '').trim().toLowerCase();
  if (agentType === 'claude-code') {
    return ['low', 'medium', 'high', 'max'];
  }
  if (agentType === 'codex') {
    if (!id) {
      return ['low', 'medium', 'high'];
    }
    if (id === 'gpt-5-pro' || id.startsWith('gpt-5-pro-')) {
      return ['high'];
    }
    if (
      id === 'gpt-5.2-pro' ||
      id.startsWith('gpt-5.2-pro-') ||
      id === 'gpt-5.4-pro' ||
      id.startsWith('gpt-5.4-pro-')
    ) {
      return ['medium', 'high', 'xhigh'];
    }
    if (id.includes('codex')) {
      return ['low', 'medium', 'high', 'xhigh'];
    }
    if (
      id.startsWith('gpt-5.2') ||
      id.startsWith('gpt-5.4') ||
      id.startsWith('gpt-5.4-mini') ||
      id.startsWith('gpt-5.4-nano')
    ) {
      return ['none', 'low', 'medium', 'high', 'xhigh'];
    }
    if (id.startsWith('gpt-5.1')) {
      return ['none', 'low', 'medium', 'high'];
    }
    if (
      id === 'gpt-5' ||
      id.startsWith('gpt-5-') ||
      id.startsWith('gpt-5-mini') ||
      id.startsWith('gpt-5-nano')
    ) {
      return ['minimal', 'low', 'medium', 'high'];
    }
    return [];
  }
  if (agentType === 'gemini-cli') {
    if (!id) {
      return ['minimal', 'low', 'medium', 'high'];
    }
    if (id.startsWith('gemini-2.5-pro')) {
      return ['minimal', 'low', 'medium', 'high'];
    }
    if (id.startsWith('gemini-2.5')) {
      return ['none', 'minimal', 'low', 'medium', 'high'];
    }
    if (id.startsWith('gemini-3')) {
      return ['minimal', 'low', 'medium', 'high'];
    }
    return ['minimal', 'low', 'medium', 'high'];
  }
  return [];
}

function getModelExamples(agentType) {
  if (agentType === 'codex') {
    return ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini'];
  }
  if (agentType === 'claude-code') {
    return ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
  }
  if (agentType === 'gemini-cli') {
    return ['gemini-2.5-pro', 'gemini-2.5-flash'];
  }
  if (agentType === 'local-llm') {
    return ['qwen2.5-coder:14b', 'llama3.1:8b'];
  }
  return [];
}

function normalizeEffortValue(agentType, model, effort) {
  const value = optionalDraftText(effort);
  if (!value) {
    return '';
  }
  const efforts = getEffortChoices(agentType, model);
  return efforts.includes(value) ? value : '';
}

function localizeOptionLabel(option) {
  const labels = {
    codex: 'Codex',
    'claude-code': 'Claude Code CLI',
    'gemini-cli': 'Gemini CLI',
    'local-llm': '로컬 LLM',
    command: '사용자 명령어',
    single: '단일',
    tribunal: 'Tribunal',
    'workspace-write': '워크스페이스 쓰기',
    'read-only': '읽기 전용',
    'danger-full-access': '전체 접근',
    bypassPermissions: '권한 확인 없음',
    default: '기본값',
    acceptEdits: '수정 허용',
    dontAsk: '묻지 않음',
    plan: '계획',
    auto: '자동',
  };
  return labels[option?.value] || option?.label || option?.value || '';
}

function localizeFieldName(key) {
  const fields = {
    password: '비밀번호',
    currentPassword: '현재 비밀번호',
    newPassword: '새 비밀번호',
    confirmPassword: '새 비밀번호 확인',
    name: '이름',
    type: '타입',
    description: '설명',
    platform: '플랫폼',
    connector: '연결 커넥터',
    mode: '채널 모드',
    agent: '에이전트',
    discordToken: 'Discord 토큰',
    telegramBotToken: 'Telegram 봇 토큰',
    kakaoRelayUrl: 'Kakao 연결 릴레이 URL',
    kakaoRelayToken: 'Kakao 연결 토큰',
    kakaoSessionToken: 'Kakao 세션 토큰',
    model: '모델',
    command: '명령어',
    discordChannelId: '디스코드 채널 ID',
    telegramChatId: 'Telegram 채팅 ID',
    telegramThreadId: 'Telegram 스레드 ID',
    kakaoChannelId: 'Kakao 수신 channelId 필터',
    kakaoUserId: 'Kakao 사용자 ID 필터',
    workspace: '워크스페이스',
    ownerWorkspace: 'owner 워크스페이스',
    reviewerWorkspace: 'reviewer 워크스페이스',
    arbiterWorkspace: 'arbiter 워크스페이스',
    workdir: '작업경로',
  };
  return fields[key] || key;
}

function localizeErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) {
    return '오류가 발생했습니다.';
  }

  const duplicateMatch = text.match(/^(Agent|Bot|Connector|Channel|Dashboard) "(.+)" already exists\.$/u);
  if (duplicateMatch) {
    return `${localizeKind(duplicateMatch[1].toLowerCase())} "${duplicateMatch[2]}"이(가) 이미 있습니다.`;
  }

  const referencedMatch = text.match(/^Agent "(.+)" is referenced by (.+)\.$/u);
  if (referencedMatch) {
    return `에이전트 "${referencedMatch[1]}"이(가) 다른 항목에서 사용 중입니다.`;
  }

  const referencedConnectorMatch = text.match(/^Connector "(.+)" is referenced by channels: (.+)\.$/u);
  if (referencedConnectorMatch) {
    return `커넥터 "${referencedConnectorMatch[1]}"은(는) 채널에서 사용 중입니다: ${referencedConnectorMatch[2]}.`;
  }

  const legacyConnectorMatch = text.match(/^Connector "(.+)" is derived from legacy agent platform settings;/u);
  if (legacyConnectorMatch) {
    return `커넥터 "${legacyConnectorMatch[1]}"은(는) legacy 에이전트 연결에서 자동 생성된 항목입니다. 에이전트 연결 설정을 먼저 수정하세요.`;
  }

  const unknownAgentMatch = text.match(/^Channel references unknown agent "(.+)"\.$/u);
  if (unknownAgentMatch) {
    return `없는 에이전트입니다: "${unknownAgentMatch[1]}".`;
  }

  const unknownConnectorMatch = text.match(/^Channel references unknown connector "(.+)"\.$/u);
  if (unknownConnectorMatch) {
    return `없는 커넥터입니다: "${unknownConnectorMatch[1]}".`;
  }

  const kakaoOverlapMatch = text.match(/^Kakao channel "(.+)" overlaps with "(.+)" for (.+)\./u);
  if (kakaoOverlapMatch) {
    return `Kakao 채널 "${kakaoOverlapMatch[1]}"의 라우팅 필터가 "${kakaoOverlapMatch[2]}"와 겹칩니다. channelId 또는 사용자 ID 필터를 좁혀주세요.`;
  }

  if (text === 'Password is required.') {
    return '비밀번호를 입력하세요.';
  }
  if (text === 'New password is required.') {
    return '새 비밀번호를 입력하세요.';
  }
  if (text === 'Current password is required.') {
    return '현재 비밀번호를 입력하세요.';
  }
  if (text === 'Current password is invalid.') {
    return '현재 비밀번호가 맞지 않습니다.';
  }
  if (text === 'New password must be at least 8 characters.') {
    return '새 비밀번호는 8자 이상이어야 합니다.';
  }
  if (text === '비밀번호 확인이 일치하지 않습니다.') {
    return text;
  }
  if (text === 'workspace is required.') {
    return '워크스페이스를 입력하세요.';
  }
  if (text === '사용 가능한 AI만 선택할 수 있습니다.') {
    return text;
  }
  if (/^Unsupported channel mode /u.test(text)) {
    return '지원하지 않는 채널 모드입니다.';
  }
  if (/^Workspace does not exist: /u.test(text)) {
    return text.replace(/^Workspace does not exist: /u, '없는 워크스페이스입니다: ');
  }
  if (/^Workspace must be a directory: /u.test(text)) {
    return text.replace(/^Workspace must be a directory: /u, '워크스페이스는 디렉터리여야 합니다: ');
  }
  if (/^Model listing is not supported for agent type /u.test(text)) {
    return '이 AI 유형은 모델 목록 조회를 지원하지 않습니다.';
  }
  if (text === 'OPENAI_API_KEY is required for codex model listing.') {
    return 'OPENAI_API_KEY 가 필요합니다.';
  }
  if (/^Invalid JSON response from /u.test(text)) {
    return text.replace(/^Invalid JSON response from /u, '모델 목록 응답이 올바르지 않습니다: ');
  }
  if (text === 'workdir is required.') {
    return '작업경로를 입력하세요.';
  }
  if (text === 'discordChannelId is required.') {
    return '디스코드 채널 ID를 입력하세요.';
  }
  if (text === 'telegramChatId is required.') {
    return 'Telegram 채팅 ID를 입력하세요.';
  }
  if (text === 'kakaoChannelId is required.') {
    return 'Kakao 수신 channelId 필터를 입력하세요.';
  }
  if (text === 'Reviewer must be different from the owner agent.') {
    return 'reviewer 는 owner 와 달라야 합니다.';
  }
  if (text === 'Arbiter must be different from the owner agent.') {
    return 'arbiter 는 owner 와 달라야 합니다.';
  }
  if (text === 'Arbiter must be different from the reviewer agent.') {
    return 'arbiter 는 reviewer 와 달라야 합니다.';
  }
  if (text === 'Tribunal channel requires a reviewer.') {
    return '검토 에이전트가 필요합니다.';
  }
  if (text === 'Tribunal channel requires an arbiter.') {
    return '중재 에이전트가 필요합니다.';
  }
  if (text === 'Single channel cannot define a reviewer.') {
    return '단일 채널에서는 검토 에이전트를 지정할 수 없습니다.';
  }
  if (text === 'Single channel cannot define an arbiter.') {
    return '단일 채널에서는 중재 에이전트를 지정할 수 없습니다.';
  }
  if (text === 'reviewRounds must be a positive integer.') {
    return '검토 회차는 1 이상의 정수만 가능합니다.';
  }
  if (text === 'reviewRounds requires a tribunal channel.') {
    return '검토 회차는 검토와 중재가 함께 있을 때만 사용할 수 있습니다.';
  }
  if (text === 'fallbackAgent must be different from the agent.') {
    return '폴백은 자기 자신으로 설정할 수 없습니다.';
  }
  if (text === 'timeoutMs must be a positive integer.') {
    return '제한 시간은 1 이상의 정수만 가능합니다.';
  }
  if (text === 'At least one local LLM connection is required.') {
    return '로컬 LLM 연결은 최소 하나 이상 필요합니다.';
  }
  if (/^Agent "(.+)" references unknown local LLM connection "(.+)"\.$/u.test(text)) {
    const [, agentName, connectionName] =
      text.match(/^Agent "(.+)" references unknown local LLM connection "(.+)"\.$/u) || [];
    return `에이전트 "${agentName}"이(가) 없는 로컬 LLM 연결 "${connectionName}"을 참조합니다.`;
  }
  if (/^Local LLM connection "(.+)" requires a baseUrl\.$/u.test(text)) {
    const [, connectionName] =
      text.match(/^Local LLM connection "(.+)" requires a baseUrl\.$/u) || [];
    return `로컬 LLM 연결 "${connectionName}"의 주소가 필요합니다.`;
  }
  if (/^Local LLM connection "(.+)" already exists\.$/u.test(text)) {
    const [, connectionName] =
      text.match(/^Local LLM connection "(.+)" already exists\.$/u) || [];
    return `로컬 LLM 연결 "${connectionName}"이(가) 이미 있습니다.`;
  }
  if (/^Unsupported effort ".+" for agent ".+" model ".+"\.$/u.test(text)) {
    return '선택한 모델에서 지원하지 않는 추론 강도입니다.';
  }
  if (text === 'local-llm agents require a model.') {
    return '로컬 LLM은 모델이 필요합니다.';
  }
  if (text === 'command agents require a command.') {
    return '사용자 명령어는 명령어 값이 필요합니다.';
  }
  if (/^Auth actions are not supported for agent type ".+"\.$/u.test(text)) {
    return '이 AI 유형은 인증 관리를 지원하지 않습니다.';
  }
  if (text === '이 AI 유형은 상태 확인을 지원하지 않습니다.') {
    return text;
  }
  if (/^codex is unavailable\. Bundled dependency @openai\/codex is required/u.test(text)) {
    return 'codex 번들이 설치되어 있지 않습니다.';
  }
  if (/^claude is unavailable\. Bundled dependency @anthropic-ai\/claude-agent-sdk is required/u.test(text)) {
    return 'Claude Code CLI 런타임이 없습니다. 번들을 설치하거나 HKCLAW_LITE_CLAUDE_CLI 를 설정하세요.';
  }
  if (/^gemini is unavailable\. Bundled dependency @google\/gemini-cli is required/u.test(text)) {
    return 'gemini 번들이 설치되어 있지 않습니다.';
  }
  if (/^Bundled runtime for agent type "codex" is not installed\.$/u.test(text)) {
    return 'codex 번들이 설치되어 있지 않습니다.';
  }
  if (/^Bundled runtime for agent type "claude-code" is not installed\.$/u.test(text)) {
    return 'Claude Code CLI 런타임이 없습니다. 번들을 설치하거나 HKCLAW_LITE_CLAUDE_CLI 를 설정하세요.';
  }
  if (text === 'Claude CLI runtime is unavailable.') {
    return 'Claude Code CLI 런타임이 없습니다. 번들을 설치하거나 HKCLAW_LITE_CLAUDE_CLI 를 설정하세요.';
  }
  if (/^Bundled runtime for agent type "gemini-cli" is not installed\.$/u.test(text)) {
    return 'gemini 번들이 설치되어 있지 않습니다.';
  }
  if (
    text === 'Claude Code ACP 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.' ||
    text === 'Claude Code CLI 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.'
  ) {
    return text;
  }
  if (text === '브라우저 완료 후 callback URL 전체를 붙여넣으세요.') {
    return text;
  }
  if (text === 'callback URL 전체를 붙여넣어야 합니다.') {
    return text;
  }
  if (
    text === 'Claude Code ACP 로그인 상태를 찾지 못했습니다. 다시 로그인 버튼을 누르세요.' ||
    text === 'Claude Code CLI 로그인 상태를 찾지 못했습니다. 다시 로그인 버튼을 누르세요.'
  ) {
    return text;
  }

  return text;
}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
