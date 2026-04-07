const app = document.getElementById('app');

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
  activeEditor: 'agent',
  selectedAgent: null,
  selectedChannel: null,
  selectedDashboard: null,
  agentAuth: null,
  watcherLogs: {},
  runOutput: '',
  lastRunCommand: '',
};

app.addEventListener('click', handleClick);
app.addEventListener('submit', handleSubmit);

boot().catch((error) => {
  setNotice('error', error.message);
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
  window.setInterval(() => {
    if (state.auth.enabled && !state.auth.authenticated) {
      return;
    }
    void refreshState({ quiet: true, preserveNotice: true });
  }, 15000);
}

async function refreshState({ quiet = false, preserveNotice = false } = {}) {
  if (!quiet) {
    state.loading = true;
    render();
  }

  try {
    state.data = await requestJson('/api/state');
    state.auth.authenticated = true;
    syncSelections();
    if (!preserveNotice) {
      state.notice = null;
    }
  } catch (error) {
    if (handleAuthError(error)) {
      if (!preserveNotice) {
        setNotice('info', 'Login required.');
      }
    } else {
      setNotice('error', error.message);
    }
  } finally {
    state.loading = false;
    render();
  }
}

function syncSelections() {
  if (!state.data) {
    return;
  }

  const agentNames = state.data.agents.map((agent) => agent.name);
  const channelNames = state.data.channels.map((channel) => channel.name);
  const dashboardNames = state.data.dashboards.map((dashboard) => dashboard.name);

  if (!agentNames.includes(state.selectedAgent)) {
    state.selectedAgent = agentNames[0] || null;
  }
  if (!channelNames.includes(state.selectedChannel)) {
    state.selectedChannel = channelNames[0] || null;
  }
  if (!dashboardNames.includes(state.selectedDashboard)) {
    state.selectedDashboard = dashboardNames[0] || null;
  }
}

function setActiveEditor(kind, name = null) {
  state.activeEditor = kind;
  if (kind === 'agent') {
    state.selectedAgent = name;
    if (!state.agentAuth || state.agentAuth.agentName !== name) {
      state.agentAuth = null;
    }
  }
  if (kind === 'channel') {
    state.selectedChannel = name;
  }
  if (kind === 'dashboard') {
    state.selectedDashboard = name;
  }
}

function handleClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (action === 'refresh') {
    void refreshState();
    return;
  }

  if (action === 'logout') {
    void logout();
    return;
  }

  if (action === 'new-agent') {
    setActiveEditor('agent', null);
    render();
    return;
  }

  if (action === 'select-agent') {
    setActiveEditor('agent', button.dataset.name || null);
    render();
    void runAgentAuth('status', { silent: true, useBusy: false });
    return;
  }

  if (action === 'new-channel') {
    setActiveEditor('channel', null);
    render();
    return;
  }

  if (action === 'select-channel') {
    setActiveEditor('channel', button.dataset.name || null);
    render();
    return;
  }

  if (action === 'new-dashboard') {
    setActiveEditor('dashboard', null);
    render();
    return;
  }

  if (action === 'select-dashboard') {
    setActiveEditor('dashboard', button.dataset.name || null);
    render();
    return;
  }

  if (action === 'switch-editor') {
    state.activeEditor = button.dataset.kind || 'agent';
    render();
    if (state.activeEditor === 'agent' && state.selectedAgent) {
      void runAgentAuth('status', { silent: true, useBusy: false });
    }
    return;
  }

  if (action === 'delete-agent') {
    void deleteEntity('agent', button.dataset.name);
    return;
  }

  if (action === 'delete-channel') {
    void deleteEntity('channel', button.dataset.name);
    return;
  }

  if (action === 'delete-dashboard') {
    void deleteEntity('dashboard', button.dataset.name);
    return;
  }

  if (action === 'load-watcher-log') {
    void loadWatcherLog(button.dataset.id);
    return;
  }

  if (action === 'agent-auth-status' || action === 'agent-auth-login' || action === 'agent-auth-logout') {
    void runAgentAuth(action.replace('agent-auth-', ''));
    return;
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

    if (kind === 'agent') {
      await saveAgent(form);
      return;
    }

    if (kind === 'channel') {
      await saveChannel(form);
      return;
    }

    if (kind === 'dashboard') {
      await saveDashboard(form);
      return;
    }

    if (kind === 'shared-env') {
      await saveSharedEnv(form);
      return;
    }

    if (kind === 'admin-password') {
      await changeAdminPassword(form);
      return;
    }

    if (kind === 'run') {
      await runOneShot(form);
    }
  } catch (error) {
    setNotice('error', error.message);
    render();
  }
}

