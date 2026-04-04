import fs from 'node:fs';

import { DEFAULT_HISTORY_WINDOW } from './constants.js';
import { resolveProjectPath } from './store.js';

export function buildPromptEnvelope({
  projectRoot,
  config,
  service,
  session,
  userPrompt,
}) {
  const sections = [];
  const systemPrompt = loadSystemPrompt(projectRoot, service);
  const historyWindow =
    service.historyWindow ?? config.defaults.historyWindow ?? DEFAULT_HISTORY_WINDOW;
  const recentMessages = session?.messages?.slice(-historyWindow * 2) ?? [];

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }

  sections.push(
    [
      'Runtime context:',
      `- service: ${service.name}`,
      `- agent: ${service.agent}`,
      `- workdir: ${resolveProjectPath(projectRoot, service.workdir)}`,
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

export function loadSystemPrompt(projectRoot, service) {
  const parts = [];
  if (typeof service.systemPrompt === 'string' && service.systemPrompt.trim()) {
    parts.push(service.systemPrompt.trim());
  }
  if (
    typeof service.systemPromptFile === 'string' &&
    service.systemPromptFile.trim()
  ) {
    const filePath = resolveProjectPath(projectRoot, service.systemPromptFile);
    parts.push(fs.readFileSync(filePath, 'utf8').trim());
  }
  return parts.filter(Boolean).join('\n\n');
}
