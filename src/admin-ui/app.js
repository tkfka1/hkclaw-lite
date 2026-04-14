const app = document.getElementById('app');
const DEFAULT_CHANNEL_WORKSPACE = '/workspace';
const NOTICE_AUTO_DISMISS_MS = 4_500;
let noticeTimer = null;

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
  activeView: 'home',
  agentModalOpen: false,
  botModalOpen: false,
  channelModalOpen: false,
  localLlmModalOpen: false,
  adminPasswordModalOpen: false,
  botDraft: null,
  channelDraft: null,
  localLlmDraft: null,
  agentWizard: null,
  aiManager: null,
  aiStatuses: {},
};

app.addEventListener('click', handleClick);
app.addEventListener('keydown', handleKeydown);
app.addEventListener('submit', handleSubmit);
app.addEventListener('input', handleInput);
app.addEventListener('change', handleInput);

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
    state.activeView = button.dataset.view || 'home';
    render();
    return;
  }

  if (action === 'open-ai-modal') {
    state.aiManager = createAiManager(button.dataset.agentType || '', {
      localLlmConnection: button.dataset.localLlmConnection || '',
    });
    render();
    return;
  }

  if (action === 'open-local-llm-manager') {
    state.aiManager = createAiManager('local-llm', {
      localLlmConnection: button.dataset.localLlmConnection || '',
    });
    state.localLlmDraft = null;
    render();
    return;
  }

  if (action === 'open-local-llm-create') {
    state.aiManager = createAiManager('local-llm');
    state.localLlmModalOpen = false;
    state.localLlmDraft = createLocalLlmConnectionDraft();
    render();
    return;
  }

  if (action === 'close-ai-modal') {
    state.aiManager = null;
    state.localLlmModalOpen = false;
    state.localLlmDraft = null;
    render();
    return;
  }

  if (action === 'open-local-llm-modal') {
    if (!state.aiManager || state.aiManager.type !== 'local-llm') {
      state.aiManager = createAiManager('local-llm');
    }
    state.localLlmModalOpen = false;
    state.localLlmDraft = createLocalLlmConnectionDraft();
    render();
    return;
  }

  if (action === 'edit-local-llm-connection') {
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
    render();
    return;
  }

  if (action === 'close-local-llm-modal') {
    state.localLlmModalOpen = false;
    state.localLlmDraft = null;
    render();
    return;
  }

  if (action === 'open-admin-password-modal') {
    state.adminPasswordModalOpen = true;
    render();
    return;
  }

  if (action === 'close-admin-password-modal') {
    state.adminPasswordModalOpen = false;
    render();
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
    render();
    return;
  }

  if (action === 'open-bot-modal') {
    state.botModalOpen = true;
    state.botDraft = createBlankBot();
    render();
    return;
  }

  if (action === 'edit-bot') {
    const bot = state.data?.bots?.find((entry) => entry.name === button.dataset.name);
    if (!bot) {
      setNotice('error', '봇을 찾지 못했습니다.');
      render();
      return;
    }
    state.botModalOpen = true;
    state.botDraft = createBotDraft(bot);
    render();
    return;
  }

  if (action === 'reload-discord-service') {
    void reloadDiscordServiceConfig();
    return;
  }

  if (action === 'start-discord-service') {
    void startDiscordService();
    return;
  }

  if (action === 'restart-discord-service') {
    void restartDiscordService();
    return;
  }

  if (action === 'stop-discord-service') {
    void stopDiscordService();
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

  if (action === 'restart-agent-discord-service') {
    void restartAgentDiscordService(button.dataset.name);
    return;
  }

  if (action === 'stop-agent-discord-service') {
    void stopAgentDiscordService(button.dataset.name);
    return;
  }

  if (action === 'reconnect-bot') {
    void reconnectDiscordBot(button.dataset.name);
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
    render();
    return;
  }

  if (action === 'close-bot-modal') {
    state.botModalOpen = false;
    state.botDraft = null;
    render();
    return;
  }

  if (action === 'open-channel-modal') {
    state.channelModalOpen = true;
    state.channelDraft = createBlankChannel();
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
    render();
    return;
  }

  if (action === 'close-channel-modal') {
    state.channelModalOpen = false;
    state.channelDraft = null;
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

  if (action === 'add-agent-env-row') {
    if (!state.agentWizard) {
      return;
    }
    state.agentWizard.draft.envEntries = normalizeEnvEntries(state.agentWizard.draft.envEntries);
    state.agentWizard.draft.envEntries.push(createEnvEntry());
    render();
    return;
  }

  if (action === 'remove-agent-env-row') {
    if (!state.agentWizard) {
      return;
    }
    const index = Number(button.dataset.index);
    const entries = normalizeEnvEntries(state.agentWizard.draft.envEntries);
    if (Number.isInteger(index) && index >= 0 && index < entries.length) {
      entries.splice(index, 1);
    }
    state.agentWizard.draft.envEntries = entries.length ? entries : [createEnvEntry()];
    render();
    return;
  }

  if (action === 'delete-agent') {
    void deleteEntity('agent', button.dataset.name);
    return;
  }

  if (action === 'delete-bot') {
    void deleteEntity('bot', button.dataset.name);
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

  if (action === 'reset-channel-runtime-sessions') {
    void resetChannelRuntimeSessions(button.dataset.name);
    return;
  }

  if (action === 'logout') {
    void logout();
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

  const isAgentWizardField = Boolean(state.agentWizard && target.closest('[data-form="agent-wizard"]'));
  const isAgentWizardEnvField = Boolean(target.dataset.envEntryField);
  if (!isAgentWizardField || (!target.name && !isAgentWizardEnvField)) {
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
      return;
    }
    if (
      state.channelDraft &&
      target.closest('[data-form="channel"]') &&
      target.name
    ) {
      state.channelDraft[target.name] =
        target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      if (target.name === 'mode' && state.channelDraft.mode !== 'tribunal') {
        state.channelDraft.reviewer = '';
        state.channelDraft.arbiter = '';
        state.channelDraft.reviewRounds = '';
      }
      if (target.name === 'mode') {
        render();
      }
    }
    return;
  }

  if (target.dataset.envEntryField) {
    const index = Number(target.dataset.envIndex);
    const field = target.dataset.envEntryField;
    const entries = normalizeEnvEntries(state.agentWizard.draft.envEntries);
    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < entries.length &&
      (field === 'key' || field === 'value')
    ) {
      entries[index][field] = target.value;
      state.agentWizard.draft.envEntries = entries;
    }
    return;
  }

  state.agentWizard.draft[target.name] =
    target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;

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
    render();
    return;
  }

  if (target.name === 'localLlmConnection') {
    state.agentWizard.modelCatalog = null;
    if (optionalDraftText(state.agentWizard.draft.localLlmConnection)) {
      state.agentWizard.draft.baseUrl = '';
    }
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
        validateAgentWizardStep();
        state.agentWizard.step += 1;
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

    if (kind === 'bot') {
      await saveBot(form);
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
    setNotice('error', localizeErrorMessage(error.message));
    render();
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
  const response = await mutateJson('/api/logout', {
    method: 'POST',
  });
  state.auth = response;
  state.data = null;
  setNotice('info', '로그아웃했습니다.');
  render();
}

async function changeAdminPassword(form) {
  const values = new FormData(form);
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
  if (!(action === 'login' && response.result?.details?.url)) {
    state.notice = null;
  }
  render();
}

async function saveAgentWizard() {
  validateAgentWizardStep();
  const values = state.agentWizard?.draft || createBlankAgent();
  const currentName = optionalDraftText(state.agentWizard?.currentName);
  const definition = {
    name: requiredDraftText(values.name, 'name'),
    agent: requiredDraftText(values.agent, 'agent'),
    fallbackAgent: optionalDraftText(values.fallbackAgent),
    model: resolveConfiguredModel(values.agent, values),
    effort: optionalDraftText(values.effort),
    timeoutMs: optionalDraftText(values.timeoutMs),
    systemPrompt: optionalDraftText(values.systemPrompt),
    systemPromptFile: optionalDraftText(values.systemPromptFile),
    skills: parseListText(values.skillsText),
    contextFiles: parseListText(values.contextFilesText),
    env: parseEnvEntries(values.envEntries),
    sandbox: optionalDraftText(values.sandbox),
    permissionMode: optionalDraftText(values.permissionMode),
    dangerous: values.agent === 'codex' ? Boolean(values.dangerous) : undefined,
    discordToken: requiredDraftText(values.discordToken, 'discordToken'),
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
  setNotice('info', `에이전트 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function saveChannel(form) {
  const values = new FormData(form);
  const currentName = optionalText(values, 'currentName');
  const definition = {
    name: requiredText(values, 'name'),
    mode: requiredText(values, 'mode'),
    discordChannelId: requiredText(values, 'discordChannelId'),
    guildId: optionalText(values, 'guildId'),
    workspace: requiredText(values, 'workspace'),
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
  setNotice('info', `채널 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다.`);
  render();
}

async function saveBot(form) {
  const values = new FormData(form);
  const currentName = optionalText(values, 'currentName');
  const definition = {
    name: requiredText(values, 'name'),
    agent: requiredText(values, 'agent'),
    discordToken: requiredText(values, 'discordToken'),
    description: optionalText(values, 'description'),
  };

  const response = await mutateJson('/api/bots', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.botModalOpen = false;
  state.botDraft = null;
  setNotice('info', `봇 "${definition.name}"을(를) ${currentName ? '수정' : '추가'}했습니다. 실행 중인 Discord 연결 반영은 수동 재연결로 처리합니다.`);
  render();
}

async function saveLocalLlmConnection(form) {
  const values = new FormData(form);
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

  const response = await mutateJson(`/api/${kind}s/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

  state.data = response.state;
  setNotice(
    'info',
    kind === 'bot'
      ? `봇 "${name}"을(를) 삭제했습니다. 실행 중인 Discord 연결 정리는 전체 다시 읽기 때 반영됩니다.`
      : `${localizeKind(kind)} "${name}"을(를) 삭제했습니다.`,
  );
  render();
}

async function reloadDiscordServiceConfig() {
  await mutateJson('/api/discord-service/reload', {
    method: 'POST',
  });
  setNotice('info', 'Discord 서비스가 최신 봇 설정을 다시 읽고 있습니다.');
  void refreshStateAfterDiscordCommand();
}

async function startDiscordService() {
  await mutateJson('/api/discord-service/start', {
    method: 'POST',
  });
  setNotice('info', 'Discord 서비스를 시작하고 있습니다.');
  void refreshStateAfterDiscordCommand();
}

async function restartDiscordService() {
  await mutateJson('/api/discord-service/restart', {
    method: 'POST',
  });
  setNotice('info', 'Discord 서비스를 재시작하고 있습니다.');
  void refreshStateAfterDiscordCommand();
}

async function stopDiscordService() {
  await mutateJson('/api/discord-service/stop', {
    method: 'POST',
  });
  setNotice('info', 'Discord 서비스를 중지하고 있습니다.');
  void refreshStateAfterDiscordCommand();
}

async function reconnectDiscordBot(name) {
  if (!name) {
    return;
  }
  await mutateJson(`/api/bots/${encodeURIComponent(name)}/reconnect`, {
    method: 'POST',
  });
  setNotice('info', `봇 "${name}" 연결을 다시 시도합니다.`);
  void refreshStateAfterDiscordCommand();
}

async function reconnectAgent(name) {
  if (!name) {
    return;
  }
  await mutateJson(`/api/agents/${encodeURIComponent(name)}/reconnect`, {
    method: 'POST',
  });
  setNotice('info', `에이전트 "${name}" Discord 연결을 다시 시도합니다.`);
  void refreshStateAfterDiscordCommand();
}

async function startAgentDiscordService(name) {
  if (!name) {
    return;
  }
  await mutateJson(`/api/agents/${encodeURIComponent(name)}/start`, {
    method: 'POST',
  });
  setNotice('info', `에이전트 "${name}" Discord 워커를 시작하고 있습니다.`);
  void refreshStateAfterDiscordCommand();
}

async function restartAgentDiscordService(name) {
  if (!name) {
    return;
  }
  await mutateJson(`/api/agents/${encodeURIComponent(name)}/restart`, {
    method: 'POST',
  });
  setNotice('info', `에이전트 "${name}" Discord 워커를 재시작하고 있습니다.`);
  void refreshStateAfterDiscordCommand();
}

async function stopAgentDiscordService(name) {
  if (!name) {
    return;
  }
  await mutateJson(`/api/agents/${encodeURIComponent(name)}/stop`, {
    method: 'POST',
  });
  setNotice('info', `에이전트 "${name}" Discord 워커를 중지하고 있습니다.`);
  void refreshStateAfterDiscordCommand();
}

async function refreshStateAfterDiscordCommand() {
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
}

async function resetChannelRuntimeSessions(name) {
  if (!name) {
    return;
  }

  const confirmed = window.confirm(
    `채널 "${name}"의 Claude 세션 재사용 매핑을 초기화할까요? 다음 실행부터 새 세션으로 시작합니다.`,
  );
  if (!confirmed) {
    return;
  }

  const response = await mutateJson(
    `/api/channels/${encodeURIComponent(name)}/runtime-sessions`,
    {
      method: 'DELETE',
    },
  );

  state.data = response.state;
  setNotice('info', `채널 "${name}"의 Claude 세션 매핑을 초기화했습니다.`);
  render();
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
  if (!state.data && state.loading) {
    app.innerHTML = renderFrame(renderEmptyState('불러오는 중', true));
    return;
  }

  if (state.auth.enabled && !state.auth.authenticated) {
    app.innerHTML = renderFrame(renderLoginScreen(), 'app-shell--auth');
    return;
  }

  if (!state.data) {
    app.innerHTML = renderFrame(renderEmptyState('데이터 없음'));
    return;
  }

  app.innerHTML = renderFrame(`
    ${renderTopBar()}
    ${renderActiveView()}
    ${state.agentModalOpen ? renderAgentModal() : ''}
    ${state.botModalOpen ? renderBotModal() : ''}
    ${state.channelModalOpen ? renderChannelModal() : ''}
    ${state.aiManager ? renderAiModal() : ''}
    ${state.adminPasswordModalOpen ? renderAdminPasswordModal() : ''}
  `);
}

function renderFrame(content, className = '') {
  return `
    <div class="app-shell ${escapeAttr(className)}">
      <div class="shell">
        ${content}
      </div>
      ${renderNotice()}
    </div>
  `;
}

function renderTopBar() {
  const tabs = [
    { view: 'home', label: '홈', icon: '⌂' },
    { view: 'agents', label: '에이전트', icon: '◍' },
    { view: 'channels', label: '채널', icon: '≡' },
    { view: 'ai', label: 'AI', icon: '◌' },
    { view: 'tokens', label: '토큰', icon: '◫' },
    { view: 'all', label: '전체', icon: '▦' },
  ];

  return `
    <section class="panel topbar">
      <div class="tabs" role="tablist" aria-label="관리 메뉴">
        ${tabs
          .map(
            (tab) => `
              <button
                type="button"
                class="tab ${state.activeView === tab.view ? 'is-active' : ''}"
                data-action="switch-view"
                data-view="${escapeAttr(tab.view)}"
                role="tab"
                aria-selected="${state.activeView === tab.view ? 'true' : 'false'}"
                ${state.busy ? 'disabled' : ''}
              >
                <span class="tab-icon" aria-hidden="true">${escapeHtml(tab.icon)}</span>
                <span>${escapeHtml(tab.label)}</span>
              </button>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
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

function renderHomeView() {
  return `
    <section class="metrics">
      <article class="metric">
        <span class="metric-label">에이전트 수</span>
        <strong class="metric-value">${escapeHtml(String(state.data.agents.length))}</strong>
      </article>
      <article class="metric">
        <span class="metric-label">채널 수</span>
        <strong class="metric-value">${escapeHtml(String(state.data.channels.length))}</strong>
      </article>
    </section>
  `;
}

function renderAgentsView() {
  const discordService = state.data?.discord?.service || {};
  const serviceLabel = discordService.label || '중지';
  const canStartDiscord = !state.busy && !discordService.running;
  const canRestartDiscord = !state.busy && (discordService.running || discordService.stale);
  const canStopDiscord = !state.busy && (discordService.running || discordService.stale);
  const canReloadDiscord = !state.busy && discordService.running;
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <h2>에이전트 목록</h2>
        <div class="inline-actions">
          <span class="field-hint">Discord 워커 ${escapeHtml(serviceLabel)}</span>
          <button type="button" class="btn-secondary" data-action="start-discord-service" ${canStartDiscord ? '' : 'disabled'}>전체 실행</button>
          <button type="button" class="btn-secondary" data-action="restart-discord-service" ${canRestartDiscord ? '' : 'disabled'}>전체 재시작</button>
          <button type="button" class="btn-secondary" data-action="stop-discord-service" ${canStopDiscord ? '' : 'disabled'}>전체 중지</button>
          <button type="button" class="btn-secondary" data-action="reload-discord-service" ${canReloadDiscord ? '' : 'disabled'}>전체 다시 읽기</button>
          <button type="button" class="btn-primary" data-action="open-agent-modal" ${state.busy ? 'disabled' : ''}>추가</button>
        </div>
      </div>
      ${renderAgentList(state.data.agents, discordService)}
    </section>
  `;
}

function renderChannelsView() {
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <h2>채널 목록</h2>
        <button type="button" class="btn-primary" data-action="open-channel-modal" ${state.busy ? 'disabled' : ''}>추가</button>
      </div>
      ${renderChannelList(state.data.channels, state.data.agents)}
    </section>
  `;
}

function renderAllView() {
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <h2>관리</h2>
      </div>
      <div class="card-list">
        <article
          class="card card--clickable"
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
          class="card card--clickable card--danger"
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

function renderAiView() {
  const supportsLocalLlm = (state.data?.choices?.agentTypes || []).some(
    (entry) => entry.value === 'local-llm',
  );
  return `
    <section class="panel section-panel">
      <div class="section-head">
        <h2>AI 관리</h2>
        ${
          supportsLocalLlm
            ? `<button
                type="button"
                class="btn-secondary"
                data-action="open-local-llm-create"
                ${state.busy ? 'disabled' : ''}
              >
                로컬 LLM 추가
              </button>`
            : ''
        }
      </div>
      ${renderAiList()}
    </section>
  `;
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
  const monthly = Array.isArray(tokenUsage.monthly) ? tokenUsage.monthly : [];
  const maxDailyTokens = Math.max(...daily.map((entry) => Number(entry.totalTokens || 0)), 1);

  return `
    <section class="panel section-panel">
      <div class="section-head">
        <h2>토큰 기록</h2>
        <span class="field-hint">최근 ${escapeHtml(String(tokenUsage.windowDays || 90))}일 · ${escapeHtml(tokenUsage.since || '')} ~ ${escapeHtml(tokenUsage.until || '')}</span>
      </div>
      <section class="metrics token-metrics">
        <article class="metric">
          <span class="metric-label">총 토큰</span>
          <strong class="metric-value">${escapeHtml(formatTokenCount(totals.totalTokens))}</strong>
        </article>
        <article class="metric">
          <span class="metric-label">입력 / 출력</span>
          <strong class="metric-value">${escapeHtml(`${formatTokenCount(totals.inputTokens)} / ${formatTokenCount(totals.outputTokens)}`)}</strong>
        </article>
        <article class="metric">
          <span class="metric-label">기록 횟수</span>
          <strong class="metric-value">${escapeHtml(formatTokenCount(totals.recordedEvents))}</strong>
        </article>
        <article class="metric">
          <span class="metric-label">활동 일수</span>
          <strong class="metric-value">${escapeHtml(formatTokenCount(totals.activeDays))}</strong>
        </article>
      </section>
      <div class="grid-two">
        <section class="usage-summary-card">
          <strong>AI별 합계</strong>
          ${
            byAgentType.length
              ? `
                  <div class="token-breakdown-list">
                    ${byAgentType
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
          <strong>월별 합계</strong>
          ${
            monthly.length
              ? `
                  <div class="token-breakdown-list">
                    ${monthly
                      .map(
                        (entry) => `
                          <div class="token-breakdown-row">
                            <span>${escapeHtml(entry.date)}</span>
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
      <section class="usage-summary-card">
        <strong>일별 추이</strong>
        ${
          activeDaily.length
            ? `
                <div class="token-chart">
                  ${daily
                    .map((entry) => {
                      const totalTokens = Number(entry.totalTokens || 0);
                      const width = totalTokens > 0 ? Math.max(2, Math.round((totalTokens / maxDailyTokens) * 100)) : 0;
                      return `
                        <div class="token-chart-row">
                          <span class="token-chart-date">${escapeHtml(entry.date)}</span>
                          <div class="token-chart-bar-track">
                            <div class="token-chart-bar" style="width:${width}%"></div>
                          </div>
                          <strong class="token-chart-value">${escapeHtml(formatTokenCount(totalTokens))}</strong>
                        </div>
                      `;
                    })
                    .join('')}
                </div>
              `
            : '<div class="field-hint">최근 3개월 기록이 없습니다.</div>'
        }
      </section>
      <section class="usage-summary-card">
        <strong>최근 활동 일자</strong>
        ${
          activeDaily.length
            ? `
                <div class="token-table">
                  <div class="token-table-head">
                    <span>날짜</span>
                    <span>기록</span>
                    <span>입력</span>
                    <span>출력</span>
                    <span>총합</span>
                  </div>
                  <div class="token-table-body">
                    ${activeDaily
                      .slice(0, 30)
                      .map(
                        (entry) => `
                          <div class="token-table-row">
                            <span>${escapeHtml(entry.date)}</span>
                            <span>${escapeHtml(formatTokenCount(entry.recordedEvents))}</span>
                            <span>${escapeHtml(formatTokenCount(entry.inputTokens))}</span>
                            <span>${escapeHtml(formatTokenCount(entry.outputTokens))}</span>
                            <strong>${escapeHtml(formatTokenCount(entry.totalTokens))}</strong>
                          </div>
                        `,
                      )
                      .join('')}
                  </div>
                </div>
              `
            : '<div class="field-hint">최근 3개월 기록이 없습니다.</div>'
        }
      </section>
    </section>
  `;
}

function renderAgentList(agents, discordService = {}) {
  if (!agents.length) {
    return '<div class="empty-inline">에이전트가 없습니다.</div>';
  }

  const serviceBots = discordService?.bots || {};
  return `
    <div class="card-list">
      ${agents
        .map(
          (agent) => {
            const runtimeBot = serviceBots[agent.name] || {};
            const agentService = agent.discordService || null;
            const agentServiceLabel = agentService?.label || '중지';
            const agentServiceRunning = Boolean(agentService?.running);
            const agentServiceStale = Boolean(agentService?.stale);
            const connectionSummary = runtimeBot.connected
              ? `연결됨${runtimeBot.tag ? ` · ${runtimeBot.tag}` : ''}`
              : agentServiceRunning
                ? '연결 안 됨'
                : agentServiceStale
                  ? '워커 끊김'
                  : '워커 중지';
            return `
              <article class="card">
                <div class="card-main">
                  <strong class="card-title">${escapeHtml(agent.name)}</strong>
                  <span class="card-meta">${escapeHtml(localizeAgentTypeValue(agent.agent))}${agent.model ? ` · ${escapeHtml(agent.model)}` : ''}</span>
                  <div class="field-hint">Discord 토큰 ${agent.discordTokenConfigured ? '설정됨' : '미설정'} · 워커 ${escapeHtml(agentServiceLabel)} · ${escapeHtml(connectionSummary)} · 채널 ${escapeHtml(String((agent.mappedChannelNames || []).length))}개</div>
                </div>
                <div class="inline-actions">
                  <button type="button" class="btn-secondary" data-action="start-agent-discord-service" data-name="${escapeAttr(agent.name)}" ${state.busy || !agent.discordTokenConfigured || agentServiceRunning ? 'disabled' : ''}>실행</button>
                  <button type="button" class="btn-secondary" data-action="restart-agent-discord-service" data-name="${escapeAttr(agent.name)}" ${state.busy || !agent.discordTokenConfigured || (!agentServiceRunning && !agentServiceStale) ? 'disabled' : ''}>재시작</button>
                  <button type="button" class="btn-secondary" data-action="stop-agent-discord-service" data-name="${escapeAttr(agent.name)}" ${state.busy || (!agentServiceRunning && !agentServiceStale) ? 'disabled' : ''}>중지</button>
                  <button type="button" class="btn-secondary" data-action="edit-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>수정</button>
                  <button type="button" class="btn-secondary" data-action="reconnect-agent" data-name="${escapeAttr(agent.name)}" ${state.busy || !agentServiceRunning ? 'disabled' : ''}>재연결</button>
                  <button type="button" class="btn-danger" data-action="delete-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>삭제</button>
                </div>
              </article>
            `;
          },
        )
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
          const claudeSessions = (runtime.sessions || []).filter(
            (session) => session.runtimeBackend === 'claude-cli' && session.runtimeSessionId,
          );
          return `
            <article class="card card--stack">
              <div class="card-main">
                <strong class="card-title">${escapeHtml(channel.name)}</strong>
                <span class="card-meta">${escapeHtml(localizeChannelMode(mode))} · ${escapeHtml(channel.discordChannelId)} · ${escapeHtml(channel.workspace || getDefaultChannelWorkspace())}</span>
                <div class="role-list">
                  <span class="role-item"><strong>owner</strong><span>${escapeHtml(channel.agent)}</span></span>
                  ${
                    mode === 'tribunal' && channel.reviewer
                      ? `<span class="role-item"><strong>reviewer</strong><span>${escapeHtml(channel.reviewer)}</span></span>`
                      : ''
                  }
                  ${
                    mode === 'tribunal' && channel.arbiter
                      ? `<span class="role-item"><strong>arbiter</strong><span>${escapeHtml(channel.arbiter)}</span></span>`
                      : ''
                  }
                  ${
                    owner
                      ? `<span class="mini-chip">${escapeHtml(localizeAgentTypeValue(owner.agent))}</span>`
                      : ''
                  }
                </div>
                ${
                  lastRun || runtime.pendingOutboxCount
                    ? `
                      <div class="card-tags">
                        ${
                          lastRun
                            ? `<span class="mini-chip ${escapeAttr(resolveRuntimeChipClass(lastRun.status))}">${escapeHtml(localizeRuntimeStatus(lastRun.status))}</span>`
                            : ''
                        }
                        ${
                          lastRun?.reviewerVerdict
                            ? `<span class="mini-chip">${escapeHtml(localizeReviewerVerdict(lastRun.reviewerVerdict))}</span>`
                            : ''
                        }
                        ${
                          runtime.pendingOutboxCount
                            ? `<span class="mini-chip">${escapeHtml(`발송 대기 ${runtime.pendingOutboxCount}`)}</span>`
                            : ''
                        }
                      </div>
                    `
                    : ''
                }
                ${
                  claudeSessions.length > 0
                    ? `
                      <div class="field-hint">
                        Claude 세션:
                        ${escapeHtml(
                          claudeSessions
                            .map((session) => `${session.role}(${session.runCount})`)
                            .join(', '),
                        )}
                      </div>
                    `
                    : ''
                }
              </div>
              <div class="inline-actions">
                <button type="button" class="btn-secondary" data-action="edit-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>수정</button>
                ${
                  claudeSessions.length > 0
                    ? `<button type="button" class="btn-secondary" data-action="reset-channel-runtime-sessions" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>세션 초기화</button>`
                    : ''
                }
                <button type="button" class="btn-danger" data-action="delete-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>삭제</button>
              </div>
            </article>
          `;
        })
        .join('')}
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
                <strong class="card-title">${escapeHtml(localizeOptionLabel(entry))}</strong>
                <span class="card-meta">${escapeHtml(localizeAiMeta(entry.value))}</span>
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
                <strong class="card-title">${escapeHtml(connection.name)}</strong>
                <span class="card-meta">${escapeHtml(`로컬 LLM · ${connection.baseUrl}`)}</span>
                <div class="field-hint">${connection.apiKey ? 'API 키 설정됨' : 'API 키 없음'}${connection.description ? ` · ${escapeHtml(connection.description)}` : ''}</div>
                ${
                  ready
                    ? `<div class="card-tags"><span class="mini-chip mini-chip--ok">사용 가능</span></div>`
                    : ''
                }
              </div>
              <div class="inline-actions">
                <button
                  type="button"
                  class="btn-secondary"
                  data-action="open-local-llm-manager"
                  data-local-llm-connection="${escapeAttr(connection.name)}"
                  ${state.busy ? 'disabled' : ''}
                >
                  관리
                </button>
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
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="에이전트 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-agent-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <h2>에이전트 ${isEditing ? '수정' : '추가'}</h2>
          <button type="button" class="btn-secondary" data-action="close-agent-modal" ${state.busy ? 'disabled' : ''}>닫기</button>
        </div>
        <form data-form="agent-wizard" class="form wizard-form">
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
                ? `<button type="button" class="btn-secondary" data-action="prev-agent-step" ${state.busy ? 'disabled' : ''}>이전</button>`
                : ''
            }
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>
              ${currentStep === steps.length - 1 ? (isEditing ? '저장' : '추가') : '다음'}
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

  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="AI 관리">
      <div class="modal-backdrop" data-action="close-ai-modal"></div>
      <div class="panel modal-card modal-card--small">
        <div class="section-head">
          <h2>${escapeHtml(modalTitle)} 관리</h2>
          <div class="inline-actions">
            ${
              entry.value === 'local-llm'
                ? `<button type="button" class="btn-secondary" data-action="open-local-llm-modal" ${state.busy ? 'disabled' : ''}>연결 추가</button>`
                : ''
            }
            <button type="button" class="btn-secondary" data-action="close-ai-modal" ${state.busy ? 'disabled' : ''}>닫기</button>
          </div>
        </div>
        <div data-form="ai-manager" class="form">
          <div class="ai-modal-body">${renderAiStatusChips(entry.value, authResult, testResult, ready)}</div>
          ${renderAiUsageSummary(entry.value, usageSummary)}
          ${renderAiWorkflowGuide(entry.value, authResult, testResult, ready, testSupported)}
          ${renderAiAuthFields(entry.value)}
          ${renderAiCredentialFields(entry.value)}
          ${renderAiTestFields(entry.value)}
          ${
            authSupported
              ? `<div class="wizard-auth-action-stack">
                  <div class="wizard-auth-actions">
                    <button type="button" class="btn-secondary" data-action="ai-auth-login" ${state.busy ? 'disabled' : ''}>1. 로그인</button>
                    ${
                      entry.value === 'claude-code' || entry.value === 'gemini-cli'
                        ? `<button
                            type="button"
                            class="btn-secondary"
                            data-action="ai-auth-complete-login"
                            ${isAiCompleteLoginDisabled(entry.value, authResult) || state.busy ? 'disabled' : ''}
                          >
                            2. 로그인 완료
                          </button>`
                        : ''
                    }
                    <button type="button" class="btn-secondary" data-action="ai-auth-status" ${state.busy ? 'disabled' : ''}>
                      ${entry.value === 'claude-code' || entry.value === 'gemini-cli' ? '3. 상태 확인' : '2. 상태 확인'}
                    </button>
                    <button
                      type="button"
                      class="btn-primary"
                      data-action="ai-auth-test"
                      ${state.busy || !testSupported || !isAiTestReady(entry.value, ready) ? 'disabled' : ''}
                    >
                      ${entry.value === 'claude-code' || entry.value === 'gemini-cli' ? '4. 테스트 호출' : '3. 테스트 호출'}
                    </button>
                  </div>
                  <div class="wizard-auth-actions">
                    <button type="button" class="btn-secondary" data-action="ai-auth-logout" ${state.busy ? 'disabled' : ''}>로그아웃</button>
                    ${
                      credentialEditingSupported && entry.value !== 'local-llm'
                        ? `<button
                            type="button"
                            class="btn-secondary"
                            data-action="ai-save-credentials"
                            ${state.busy ? 'disabled' : ''}
                          >
                            자격정보 저장
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
                          자격정보 저장
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
                          상태 확인
                        </button>`
                      : ''
                  }
                  <button
                    type="button"
                    class="btn-primary"
                    data-action="ai-auth-test"
                    ${state.busy || !testSupported ? 'disabled' : ''}
                  >
                    테스트 호출
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
      `<div class="auth-chip ${runtimeReady ? 'is-ok' : ''}">${escapeHtml(`런타임 ${runtimeReady ? '준비' : '미설치'}`)}</div>`,
    );
  }
  if (authResult?.details?.configured !== undefined && agentType !== 'codex') {
    const configured = Boolean(authResult?.details?.configured);
    const label = agentType === 'local-llm' ? '연결' : 'API 키';
    chips.push(
      `<div class="auth-chip ${configured ? 'is-ok' : ''}">${escapeHtml(`${label} ${configured ? '완료' : '미완료'}`)}</div>`,
    );
  }
  if (authResult?.details?.pendingLogin) {
    chips.push('<div class="auth-chip">브라우저 로그인 진행 중</div>');
  }
  const testOk = Boolean(testResult?.details?.success);
  chips.push(
    `<div class="auth-chip ${testOk ? 'is-ok' : ''}">${escapeHtml(`테스트 ${testOk ? '완료' : '미완료'}`)}</div>`,
  );
  if (ready) {
    chips.push('<div class="auth-chip is-ok">사용 가능</div>');
  }
  return chips.join('');
}

function renderAiWorkflowGuide(agentType, authResult, testResult, ready, testSupported) {
  if (!isAiAuthSupported(agentType)) {
    return '';
  }

  const loggedIn = Boolean(authResult?.details?.loggedIn);
  const pendingLogin = Boolean(authResult?.details?.pendingLogin);
  const testOk = Boolean(testResult?.details?.success);
  const steps = agentType === 'claude-code'
      ? [
          {
            label: '1. 로그인',
            state: loggedIn ? '완료' : (pendingLogin ? '진행 중' : '대기'),
            hint: '브라우저 로그인 창을 엽니다.',
          },
          {
            label: '2. 로그인 완료',
            state: loggedIn ? '완료' : (pendingLogin ? '필요' : '대기'),
            hint: '브라우저 인증 뒤 표시되는 Authentication Code 또는 callback URL 전체를 붙여넣습니다.',
          },
        {
          label: '3. 상태 확인',
          state: loggedIn ? '완료' : '대기',
          hint: '현재 로그인 상태를 다시 읽습니다.',
        },
        {
          label: '4. 테스트 호출',
          state: testOk ? '완료' : (ready ? '준비됨' : '대기'),
          hint: '실제 Claude Code ACP turn 호출이 되는지 확인합니다.',
        },
      ]
    : agentType === 'gemini-cli'
      ? [
          {
            label: '1. 로그인',
            state: loggedIn ? '완료' : (pendingLogin ? '진행 중' : '대기'),
            hint: '브라우저 Google 로그인 창을 엽니다.',
          },
          {
            label: '2. 로그인 완료',
            state: loggedIn ? '완료' : (pendingLogin ? '필요' : '대기'),
            hint: '브라우저 인증 뒤 표시되는 authorization code를 붙여넣습니다.',
          },
          {
            label: '3. 상태 확인',
            state: loggedIn ? '완료' : '대기',
            hint: '현재 Google 로그인 상태를 다시 읽습니다.',
          },
          {
            label: '4. 테스트 호출',
            state: testOk ? '완료' : (ready ? '준비됨' : '대기'),
            hint: '실제 Gemini CLI turn 호출이 되는지 확인합니다.',
          },
        ]
      : [
          {
            label: '1. 로그인',
            state: loggedIn ? '완료' : (pendingLogin ? '진행 중' : '대기'),
            hint: 'Codex 디바이스 로그인 플로우를 시작하고 브라우저 완료까지 기다립니다.',
          },
          {
            label: '2. 상태 확인',
            state: loggedIn ? '완료' : (pendingLogin ? '확인 필요' : '대기'),
            hint: '현재 로그인 상태를 다시 읽습니다.',
          },
          {
            label: '3. 테스트 호출',
            state: testOk ? '완료' : (ready ? '준비됨' : '대기'),
            hint: '실제 Codex turn 호출이 되는지 확인합니다.',
          },
        ];

  return `
    <div class="wizard-result">
      <strong>권장 순서</strong>
      <ol class="flow-list">
        ${steps
          .map(
            (step) =>
              `<li><strong>${escapeHtml(step.label)}</strong> - ${escapeHtml(step.state)}<br /><span class="field-hint">${escapeHtml(step.hint)}</span></li>`,
          )
          .join('')}
      </ol>
      ${
        agentType === 'codex'
          ? '<div class="field-hint">Codex는 이 머신의 로컬 Codex 로그인 상태를 그대로 사용합니다. 그래서 이미 로그인되어 있으면 처음부터 완료로 보일 수 있습니다.</div>'
          : ''
      }
      ${
        agentType === 'claude-code'
          ? '<div class="field-hint">Claude Code ACP는 브라우저 인증을 마친 뒤 Authentication Code 또는 callback URL을 웹 어드민에 붙여넣어야 완료됩니다.</div>'
          : ''
      }
      ${
        agentType === 'gemini-cli'
          ? '<div class="field-hint">Gemini CLI는 브라우저 인증을 마친 뒤 authorization code 붙여넣기까지 해야 완료됩니다.</div>'
          : ''
      }
      ${
        !testSupported
          ? '<div class="field-hint">이 AI 유형은 테스트 호출을 지원하지 않습니다.</div>'
          : ''
      }
    </div>
  `;
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
    `<div class="auth-chip is-ok">총 ${escapeHtml(formatTokenCount(summary.totalTokens))}</div>`,
    `<div class="auth-chip">입력 ${escapeHtml(formatTokenCount(summary.inputTokens))}</div>`,
    `<div class="auth-chip">출력 ${escapeHtml(formatTokenCount(summary.outputTokens))}</div>`,
  ];
  if (summary.cacheCreationInputTokens > 0) {
    chips.push(
      `<div class="auth-chip">캐시 작성 ${escapeHtml(formatTokenCount(summary.cacheCreationInputTokens))}</div>`,
    );
  }
  if (summary.cacheReadInputTokens > 0) {
    chips.push(
      `<div class="auth-chip">캐시 읽기 ${escapeHtml(formatTokenCount(summary.cacheReadInputTokens))}</div>`,
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
    const authorizationCode = optionalDraftText(state.aiManager?.authConfig?.authorizationCode);
    return !authorizationCode;
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
    return `<div class="auth-chip ${loggedIn ? 'is-ok' : ''}">${escapeHtml(`${label} ${loggedIn ? '완료' : '미완료'}`)}</div>`;
  }

  const configured = Boolean(authResult?.details?.configured);
  const label = agentType === 'local-llm' ? '연결' : '자격정보';
  return `<div class="auth-chip ${configured ? 'is-ok' : ''}">${escapeHtml(`${label} ${configured ? '완료' : '미완료'}`)}</div>`;
}

function renderAdminPasswordModal() {
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="관리자 비밀번호 설정">
      <div class="modal-backdrop" data-action="close-admin-password-modal"></div>
      <div class="panel modal-card modal-card--small">
        <div class="section-head">
          <h2>관리자 비밀번호 설정</h2>
          <button type="button" class="btn-secondary" data-action="close-admin-password-modal" ${state.busy ? 'disabled' : ''}>닫기</button>
        </div>
        <form data-form="admin-password" class="form">
          <div class="form-grid">
            ${
              state.auth.enabled
                ? `
                    <div class="field field-full">
                      <label for="admin-current-password">현재 비밀번호</label>
                      <input id="admin-current-password" type="password" name="currentPassword" />
                    </div>
                  `
                : ''
            }
            <div class="field field-full">
              <label for="admin-new-password">새 비밀번호</label>
              <input id="admin-new-password" type="password" name="newPassword" />
            </div>
            <div class="field field-full">
              <label for="admin-confirm-password">새 비밀번호 확인</label>
              <input id="admin-confirm-password" type="password" name="confirmPassword" />
            </div>
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>저장</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderChannelModal() {
  const current = state.channelDraft || createBlankChannel();
  const isTribunal = current.mode === 'tribunal';
  const agentNames = (state.data.agents || []).map((entry) => entry.name);
  const isEditing = Boolean(optionalDraftText(current.currentName));
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="채널 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-channel-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <h2>채널 ${isEditing ? '수정' : '추가'}</h2>
          <button type="button" class="btn-secondary" data-action="close-channel-modal" ${state.busy ? 'disabled' : ''}>닫기</button>
        </div>
        <form data-form="channel" class="form">
          <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
          <div class="form-grid">
            <div class="field">
              <label for="channel-name">이름</label>
              <input id="channel-name" name="name" value="${escapeAttr(current.name)}" />
            </div>
            <div class="field">
              <label for="channel-discord">디스코드 채널 ID</label>
              <input id="channel-discord" name="discordChannelId" value="${escapeAttr(current.discordChannelId)}" />
            </div>
            <div class="field">
              <label for="channel-guild">길드 ID</label>
              <input id="channel-guild" name="guildId" value="${escapeAttr(current.guildId)}" />
            </div>
            <div class="field">
              <label for="channel-workspace">워크스페이스</label>
              <input id="channel-workspace" name="workspace" value="${escapeAttr(current.workspace)}" />
            </div>
            <div class="field">
              <label for="channel-mode">채널 모드</label>
              <select id="channel-mode" name="mode">${renderOptions(state.data.choices.channelModes, current.mode)}</select>
            </div>
            <div class="field">
              <label for="channel-agent">owner 에이전트</label>
              <select id="channel-agent" name="agent">${renderNameOptions(agentNames, current.agent)}</select>
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
                    <div class="field">
                      <label for="channel-reviewer">reviewer 에이전트</label>
                      <select id="channel-reviewer" name="reviewer">${renderNameOptions(agentNames, current.reviewer, true)}</select>
                    </div>
                    <div class="field">
                      <label for="channel-arbiter">arbiter 에이전트</label>
                      <select id="channel-arbiter" name="arbiter">${renderNameOptions(agentNames, current.arbiter, true)}</select>
                    </div>
                    <div class="field">
                      <label for="channel-rounds">검토 회차</label>
                      <input id="channel-rounds" name="reviewRounds" value="${escapeAttr(current.reviewRounds)}" />
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
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>${isEditing ? '저장' : '추가'}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderBotModal() {
  const current = state.botDraft || createBlankBot();
  const isEditing = Boolean(optionalDraftText(current.currentName));
  return `
    <section class="modal-shell" aria-modal="true" role="dialog" aria-label="봇 ${isEditing ? '수정' : '추가'}">
      <div class="modal-backdrop" data-action="close-bot-modal"></div>
      <div class="panel modal-card">
        <div class="section-head">
          <h2>봇 ${isEditing ? '수정' : '추가'}</h2>
          <button type="button" class="btn-secondary" data-action="close-bot-modal" ${state.busy ? 'disabled' : ''}>닫기</button>
        </div>
        <form data-form="bot" class="form">
          <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
          <div class="form-grid">
            <div class="field">
              <label for="bot-name">이름</label>
              <input id="bot-name" name="name" value="${escapeAttr(current.name)}" />
            </div>
            <div class="field">
              <label for="bot-agent">에이전트</label>
              <select id="bot-agent" name="agent">${renderNameOptions(state.data.agents.map((entry) => entry.name), current.agent)}</select>
            </div>
            <div class="field field-full">
              <label for="bot-discord-token">Discord 토큰</label>
              <input id="bot-discord-token" name="discordToken" value="${escapeAttr(current.discordToken)}" />
            </div>
            <div class="field field-full">
              <label for="bot-description">설명</label>
              <textarea id="bot-description" name="description">${escapeHtml(current.description)}</textarea>
            </div>
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>${isEditing ? '저장' : '추가'}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderLocalLlmConnectionEditor() {
  const current = state.localLlmDraft || createLocalLlmConnectionDraft();
  const isEditing = Boolean(optionalDraftText(current.currentName));
  return `
    <div class="local-llm-editor">
      <div class="section-head">
        <h3>로컬 LLM 연결 ${isEditing ? '수정' : '추가'}</h3>
        <button type="button" class="btn-secondary" data-action="close-local-llm-modal" ${state.busy ? 'disabled' : ''}>취소</button>
      </div>
      <form data-form="local-llm-connection" class="form">
        <input type="hidden" name="currentName" value="${escapeAttr(current.currentName || '')}" />
        <div class="form-grid">
          <div class="field">
            <label for="local-llm-name">이름</label>
            <input id="local-llm-name" name="name" value="${escapeAttr(current.name)}" />
          </div>
          <div class="field field-full">
            <label for="local-llm-base-url">주소</label>
            <input id="local-llm-base-url" name="baseUrl" value="${escapeAttr(current.baseUrl)}" placeholder="예: http://127.0.0.1:11434/v1" />
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
          <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>${isEditing ? '저장' : '추가'}</button>
        </div>
      </form>
    </div>
  `;
}

function renderLoginScreen() {
  return `
    <section class="login-shell">
      <section class="panel login-panel">
        <h1>관리 화면</h1>
        <form data-form="login" class="form">
          <div class="field">
            <label for="login-password">비밀번호</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" />
          </div>
          <div class="actions">
            <button type="submit" class="btn-primary" ${state.busy ? 'disabled' : ''}>로그인</button>
          </div>
        </form>
      </section>
    </section>
  `;
}

function renderEmptyState(title, loading = false) {
  return `
    <section class="empty-state ${loading ? 'is-loading' : ''}">
      <h1>${escapeHtml(title)}</h1>
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
        <div class="notice-body">${escapeHtml(state.notice.text)}</div>
        <button type="button" class="notice-close" data-action="close-notice" aria-label="알림 닫기">닫기</button>
      </div>
    </div>
  `;
}

function getAgentWizardSteps(draft) {
  const selectableAgentTypes = getAgentTypeChoicesForDraft(draft);
  const steps = [
    {
      id: 'name',
      question: '이름은 뭘로 할까요?',
      body: `
        <div class="field">
          <label for="wizard-agent-name">이름</label>
          <input id="wizard-agent-name" name="name" value="${escapeAttr(draft.name)}" autofocus />
        </div>
      `,
    },
    {
      id: 'agent',
      question: 'AI 유형은 어떤 걸로 할까요?',
      body: `
        <div class="field">
          <label for="wizard-agent-type">AI 유형</label>
          <select id="wizard-agent-type" name="agent">${renderOptions(selectableAgentTypes, draft.agent)}</select>
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
          <div class="field">
            <label for="wizard-agent-timeout">제한 시간(ms)</label>
            <input id="wizard-agent-timeout" name="timeoutMs" value="${escapeAttr(draft.timeoutMs)}" />
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
          <div class="field field-full">
            <label>환경 변수</label>
            <div class="field-hint">필요한 값만 키와 값으로 추가하세요. 빈 줄은 자동으로 무시됩니다.</div>
            ${renderAgentWizardEnvEditor(draft)}
          </div>
        </div>
      `,
    },
  );

  return steps;
}

function renderAgentWizardRuntimeStep(draft) {
  const blocks = [
    `
      <div class="field field-full">
        <label for="wizard-agent-discord-token">Discord 토큰</label>
        <input
          id="wizard-agent-discord-token"
          name="discordToken"
          value="${escapeAttr(draft.discordToken || '')}"
          placeholder="Discord bot token"
        />
        <div class="field-hint">에이전트 하나가 Discord 서비스 연결 하나를 가집니다. 이 토큰으로 해당 에이전트 메시지를 받습니다.</div>
      </div>
    `,
  ];

  if (draft.agent === 'codex') {
    blocks.push(`
      <div class="field">
        <label for="wizard-agent-sandbox">Codex 샌드박스</label>
        <select id="wizard-agent-sandbox" name="sandbox">${renderOptions(state.data.choices.codexSandboxes, draft.sandbox, true)}</select>
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
      <div class="field">
        <label for="wizard-agent-local-llm-connection">로컬 LLM 연결</label>
        <select id="wizard-agent-local-llm-connection" name="localLlmConnection">
          ${renderLocalLlmConnectionOptions(draft.localLlmConnection, true)}
        </select>
      </div>
    `);
    if (!optionalDraftText(draft.localLlmConnection)) {
      blocks.push(`
        <div class="field">
          <label for="wizard-agent-base-url">직접 입력 주소</label>
          <input id="wizard-agent-base-url" name="baseUrl" value="${escapeAttr(draft.baseUrl)}" />
        </div>
      `);
    }
  }

  if (draft.agent === 'command') {
    blocks.push(`
      <div class="field">
        <label for="wizard-agent-command">명령어</label>
        <input id="wizard-agent-command" name="command" value="${escapeAttr(draft.command)}" />
      </div>
    `);
  }

  if (draft.agent === 'codex' && draft.sandbox === 'danger-full-access') {
    blocks.push(`
      <label class="checkbox" for="wizard-agent-dangerous">
        <input id="wizard-agent-dangerous" type="checkbox" name="dangerous" ${draft.dangerous ? 'checked' : ''} />
        <span>제한 해제</span>
      </label>
    `);
  }

  return `<div class="form-grid">${blocks.join('')}</div>`;
}

function renderAgentWizardResult(result) {
  if (!result) {
    return '';
  }

  const details = result.details || {};
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
      ${links.join('')}
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
    requiredDraftText(draft.discordToken, 'discordToken');
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

  if (currentStep.id === 'context') {
    parseEnvEntries(draft.envEntries);
  }

  return true;
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
    fallbackAgent: '',
    modelMode: defaultModelModeForAgent(resolvedAgentType),
    model: '',
    effort: '',
    timeoutMs: '',
    systemPrompt: '',
    systemPromptFile: '',
    skillsText: '',
    contextFilesText: '',
    envEntries: [createEnvEntry()],
    sandbox: state.data.choices.codexSandboxes[0]?.value || '',
    permissionMode: defaultClaudePermissionMode,
    dangerous: false,
    discordToken: '',
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
    fallbackAgent: optionalDraftText(agent?.fallbackAgent),
    modelMode: supportsDefaultModelMode(resolvedAgentType) ? (model ? 'custom' : 'default') : 'custom',
    model: model || '',
    effort: optionalDraftText(agent?.effort),
    timeoutMs: agent?.timeoutMs ? String(agent.timeoutMs) : '',
    systemPrompt: agent?.systemPrompt || '',
    systemPromptFile: agent?.systemPromptFile || '',
    skillsText: Array.isArray(agent?.skills) ? agent.skills.join('\n') : '',
    contextFilesText: Array.isArray(agent?.contextFiles) ? agent.contextFiles.join('\n') : '',
    envEntries: Object.entries(agent?.env || {}).map(([key, value]) => createEnvEntry(key, value)),
    sandbox: optionalDraftText(agent?.sandbox) || state.data?.choices?.codexSandboxes?.[0]?.value || '',
    permissionMode:
      optionalDraftText(agent?.permissionMode) ||
      state.data?.choices?.claudePermissionModes?.find((entry) => entry.value === 'bypassPermissions')?.value ||
      state.data?.choices?.claudePermissionModes?.[0]?.value ||
      '',
    dangerous: Boolean(agent?.dangerous),
    discordToken: optionalDraftText(agent?.discordToken),
    localLlmConnection: optionalDraftText(agent?.localLlmConnection) || getDefaultLocalLlmConnectionName(),
    baseUrl: optionalDraftText(agent?.baseUrl),
    command: agent?.command || '',
  };
}

function createBotDraft(bot) {
  return {
    currentName: bot?.name || '',
    name: bot?.name || '',
    agent: bot?.agent || state.data?.agents?.[0]?.name || '',
    discordToken: bot?.discordToken || '',
    description: bot?.description || '',
  };
}

function createChannelDraft(channel) {
  return {
    currentName: channel?.name || '',
    name: channel?.name || '',
    mode: channel?.mode || 'single',
    discordChannelId: channel?.discordChannelId || '',
    guildId: channel?.guildId || '',
    workspace: channel?.workspace || getDefaultChannelWorkspace(),
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
    body.authorizationCode = optionalDraftText(state.aiManager?.authConfig?.authorizationCode);
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
      state.aiManager.authResult = response.result;
      if (action === 'logout') {
        state.aiManager.testResult = null;
      }
      if (
        action === 'status' &&
        isAuthRequiredAgent(agentType) &&
        !response.result?.details?.loggedIn
      ) {
        state.aiManager.testResult = null;
      }
    }
    syncAiStatus(agentType, state.aiManager);

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
  let response;
  if (agentType === 'local-llm') {
    response = await mutateJson('/api/local-llm-connections', {
      method: 'PUT',
      body: {
        connections: parseLocalLlmConnectionEntries(state.aiManager.credentials.connections),
      },
    });
  } else {
    const nextSharedEnv = {
      ...(state.data?.sharedEnv || {}),
    };

    for (const key of getAiManagedCredentialKeys(agentType)) {
      const value = optionalDraftText(state.aiManager.credentials?.[key]);
      if (value) {
        nextSharedEnv[key] = value;
      } else {
        delete nextSharedEnv[key];
      }
    }

    response = await mutateJson('/api/shared-env', {
      method: 'PUT',
      body: {
        sharedEnv: nextSharedEnv,
      },
    });
  }

  state.data = response.state;
  await refreshAiStatuses();
  state.aiManager = createAiManager(agentType);
  setNotice('info', agentType === 'local-llm' ? '로컬 LLM 연결 목록을 저장했습니다.' : `${localizeAgentTypeValue(agentType)} 자격정보를 저장했습니다.`);
  render();
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

  if (agentType === 'local-llm') {
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
                  <button type="button" class="btn-secondary btn-inline" data-action="open-local-llm-modal" ${state.busy ? 'disabled' : ''}>연결 추가</button>
                </div>`
          }
        </div>
      </div>
    `;
  }

  const credentials = state.aiManager?.credentials || {};
  const fields = [];

  for (const field of getAiCredentialFields(agentType)) {
    fields.push(`
      <div class="field field-full">
        <label for="${escapeAttr(field.inputId)}">${escapeHtml(field.label)}</label>
        <input
          id="${escapeAttr(field.inputId)}"
          type="${escapeAttr(field.type || 'text')}"
          name="${escapeAttr(field.envKey)}"
          value="${escapeAttr(credentials[field.envKey] || '')}"
          data-ai-credential-key="${escapeAttr(field.envKey)}"
          autocomplete="off"
          placeholder="${escapeAttr(field.placeholder || '')}"
        />
        ${field.hint ? `<div class="field-hint">${escapeHtml(field.hint)}</div>` : ''}
      </div>
    `);
  }

  return `<div class="form-grid">${fields.join('')}</div>`;
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
          <label for="ai-manager-claude-authorization-code">Authentication Code 또는 callback URL 붙여넣기</label>
          <textarea
            id="ai-manager-claude-authorization-code"
            name="claudeAuthorizationCode"
            data-ai-auth-key="authorizationCode"
            placeholder="브라우저 로그인 완료 후 표시된 Authentication Code 또는 callback URL 전체"
          >${escapeHtml(authConfig.authorizationCode || '')}</textarea>
          <div class="field-hint">로그인 버튼을 누른 뒤 브라우저 인증을 마치면 Authentication Code 또는 최종 callback URL을 얻습니다. 둘 중 하나를 그대로 붙여넣고 로그인 완료를 누르세요.</div>
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
      authorizationCode: '',
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
  setNotice('info', '로그인 창을 열었습니다. 브라우저에서 완료한 뒤 상태 확인을 누르세요.');
}

function buildAiCredentialDraft(agentType, sharedEnv) {
  if (agentType === 'local-llm') {
    return {
      connections: [],
    };
  }
  return Object.fromEntries(
    getAiManagedCredentialKeys(agentType).map((key) => [key, sharedEnv?.[key] || '']),
  );
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

function getAiManagedCredentialKeys(agentType) {
  return [];
}

function getAiCredentialFields(agentType) {
  if (agentType === 'local-llm') {
    return [];
  }
  return [];
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
      <label for="${escapeAttr(inputId)}">모델</label>
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
    <div class="field">
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
    </div>
  `;
}

function createBlankChannel() {
  return {
    name: '',
    mode: 'single',
    discordChannelId: '',
    guildId: '',
    workspace: getDefaultChannelWorkspace(),
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

function createBlankBot() {
  return {
    name: '',
    agent: state.data.agents[0]?.name || '',
    discordToken: '',
    description: '',
  };
}

function parseListText(rawValue) {
  return String(rawValue || '')
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createEnvEntry(key = '', value = '') {
  return {
    key: String(key),
    value: String(value),
  };
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

function normalizeEnvEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [createEnvEntry()];
  }
  return entries.map((entry) => createEnvEntry(entry?.key, entry?.value));
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

function parseEnvEntries(entries) {
  const output = {};

  for (const entry of normalizeEnvEntries(entries)) {
    const key = String(entry.key || '').trim();
    const value = String(entry.value || '');
    if (!key) {
      if (value) {
        throw new Error('환경 변수 키를 입력하세요.');
      }
      continue;
    }
    output[key] = value;
  }

  return output;
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

function renderAgentWizardEnvEditor(draft) {
  const entries = normalizeEnvEntries(draft.envEntries);
  return `
    <div class="env-editor">
      <div class="env-editor-head">
        <span>키</span>
        <span>값</span>
        <span></span>
      </div>
      <div class="env-editor-rows">
        ${entries
          .map(
            (entry, index) => `
              <div class="env-entry">
                <input
                  data-env-entry-field="key"
                  data-env-index="${index}"
                  placeholder="예: OPENAI_BASE_URL"
                  value="${escapeAttr(entry.key)}"
                />
                <input
                  data-env-entry-field="value"
                  data-env-index="${index}"
                  placeholder="예: http://localhost:3000/v1"
                  value="${escapeAttr(entry.value)}"
                />
                <button
                  type="button"
                  class="btn-secondary btn-inline"
                  data-action="remove-agent-env-row"
                  data-index="${index}"
                  ${entries.length === 1 ? 'disabled' : ''}
                >
                  삭제
                </button>
              </div>
            `,
          )
          .join('')}
      </div>
      <div class="actions env-editor-actions">
        <button type="button" class="btn-secondary btn-inline" data-action="add-agent-env-row">환경 변수 추가</button>
      </div>
    </div>
  `;
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
                  <strong class="card-title">${escapeHtml(entry.name)}</strong>
                  <span class="card-meta">${escapeHtml(entry.baseUrl)}</span>
                  <div class="field-hint">${entry.apiKey ? 'API 키 설정됨' : 'API 키 없음'}${entry.description ? ` · ${escapeHtml(entry.description)}` : ''}</div>
                </div>
                <div class="inline-actions">
                  <button type="button" class="btn-secondary" data-action="edit-local-llm-connection" data-name="${escapeAttr(entry.name)}" ${state.busy ? 'disabled' : ''}>수정</button>
                  <button type="button" class="btn-danger" data-action="delete-local-llm-connection" data-name="${escapeAttr(entry.name)}" ${state.busy || normalized.length <= 1 ? 'disabled' : ''}>삭제</button>
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
  if (kind === 'bot') {
    return '봇';
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
    'claude-code': 'Claude Code ACP',
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
    'claude-code': 'ACP 로그인 · 테스트',
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
    'claude-code': 'Claude Code ACP',
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
    mode: '채널 모드',
    agent: '에이전트',
    bot: '봇',
    reviewerBot: 'reviewer 봇',
    arbiterBot: 'arbiter 봇',
    discordToken: 'Discord 토큰',
    model: '모델',
    command: '명령어',
    discordChannelId: '디스코드 채널 ID',
    workspace: '워크스페이스',
    workdir: '작업경로',
  };
  return fields[key] || key;
}

function localizeErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) {
    return '오류가 발생했습니다.';
  }

  const duplicateMatch = text.match(/^(Agent|Bot|Channel|Dashboard) "(.+)" already exists\.$/u);
  if (duplicateMatch) {
    return `${localizeKind(duplicateMatch[1].toLowerCase())} "${duplicateMatch[2]}"이(가) 이미 있습니다.`;
  }

  const referencedMatch = text.match(/^Agent "(.+)" is referenced by (.+)\.$/u);
  if (referencedMatch) {
    return `에이전트 "${referencedMatch[1]}"이(가) 다른 항목에서 사용 중입니다.`;
  }

  const botReferencedMatch = text.match(/^Bot "(.+)" is referenced by channels: (.+)\.$/u);
  if (botReferencedMatch) {
    return `봇 "${botReferencedMatch[1]}"이(가) 채널에서 사용 중입니다.`;
  }

  const unknownAgentMatch = text.match(/^Channel references unknown agent "(.+)"\.$/u);
  if (unknownAgentMatch) {
    return `없는 에이전트입니다: "${unknownAgentMatch[1]}".`;
  }

  const unknownBotMatch = text.match(/^Channel references unknown bot "(.+)"\.$/u);
  if (unknownBotMatch) {
    return `없는 봇입니다: "${unknownBotMatch[1]}".`;
  }

  if (text === 'Password is required.') {
    return '비밀번호가 필요합니다.';
  }
  if (text === 'New password is required.') {
    return '새 비밀번호가 필요합니다.';
  }
  if (text === 'Current password is required.') {
    return '현재 비밀번호가 필요합니다.';
  }
  if (text === 'Current password is invalid.') {
    return '현재 비밀번호가 올바르지 않습니다.';
  }
  if (text === 'New password must be at least 8 characters.') {
    return '새 비밀번호는 8자 이상이어야 합니다.';
  }
  if (text === '비밀번호 확인이 일치하지 않습니다.') {
    return text;
  }
  if (text === 'workspace is required.') {
    return '워크스페이스 항목은 필수입니다.';
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
    return '작업경로 항목은 필수입니다.';
  }
  if (text === 'discordChannelId is required.') {
    return '디스코드 채널 ID 항목은 필수입니다.';
  }
  if (text === 'Reviewer must be different from the owner agent.') {
    return '검토 에이전트는 소유 에이전트와 달라야 합니다.';
  }
  if (text === 'Arbiter must be different from the owner agent.') {
    return '중재 에이전트는 소유 에이전트와 달라야 합니다.';
  }
  if (text === 'Arbiter must be different from the reviewer agent.') {
    return '중재 에이전트는 검토 에이전트와 달라야 합니다.';
  }
  if (text === 'Reviewer bot must be different from the owner bot.') {
    return 'reviewer 봇은 owner 봇과 달라야 합니다.';
  }
  if (text === 'Arbiter bot must be different from the owner bot.') {
    return 'arbiter 봇은 owner 봇과 달라야 합니다.';
  }
  if (text === 'Arbiter bot must be different from the reviewer bot.') {
    return 'arbiter 봇은 reviewer 봇과 달라야 합니다.';
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
  if (text === 'Single channel cannot define a reviewer bot.') {
    return '단일 채널에서는 reviewer 봇을 지정할 수 없습니다.';
  }
  if (text === 'Single channel cannot define an arbiter bot.') {
    return '단일 채널에서는 arbiter 봇을 지정할 수 없습니다.';
  }
  if (text === 'reviewRounds must be a positive integer.') {
    return '검토 회차는 1 이상의 정수여야 합니다.';
  }
  if (text === 'reviewRounds requires a tribunal channel.') {
    return '검토 회차는 검토와 중재가 함께 있을 때만 사용할 수 있습니다.';
  }
  if (text === 'fallbackAgent must be different from the agent.') {
    return '폴백 에이전트는 자기 자신과 같을 수 없습니다.';
  }
  if (text === 'timeoutMs must be a positive integer.') {
    return '제한 시간은 1 이상의 정수여야 합니다.';
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
    return 'Claude Code ACP 번들이 설치되어 있지 않습니다.';
  }
  if (/^gemini is unavailable\. Bundled dependency @google\/gemini-cli is required/u.test(text)) {
    return 'gemini 번들이 설치되어 있지 않습니다.';
  }
  if (/^Bundled runtime for agent type "codex" is not installed\.$/u.test(text)) {
    return 'codex 번들이 설치되어 있지 않습니다.';
  }
  if (/^Bundled runtime for agent type "claude-code" is not installed\.$/u.test(text)) {
    return 'Claude Code ACP 번들이 설치되어 있지 않습니다.';
  }
  if (/^Bundled runtime for agent type "gemini-cli" is not installed\.$/u.test(text)) {
    return 'gemini 번들이 설치되어 있지 않습니다.';
  }
  if (text === 'Claude Code ACP 로그인 세션이 없습니다. 먼저 로그인 버튼을 누르세요.') {
    return text;
  }
  if (text === '브라우저 완료 후 Authentication Code 또는 callback URL 전체를 붙여넣으세요.') {
    return text;
  }
  if (text === 'Authentication Code 또는 callback URL 전체를 붙여넣어야 합니다.') {
    return text;
  }
  if (text === 'Claude Code ACP 로그인 상태를 찾지 못했습니다. 다시 로그인 버튼을 누르세요.') {
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
