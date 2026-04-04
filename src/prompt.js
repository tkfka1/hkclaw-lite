import fs from 'node:fs';

import { DEFAULT_HISTORY_WINDOW } from './constants.js';
import { resolveProjectPath } from './store.js';

export function buildPromptEnvelope({
  projectRoot,
  config,
  agent,
  channel,
  session,
  userPrompt,
}) {
  const sections = [];
  const systemPrompt = loadSystemPrompt(projectRoot, agent);
  const historyWindow =
    agent.historyWindow ?? config.defaults.historyWindow ?? DEFAULT_HISTORY_WINDOW;
  const recentMessages = session?.messages?.slice(-historyWindow * 2) ?? [];

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }

  sections.push(
    [
      'Runtime context:',
      `- agent name: ${agent.name}`,
      `- agent type: ${agent.agent}`,
      `- workdir: ${resolveProjectPath(projectRoot, agent.workdir)}`,
      channel ? `- discord channel: ${channel.name}` : null,
      channel ? `- discord channel id: ${channel.discordChannelId}` : null,
      channel?.guildId ? `- discord guild id: ${channel.guildId}` : null,
      session ? `- session: ${session.id}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (recentMessages.length > 0) {
    sections.push(
      [
        'Conversation transcript:',
        ...recentMessages.flatMap((message) => [
          `${message.role.toUpperCase()} @ ${message.createdAt}`,
          message.content,
        ]),
        'Use the transcript as prior context. Reply to the latest user request.',
      ].join('\n\n'),
    );
  }

  sections.push(`User request:\n${userPrompt.trim()}`);

  return sections.join('\n\n---\n\n');
}

export function loadSystemPrompt(projectRoot, agent) {
  const parts = [];
  if (typeof agent.systemPrompt === 'string' && agent.systemPrompt.trim()) {
    parts.push(agent.systemPrompt.trim());
  }
  if (
    typeof agent.systemPromptFile === 'string' &&
    agent.systemPromptFile.trim()
  ) {
    const filePath = resolveProjectPath(projectRoot, agent.systemPromptFile);
    parts.push(fs.readFileSync(filePath, 'utf8').trim());
  }
  return parts.filter(Boolean).join('\n\n');
}
