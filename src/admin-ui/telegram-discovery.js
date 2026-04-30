export function applyTelegramRecentChatToDraft(draft, recentChat = {}) {
  if (!draft) {
    return null;
  }

  const chatType = optionalText(recentChat.chatType) || optionalText(recentChat.type);
  draft.platform = 'telegram';
  draft.telegramChatId = optionalText(recentChat.chatId);
  draft.telegramThreadId = optionalText(recentChat.threadId);

  if (chatType === 'private') {
    draft.targetType = 'direct';
    draft.telegramThreadId = '';
  } else if (!draft.targetType || draft.targetType === 'direct') {
    draft.targetType = 'channel';
  }

  const agentName = optionalText(recentChat.agentName);
  if (agentName && !optionalText(draft.agent)) {
    draft.agent = agentName;
  }

  return draft;
}

export function getTelegramRecentChatCandidates(channel, recentChats = []) {
  const entries = Array.isArray(recentChats) ? recentChats : [];
  const selectedAgent = optionalText(channel?.agent);
  const filtered = selectedAgent
    ? entries.filter(
        (entry) => !optionalText(entry?.agentName) || optionalText(entry.agentName) === selectedAgent,
      )
    : entries;
  return filtered.filter((entry) => optionalText(entry?.chatId));
}

export function formatTelegramRecentChatTitle(entry = {}) {
  const title = optionalText(entry.title);
  if (title) {
    return title;
  }
  const username = optionalText(entry.username);
  if (username) {
    return `@${username}`;
  }
  const fromUsername = optionalText(entry.fromUsername);
  if (fromUsername) {
    return `@${fromUsername}`;
  }
  const fromName = optionalText(entry.fromName);
  if (fromName) {
    return fromName;
  }
  return optionalText(entry.type) === 'private' ? 'Telegram 개인 대화' : 'Telegram 채팅';
}

function optionalText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}