async function saveAgent(form) {
  const values = new FormData(form);
  const definition = {
    name: requiredText(values, 'name'),
    agent: requiredText(values, 'agent'),
    fallbackAgent: optionalText(values, 'fallbackAgent'),
    model: optionalText(values, 'model'),
    effort: optionalText(values, 'effort'),
    timeoutMs: optionalText(values, 'timeoutMs'),
    systemPrompt: optionalText(values, 'systemPrompt'),
    systemPromptFile: optionalText(values, 'systemPromptFile'),
    skills: parseListText(values.get('skillsText')),
    contextFiles: parseListText(values.get('contextFilesText')),
    env: parseEnvText(values.get('envText')),
    sandbox: optionalText(values, 'sandbox'),
    permissionMode: optionalText(values, 'permissionMode'),
    dangerous: values.get('dangerous') === 'on',
    baseUrl: optionalText(values, 'baseUrl'),
    command: optionalText(values, 'command'),
  };

  const currentName = optionalText(values, 'currentName');
  const response = await mutateJson('/api/agents', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.selectedAgent = definition.name;
  syncSelections();
  setNotice('info', currentName ? `Updated agent "${definition.name}".` : `Added agent "${definition.name}".`);
  render();
  if (isAuthSupportedAgent(definition.agent)) {
    void runAgentAuth('status', { silent: true, useBusy: false });
  }
}

async function saveChannel(form) {
  const values = new FormData(form);
  const definition = {
    name: requiredText(values, 'name'),
    discordChannelId: requiredText(values, 'discordChannelId'),
    guildId: optionalText(values, 'guildId'),
    workdir: requiredText(values, 'workdir'),
    agent: requiredText(values, 'agent'),
    reviewer: optionalText(values, 'reviewer'),
    arbiter: optionalText(values, 'arbiter'),
    reviewRounds: optionalText(values, 'reviewRounds'),
    description: optionalText(values, 'description'),
  };

  const currentName = optionalText(values, 'currentName');
  const response = await mutateJson('/api/channels', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.selectedChannel = definition.name;
  syncSelections();
  setNotice(
    'info',
    currentName ? `Updated channel "${definition.name}".` : `Added channel "${definition.name}".`,
  );
  render();
}

async function saveDashboard(form) {
  const values = new FormData(form);
  const definition = {
    name: requiredText(values, 'name'),
    monitors: parseListText(values.get('monitorsText')),
    refreshMs: requiredText(values, 'refreshMs'),
    showDetails: values.get('showDetails') === 'on',
  };

  const currentName = optionalText(values, 'currentName');
  const response = await mutateJson('/api/dashboards', {
    method: 'POST',
    body: {
      currentName,
      definition,
    },
  });

  state.data = response.state;
  state.selectedDashboard = definition.name;
  syncSelections();
  setNotice(
    'info',
    currentName
      ? `Updated dashboard "${definition.name}".`
      : `Added dashboard "${definition.name}".`,
  );
  render();
}

async function saveSharedEnv(form) {
  const values = new FormData(form);
  const sharedEnv = parseEnvText(values.get('sharedEnvText'));
  const response = await mutateJson('/api/shared-env', {
    method: 'PUT',
    body: {
      sharedEnv,
    },
  });

  state.data = response.state;
  syncSelections();
  setNotice('info', 'Updated shared env.');
  render();
}

async function changeAdminPassword(form) {
  const values = new FormData(form);
  const currentPassword = optionalText(values, 'currentPassword');
  const newPassword = requiredText(values, 'newPassword');
  const confirmPassword = requiredText(values, 'confirmPassword');

  if (newPassword !== confirmPassword) {
    throw new Error('New password does not match.');
  }

  const response = await mutateJson('/api/admin-password', {
    method: 'PUT',
    body: {
      currentPassword,
      newPassword,
    },
  });

  state.auth = response.auth || state.auth;
  setNotice('info', 'Password updated.');
  form.reset();
  render();
}

async function login(form) {
  const values = new FormData(form);
  const password = requiredText(values, 'password');
  const response = await mutateJson('/api/login', {
    method: 'POST',
    body: {
      password,
    },
  });

  state.auth = response;
  state.loading = false;
  setNotice('info', 'Signed in.');
  await refreshState({ quiet: true, preserveNotice: true });
}

async function logout() {
  const response = await mutateJson('/api/logout', {
    method: 'POST',
  });
  state.auth = response;
  state.data = null;
  state.runOutput = '';
  state.lastRunCommand = '';
  setNotice('info', 'Signed out.');
  render();
}

async function runAgentAuth(action, options = {}) {
  const agent = state.data?.agents.find((entry) => entry.name === state.selectedAgent);
  if (!agent) {
    throw new Error('Select an agent first.');
  }
  if (!isAuthSupportedAgent(agent.agent)) {
    throw new Error(`Auth actions are not supported for ${agent.agent}.`);
  }

  const request = options.useBusy === false ? requestJson : mutateJson;
  const response = await request('/api/agent-auth', {
    method: 'POST',
    body: {
      agentName: agent.name,
      agentType: agent.agent,
      action,
    },
  });

  state.agentAuth = {
    ...response.result,
    agentName: agent.name,
  };
  if (!options.silent) {
    setNotice('info', `${action} finished for ${agent.name}.`);
  }
  render();
}

async function runOneShot(form) {
  const values = new FormData(form);
  const mode = requiredText(values, 'mode');
  const payload = {
    prompt: requiredText(values, 'prompt'),
  };

  if (mode === 'channel') {
    payload.channelName = requiredText(values, 'channelName');
  } else {
    payload.agentName = requiredText(values, 'agentName');
    payload.workdir = optionalText(values, 'workdir');
  }

  const response = await mutateJson('/api/run', {
    method: 'POST',
    body: payload,
  });

  state.runOutput = response.result.output || '(no output)';
  state.lastRunCommand = response.result.command || '';
  setNotice('info', 'Completed one-shot run.');
  render();
}

async function deleteEntity(kind, name) {
  if (!name) {
    return;
  }

  const confirmed = window.confirm(`Delete ${kind} "${name}"?`);
  if (!confirmed) {
    return;
  }

  const response = await mutateJson(`/api/${kind}s/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

  state.data = response.state;
  if (kind === 'agent' && state.selectedAgent === name) {
    state.selectedAgent = null;
  }
  if (kind === 'channel' && state.selectedChannel === name) {
    state.selectedChannel = null;
  }
  if (kind === 'dashboard' && state.selectedDashboard === name) {
    state.selectedDashboard = null;
  }
  syncSelections();
  setNotice('info', `Deleted ${kind} "${name}".`);
  render();
}

async function loadWatcherLog(watcherId) {
  if (!watcherId) {
    return;
  }

  const response = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}/log`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      handleAuthPayload(payload.auth);
      setNotice('info', 'Login required.');
      render();
      return;
    }
    throw new Error(payload.error || `Failed to load watcher log (${response.status}).`);
  }

  state.watcherLogs[watcherId] = await response.text();
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
      const error = new Error(payload.error || 'Authentication required.');
      error.code = 'AUTH_REQUIRED';
      error.auth = payload.auth || null;
      throw error;
    }
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function setNotice(type, text) {
  state.notice = { type, text };
}

function handleAuthError(error) {
  if (error?.code !== 'AUTH_REQUIRED') {
    return false;
  }
  handleAuthPayload(error.auth);
  state.data = null;
  state.runOutput = '';
  state.lastRunCommand = '';
  return true;
}

function handleAuthPayload(authPayload) {
  state.auth = {
    ...state.auth,
    ...(authPayload || {}),
    authenticated: false,
  };
}

function render() {
  if (!state.data && state.loading) {
    app.innerHTML = '<div class="shell"><div class="empty-state">Loading...</div></div>';
    return;
  }

  if (state.auth.enabled && !state.auth.authenticated) {
    app.innerHTML = `
      <div class="shell auth-shell">
        ${renderNotice()}
        <section class="panel">
          <div class="section-title">
            <div>
              <h1>Admin</h1>
            </div>
          </div>
          <form data-form="login" class="stack">
            <div class="field">
              <label for="login-password">Password</label>
              <input id="login-password" name="password" type="password" autocomplete="current-password" />
            </div>
            <div class="form-actions">
              <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Login</button>
            </div>
          </form>
        </section>
      </div>
    `;
    return;
  }

  if (!state.data) {
    app.innerHTML = '<div class="shell"><div class="empty-state">No data.</div></div>';
    return;
  }

  const { data } = state;
  const selectedAgent = data.agents.find((agent) => agent.name === state.selectedAgent) || null;
  const selectedChannel =
    data.channels.find((channel) => channel.name === state.selectedChannel) || null;
  const selectedDashboard =
    data.dashboards.find((dashboard) => dashboard.name === state.selectedDashboard) || null;

  app.innerHTML = `
    <div class="shell">
      ${renderNotice()}
      <div class="layout">
        <section class="selector-grid">
          ${renderSelectorPanel({
            kind: 'agent',
            title: 'Agents',
            count: data.agents.length,
            newAction: 'new-agent',
            listHtml: renderAgentList(data.agents),
          })}
          ${renderSelectorPanel({
            kind: 'channel',
            title: 'Channels',
            count: data.channels.length,
            newAction: 'new-channel',
            listHtml: renderChannelList(data.channels, data.agents),
          })}
          ${renderSelectorPanel({
            kind: 'dashboard',
            title: 'Dashboards',
            count: data.dashboards.length,
            newAction: 'new-dashboard',
            listHtml: renderDashboardList(data.dashboards),
          })}
        </section>

        ${renderEditorPanel(data, selectedAgent, selectedChannel, selectedDashboard)}

        <section class="two-up two-up--ops">
          <div class="panel">
            <div class="section-title">
              <div>
                <h2>Env</h2>
              </div>
              <div class="toolbar">
                <button class="btn-secondary" data-action="refresh" ${state.busy ? 'disabled' : ''}>Refresh</button>
                ${
                  state.auth.enabled
                    ? `<button class="btn-secondary" data-action="logout" ${state.busy ? 'disabled' : ''}>Logout</button>`
                    : ''
                }
              </div>
            </div>
            ${renderSharedEnvForm(data.sharedEnv)}
            <div class="run-output-block">
              <div class="line-row line-row--split">
                <h3>Password</h3>
              </div>
              ${renderAdminPasswordForm()}
            </div>
          </div>

          <div class="panel">
            <div class="section-title">
              <div>
                <h2>Run</h2>
              </div>
            </div>
            ${renderRunForm(data)}
            <div class="run-output-block">
              <div class="line-row line-row--split">
                <h3>Output</h3>
              </div>
              <div class="run-output">${state.runOutput ? escapeHtml(state.runOutput) : 'No output.'}</div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="section-title">
            <div>
              <h2>Watchers</h2>
            </div>
          </div>
          ${renderWatcherList(data.watchers)}
        </section>
      </div>
    </div>
  `;
}

function renderNotice() {
  if (!state.notice) {
    return '';
  }
  return `<div class="notice ${state.notice.type === 'error' ? 'is-error' : 'is-info'}">${escapeHtml(state.notice.text)}</div>`;
}

function renderSelectorPanel({ kind, title, count, newAction, listHtml }) {
  return `
    <section class="panel selector-panel ${state.activeEditor === kind ? 'selector-panel--active' : ''}">
      <div class="section-title">
        <div>
          <h2>${escapeHtml(title)}</h2>
        </div>
        <div class="toolbar">
          <span class="list-count">${escapeHtml(String(count))}</span>
          <button class="btn-secondary" data-action="${escapeAttr(newAction)}" ${state.busy ? 'disabled' : ''}>New</button>
        </div>
      </div>
      <div class="list list--compact">${listHtml}</div>
    </section>
  `;
}

function renderEditorPanel(data, selectedAgent, selectedChannel, selectedDashboard) {
  if (state.activeEditor === 'channel') {
    return `
      <section class="panel editor-panel">
        <div class="section-title editor-title">
          <div>
            <h2>Channel</h2>
          </div>
          <div class="editor-tabs">
            ${renderEditorTabs()}
          </div>
        </div>
        <div class="editor-shell">
          ${renderChannelEditorSummary(selectedChannel)}
          <div class="editor-form-shell">
            <div class="editor-form-head">
              <h3>${selectedChannel ? escapeHtml(selectedChannel.name) : 'New'}</h3>
            </div>
            ${renderChannelForm(selectedChannel, data)}
          </div>
        </div>
      </section>
    `;
  }

  if (state.activeEditor === 'dashboard') {
    return `
      <section class="panel editor-panel">
        <div class="section-title editor-title">
          <div>
            <h2>Dashboard</h2>
          </div>
          <div class="editor-tabs">
            ${renderEditorTabs()}
          </div>
        </div>
        <div class="editor-shell">
          ${renderDashboardEditorSummary(selectedDashboard)}
          <div class="editor-form-shell">
            <div class="editor-form-head">
              <h3>${selectedDashboard ? escapeHtml(selectedDashboard.name) : 'New'}</h3>
            </div>
            ${renderDashboardForm(selectedDashboard, data)}
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="panel editor-panel">
      <div class="section-title editor-title">
        <div>
          <h2>Agent</h2>
        </div>
        <div class="editor-tabs">
          ${renderEditorTabs()}
        </div>
      </div>
      <div class="editor-shell">
        ${renderAgentEditorSummary(selectedAgent)}
        <div class="editor-form-shell">
          <div class="editor-form-head">
            <h3>${selectedAgent ? escapeHtml(selectedAgent.name) : 'New'}</h3>
          </div>
          ${renderAgentForm(selectedAgent, data)}
        </div>
      </div>
    </section>
  `;
}

function renderEditorTabs() {
  return ['agent', 'channel', 'dashboard']
    .map(
      (kind) => `
        <button
          class="tab-chip ${state.activeEditor === kind ? 'is-active' : ''}"
          data-action="switch-editor"
          data-kind="${escapeAttr(kind)}"
          ${state.busy ? 'disabled' : ''}
        >
          ${escapeHtml(kind)}
        </button>
      `,
    )
    .join('');
}

function renderAgentEditorSummary(agent) {
  return `
    <aside class="editor-summary">
      <h3>${escapeHtml(agent?.name || 'New agent')}</h3>
      ${agent ? `<p class="list-meta">${escapeHtml(agent.agent)}${agent.model ? ` @ ${escapeHtml(agent.model)}` : ''}</p>` : ''}
      <div class="summary-grid">
        ${renderSummaryItem('Runtime', agent ? (agent.runtime.ready ? 'Ready' : 'Missing') : 'Pending')}
        ${renderSummaryItem('Fallback', agent?.fallbackAgent || 'None')}
        ${renderSummaryItem('Channels', String(agent?.mappedChannelNames?.length || 0))}
        ${renderSummaryItem('Workdirs', String(agent?.workdirs?.length || 0))}
      </div>
      ${renderAgentAuthBox(agent)}
    </aside>
  `;
}

function renderChannelEditorSummary(channel) {
  const tribunalEnabled = Boolean(channel?.reviewer && channel?.arbiter);
  return `
    <aside class="editor-summary">
      <h3>${escapeHtml(channel?.name || 'New channel')}</h3>
      ${channel ? `<p class="list-meta">discord ${escapeHtml(channel.discordChannelId)}</p>` : ''}
      <div class="summary-grid">
        ${renderSummaryItem('Owner', channel?.agent || 'Unset')}
        ${renderSummaryItem('Mode', tribunalEnabled ? 'Tribunal' : 'Single')}
        ${renderSummaryItem('Workdir', channel?.workdir || 'Unset')}
        ${renderSummaryItem('Rounds', channel?.reviewRounds || 'Default')}
      </div>
    </aside>
  `;
}

function renderDashboardEditorSummary(dashboard) {
  return `
    <aside class="editor-summary">
      <h3>${escapeHtml(dashboard?.name || 'New dashboard')}</h3>
      ${dashboard ? `<p class="list-meta">${escapeHtml(formatDashboardMonitorText(dashboard.monitors || []))}</p>` : ''}
      <div class="summary-grid">
        ${renderSummaryItem('Monitors', dashboard ? String(resolveMonitorCount(dashboard.monitors)) : '0')}
        ${renderSummaryItem('Refresh', dashboard?.refreshMs ? `${dashboard.refreshMs} ms` : 'Default')}
        ${renderSummaryItem('Details', dashboard?.showDetails ? 'Shown' : 'Hidden')}
        ${renderSummaryItem('Scope', dashboard?.monitors?.includes('all') || dashboard?.monitors?.includes('*') ? 'All agents' : 'Selected')}
      </div>
    </aside>
  `;
}

function renderSummaryItem(label, value) {
  return `
    <div class="summary-item">
      <span class="summary-label">${escapeHtml(label)}</span>
      <strong class="summary-value">${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function renderAgentAuthBox(agent) {
  if (!agent || !isAuthSupportedAgent(agent.agent)) {
    return '';
  }

  const result =
    state.agentAuth && state.agentAuth.agentName === agent.name ? state.agentAuth : null;

  return `
    <div class="auth-box">
      <div class="line-row line-row--split">
        <h4>Auth</h4>
        <span class="pill">${escapeHtml(agent.agent)}</span>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn-secondary" data-action="agent-auth-status" ${state.busy ? 'disabled' : ''}>Status</button>
        <button class="btn-secondary" data-action="agent-auth-login" ${state.busy ? 'disabled' : ''}>Login</button>
        <button class="btn-secondary" data-action="agent-auth-logout" ${state.busy ? 'disabled' : ''}>Logout</button>
      </div>
      ${renderAgentAuthResult(result)}
    </div>
  `;
}

function renderAgentAuthResult(result) {
  if (!result) {
    return '';
  }

  const details = result.details || {};
  return `
    <div class="auth-result">
      <p class="mini-note">${escapeHtml(details.summary || result.output || 'Done')}</p>
      ${
        details.url
          ? `<a class="auth-link mono" href="${escapeAttr(details.url)}" target="_blank" rel="noreferrer">${escapeHtml(details.url)}</a>`
          : ''
      }
      ${
        details.code
          ? `<div class="auth-code">${escapeHtml(details.code)}</div>`
          : ''
      }
      ${!details.url && !details.code ? `<pre class="watcher-log">${escapeHtml(result.output)}</pre>` : ''}
    </div>
  `;
}

function renderAgentList(agents) {
  if (agents.length === 0) {
    return '<div class="empty-state">No agents.</div>';
  }

  return agents
    .map((agent) => {
      const selected = agent.name === state.selectedAgent;
      return `
        <article class="list-item ${selected ? 'is-selected' : ''}">
          <div class="section-title">
            <div>
              <h3>${escapeHtml(agent.name)}</h3>
              <p class="list-meta">${escapeHtml(agent.agent)}${agent.model ? ` @ ${escapeHtml(agent.model)}` : ''}</p>
            </div>
            <div class="toolbar">
              <button class="btn-secondary" data-action="select-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>Edit</button>
              <button class="btn-danger" data-action="delete-agent" data-name="${escapeAttr(agent.name)}" ${state.busy ? 'disabled' : ''}>Delete</button>
            </div>
          </div>
          <p class="mini-note">
            <span class="status-dot ${agent.runtime.ready ? 'is-ok' : ''}"></span>
            ${escapeHtml(agent.runtime.ready ? 'ready' : 'missing')}
          </p>
        </article>
      `;
    })
    .join('');
}

function renderChannelList(channels, agents) {
  if (channels.length === 0) {
    return '<div class="empty-state">No channels.</div>';
  }

  const agentMap = new Map(agents.map((agent) => [agent.name, agent]));
  return channels
    .map((channel) => {
      const selected = channel.name === state.selectedChannel;
      const owner = agentMap.get(channel.agent);
      return `
        <article class="list-item ${selected ? 'is-selected' : ''}">
          <div class="section-title">
            <div>
              <h3>${escapeHtml(channel.name)}</h3>
              <p class="list-meta">discord ${escapeHtml(channel.discordChannelId)}</p>
            </div>
            <div class="toolbar">
              <button class="btn-secondary" data-action="select-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>Edit</button>
              <button class="btn-danger" data-action="delete-channel" data-name="${escapeAttr(channel.name)}" ${state.busy ? 'disabled' : ''}>Delete</button>
            </div>
          </div>
          <p class="mini-note">${escapeHtml(channel.agent)}${owner ? ` (${escapeHtml(owner.agent)})` : ''}</p>
          <p class="mini-note">${escapeHtml(channel.workdir)}</p>
        </article>
      `;
    })
    .join('');
}

function renderDashboardList(dashboards) {
  if (dashboards.length === 0) {
    return '<div class="empty-state">No dashboards.</div>';
  }

  return dashboards
    .map((dashboard) => {
      const selected = dashboard.name === state.selectedDashboard;
      return `
        <article class="list-item ${selected ? 'is-selected' : ''}">
          <div class="section-title">
            <div>
              <h3>${escapeHtml(dashboard.name)}</h3>
              <p class="list-meta">${escapeHtml(formatDashboardMonitorText(dashboard.monitors || []))}</p>
            </div>
            <div class="toolbar">
              <button class="btn-secondary" data-action="select-dashboard" data-name="${escapeAttr(dashboard.name)}" ${state.busy ? 'disabled' : ''}>Edit</button>
              <button class="btn-danger" data-action="delete-dashboard" data-name="${escapeAttr(dashboard.name)}" ${state.busy ? 'disabled' : ''}>Delete</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderAgentForm(agent, data) {
  const current = agent || createBlankAgent(data);
  return `
    <form data-form="agent">
      <input type="hidden" name="currentName" value="${escapeAttr(agent?.name || '')}" />
      <div class="field-grid">
        <div class="field">
          <label for="agent-name">Name</label>
          <input id="agent-name" name="name" value="${escapeAttr(current.name)}" />
        </div>
        <div class="field">
          <label for="agent-type">Type</label>
          <select id="agent-type" name="agent">${renderOptions(data.choices.agentTypes, current.agent)}</select>
        </div>
        <div class="field">
          <label for="agent-model">Model</label>
          <input id="agent-model" name="model" value="${escapeAttr(current.model)}" />
        </div>
        <div class="field">
          <label for="agent-effort">Effort</label>
          <input id="agent-effort" name="effort" value="${escapeAttr(current.effort)}" />
        </div>
        <div class="field">
          <label for="agent-timeout">Timeout ms</label>
          <input id="agent-timeout" name="timeoutMs" value="${escapeAttr(current.timeoutMs)}" />
        </div>
        <div class="field">
          <label for="agent-fallback">Fallback agent</label>
          <select id="agent-fallback" name="fallbackAgent">
            ${renderNameOptions(data.agents.map((entry) => entry.name), current.fallbackAgent, true)}
          </select>
        </div>
        <div class="field">
          <label for="agent-sandbox">Codex sandbox</label>
          <select id="agent-sandbox" name="sandbox">${renderOptions(data.choices.codexSandboxes, current.sandbox, true)}</select>
        </div>
        <div class="field">
          <label for="agent-permission">Claude permission mode</label>
          <select id="agent-permission" name="permissionMode">${renderOptions(data.choices.claudePermissionModes, current.permissionMode, true)}</select>
        </div>
        <div class="field">
          <label for="agent-base-url">Local LLM base URL</label>
          <input id="agent-base-url" name="baseUrl" value="${escapeAttr(current.baseUrl)}" />
        </div>
        <div class="field">
          <label for="agent-command">Command</label>
          <input id="agent-command" name="command" value="${escapeAttr(current.command)}" />
        </div>
        <div class="field is-full">
          <label for="agent-system">System prompt</label>
          <textarea id="agent-system" name="systemPrompt">${escapeHtml(current.systemPrompt)}</textarea>
        </div>
        <div class="field is-full">
          <label for="agent-system-file">System prompt file</label>
          <input id="agent-system-file" name="systemPromptFile" value="${escapeAttr(current.systemPromptFile)}" />
        </div>
        <div class="field is-full">
          <label for="agent-skills">Skills</label>
          <textarea id="agent-skills" name="skillsText">${escapeHtml(joinList(current.skills))}</textarea>
        </div>
        <div class="field is-full">
          <label for="agent-context">Context files</label>
          <textarea id="agent-context" name="contextFilesText">${escapeHtml(joinList(current.contextFiles))}</textarea>
        </div>
        <div class="field is-full">
          <label for="agent-env">Env</label>
          <textarea id="agent-env" name="envText">${escapeHtml(joinEnv(current.env))}</textarea>
        </div>
        <div class="field is-full">
          <label>Dangerous</label>
          <div class="checkbox-row">
            <input id="agent-dangerous" type="checkbox" name="dangerous" ${current.dangerous ? 'checked' : ''} />
            <label for="agent-dangerous" style="text-transform:none;letter-spacing:0;color:inherit;font-size:0.96rem">
              Enabled
            </label>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Save agent</button>
      </div>
    </form>
  `;
}

function renderChannelForm(channel, data) {
  const current = channel || createBlankChannel(data);
  return `
    <form data-form="channel">
      <input type="hidden" name="currentName" value="${escapeAttr(channel?.name || '')}" />
      <div class="field-grid">
        <div class="field">
          <label for="channel-name">Name</label>
          <input id="channel-name" name="name" value="${escapeAttr(current.name)}" />
        </div>
        <div class="field">
          <label for="channel-discord">Discord channel ID</label>
          <input id="channel-discord" name="discordChannelId" value="${escapeAttr(current.discordChannelId)}" />
        </div>
        <div class="field">
          <label for="channel-guild">Guild ID</label>
          <input id="channel-guild" name="guildId" value="${escapeAttr(current.guildId)}" />
        </div>
        <div class="field">
          <label for="channel-workdir">Workdir</label>
          <input id="channel-workdir" name="workdir" value="${escapeAttr(current.workdir)}" />
        </div>
        <div class="field">
          <label for="channel-agent">Owner agent</label>
          <select id="channel-agent" name="agent">${renderNameOptions(data.agents.map((entry) => entry.name), current.agent)}</select>
        </div>
        <div class="field">
          <label for="channel-reviewer">Reviewer</label>
          <select id="channel-reviewer" name="reviewer">${renderNameOptions(data.agents.map((entry) => entry.name), current.reviewer, true)}</select>
        </div>
        <div class="field">
          <label for="channel-arbiter">Arbiter</label>
          <select id="channel-arbiter" name="arbiter">${renderNameOptions(data.agents.map((entry) => entry.name), current.arbiter, true)}</select>
        </div>
        <div class="field">
          <label for="channel-rounds">Review rounds</label>
          <input id="channel-rounds" name="reviewRounds" value="${escapeAttr(current.reviewRounds)}" />
        </div>
        <div class="field is-full">
          <label for="channel-description">Description</label>
          <textarea id="channel-description" name="description">${escapeHtml(current.description)}</textarea>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Save channel</button>
      </div>
    </form>
  `;
}

function renderDashboardForm(dashboard, data) {
  const current = dashboard || createBlankDashboard();
  return `
    <form data-form="dashboard">
      <input type="hidden" name="currentName" value="${escapeAttr(dashboard?.name || '')}" />
      <div class="field-grid">
        <div class="field">
          <label for="dashboard-name">Name</label>
          <input id="dashboard-name" name="name" value="${escapeAttr(current.name)}" />
        </div>
        <div class="field">
          <label for="dashboard-refresh">Refresh ms</label>
          <input id="dashboard-refresh" name="refreshMs" value="${escapeAttr(current.refreshMs)}" />
        </div>
        <div class="field is-full">
          <label for="dashboard-monitors">Monitors</label>
          <textarea id="dashboard-monitors" name="monitorsText">${escapeHtml(joinList(current.monitors))}</textarea>
        </div>
        <div class="field is-full">
          <label>Details</label>
          <div class="checkbox-row">
            <input id="dashboard-details" type="checkbox" name="showDetails" ${current.showDetails ? 'checked' : ''} />
            <label for="dashboard-details" style="text-transform:none;letter-spacing:0;color:inherit;font-size:0.96rem">
              Show
            </label>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Save dashboard</button>
      </div>
    </form>
  `;
}

function renderSharedEnvForm(sharedEnv) {
  return `
    <form data-form="shared-env">
      <div class="field">
        <label for="shared-env-text">Shared env</label>
        <textarea id="shared-env-text" name="sharedEnvText">${escapeHtml(joinEnv(sharedEnv))}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Save shared env</button>
      </div>
    </form>
  `;
}

function renderAdminPasswordForm() {
  return `
    <form data-form="admin-password">
      <div class="field-grid">
        <div class="field">
          <label for="admin-current-password">Current</label>
          <input id="admin-current-password" name="currentPassword" type="password" autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="admin-new-password">New</label>
          <input id="admin-new-password" name="newPassword" type="password" autocomplete="new-password" />
        </div>
        <div class="field is-full">
          <label for="admin-confirm-password">Confirm</label>
          <input id="admin-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Change password</button>
      </div>
    </form>
  `;
}

function renderRunForm(data) {
  const defaultChannel = data.channels[0]?.name || '';
  const defaultAgent = data.agents[0]?.name || '';
  return `
    <form data-form="run">
      <div class="field-grid">
        <div class="field">
          <label for="run-mode">Mode</label>
          <select id="run-mode" name="mode">
            <option value="channel">Channel</option>
            <option value="agent">Agent</option>
          </select>
        </div>
        <div class="field">
          <label for="run-channel">Channel</label>
          <select id="run-channel" name="channelName">${renderNameOptions(data.channels.map((entry) => entry.name), defaultChannel, true)}</select>
        </div>
        <div class="field">
          <label for="run-agent">Agent</label>
          <select id="run-agent" name="agentName">${renderNameOptions(data.agents.map((entry) => entry.name), defaultAgent, true)}</select>
        </div>
        <div class="field">
          <label for="run-workdir">Workdir</label>
          <input id="run-workdir" name="workdir" placeholder="./workspace" />
        </div>
        <div class="field is-full">
          <label for="run-prompt">Prompt</label>
          <textarea id="run-prompt" name="prompt"></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>Run now</button>
      </div>
    </form>
  `;
}

function renderWatcherList(watchers) {
  if (watchers.length === 0) {
    return '<div class="empty-state">No watchers.</div>';
  }

  return `
    <div class="watchers">
      ${watchers
        .map((watcher) => {
          const log = state.watcherLogs[watcher.id];
          return `
            <article class="watcher-card">
              <div class="watcher-head">
                <h3>${escapeHtml(watcher.id)}</h3>
                <span class="pill">${escapeHtml(watcher.provider)}</span>
                <span class="pill">${escapeHtml(watcher.status)}</span>
              </div>
              <p class="watcher-meta">${escapeHtml(watcher.label || watcher.provider)}</p>
              <p class="watcher-meta">updated: ${escapeHtml(watcher.updatedAt)}</p>
              <p class="watcher-meta">result: ${escapeHtml(watcher.resultSummary || watcher.lastSummary || 'n/a')}</p>
              ${
                watcher.hasLog
                  ? `<div class="form-actions" style="margin-top:12px">
                      <button class="btn-secondary" data-action="load-watcher-log" data-id="${escapeAttr(watcher.id)}" ${state.busy ? 'disabled' : ''}>Load log</button>
                    </div>`
                  : ''
              }
              ${log !== undefined ? `<pre class="watcher-log">${escapeHtml(log || '(empty log)')}</pre>` : ''}
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function createBlankAgent(data) {
  return {
    name: '',
    agent: data.choices.agentTypes[0]?.value || 'codex',
    fallbackAgent: '',
    model: '',
    effort: '',
    timeoutMs: '',
    systemPrompt: '',
    systemPromptFile: '',
    skills: [],
    contextFiles: [],
    env: {},
    sandbox: data.choices.codexSandboxes[0]?.value || '',
    permissionMode: data.choices.claudePermissionModes[0]?.value || '',
    dangerous: false,
    baseUrl: 'http://127.0.0.1:11434/v1',
    command: '',
  };
}

function createBlankChannel(data) {
  return {
    name: '',
    discordChannelId: '',
    guildId: '',
    workdir: '.',
    agent: data.agents[0]?.name || '',
    reviewer: '',
    arbiter: '',
    reviewRounds: '',
    description: '',
  };
}

function createBlankDashboard() {
  return {
    name: '',
    monitors: ['all'],
    refreshMs: '5000',
    showDetails: true,
  };
}

function isAuthSupportedAgent(agentType) {
  return ['codex', 'claude-code'].includes(agentType);
}

function formatDashboardMonitorText(monitors) {
  const items = Array.isArray(monitors) ? monitors : [];
  if (items.length === 0 || items.includes('*') || items.includes('all')) {
    return 'all agents';
  }
  return items.join(', ');
}

function resolveMonitorCount(monitors) {
  const items = Array.isArray(monitors) ? monitors : [];
  if (items.length === 0 || items.includes('*') || items.includes('all')) {
    return 'all';
  }
  return items.length;
}

function parseListText(rawValue) {
  return String(rawValue || '')
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvText(rawValue) {
  const output = {};
  const entries = String(rawValue || '')
    .split(/\n+/u)
    .flatMap((line) => line.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`Env entries must use KEY=VALUE format: "${entry}"`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1);
    output[key] = value;
  }

  return output;
}

function joinList(values) {
  return Array.isArray(values) ? values.join('\n') : '';
}

function joinEnv(env) {
  return Object.entries(env || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function requiredText(formData, key) {
  const value = optionalText(formData, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
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
    entries.push('<option value=""></option>');
  }
  for (const option of options || []) {
    entries.push(
      `<option value="${escapeAttr(option.value)}" ${
        option.value === selectedValue ? 'selected' : ''
      }>${escapeHtml(option.label)}</option>`,
    );
  }
  return entries.join('');
}

function renderNameOptions(names, selectedValue, allowEmpty = false) {
  const entries = [];
  if (allowEmpty) {
    entries.push('<option value=""></option>');
  }
  for (const name of names) {
    entries.push(
      `<option value="${escapeAttr(name)}" ${name === selectedValue ? 'selected' : ''}>${escapeHtml(name)}</option>`,
    );
  }
  return entries.join('');
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
