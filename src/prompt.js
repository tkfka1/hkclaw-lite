import fs from 'node:fs';
import path from 'node:path';

import { resolveProjectPath } from './store.js';

export function buildPromptEnvelope({
  projectRoot,
  agent,
  channel,
  workdirOverride,
  userPrompt,
}) {
  const sections = [];
  const systemPrompt = loadSystemPrompt(projectRoot, agent);
  const skills = loadSkillDocuments(projectRoot, agent);
  const contextFiles = loadContextDocuments(projectRoot, agent);

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }

  if (skills.length > 0) {
    sections.push(formatNamedDocuments('Installed skills:', skills));
  }

  if (contextFiles.length > 0) {
    sections.push(formatNamedDocuments('Baseline context:', contextFiles));
  }

  sections.push(
    [
      'Runtime context:',
      `- agent name: ${agent.name}`,
      `- agent type: ${agent.agent}`,
      resolveRuntimeWorkdir(projectRoot, agent, channel, workdirOverride),
      channel ? `- discord channel: ${channel.name}` : null,
      channel ? `- discord channel id: ${channel.discordChannelId}` : null,
      channel?.guildId ? `- discord guild id: ${channel.guildId}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  sections.push(`User request:\n${userPrompt.trim()}`);

  return sections.join('\n\n---\n\n');
}

function resolveRuntimeWorkdir(projectRoot, agent, channel, workdirOverride) {
  const workdir = workdirOverride || channel?.workdir || agent.workdir;
  if (!workdir) {
    return null;
  }
  return `- workdir: ${resolveProjectPath(projectRoot, workdir)}`;
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

function loadSkillDocuments(projectRoot, agent) {
  return (agent.skills ?? [])
    .map((entry) => {
      const resolved = resolveProjectPath(projectRoot, entry);
      const stat = fs.statSync(resolved);
      const filePath = stat.isDirectory() ? path.join(resolved, 'SKILL.md') : resolved;
      return {
        label: path.relative(projectRoot, filePath),
        content: fs.readFileSync(filePath, 'utf8').trim(),
      };
    })
    .filter((document) => document.content);
}

function loadContextDocuments(projectRoot, agent) {
  return (agent.contextFiles ?? [])
    .map((entry) => {
      const filePath = resolveProjectPath(projectRoot, entry);
      return {
        label: path.relative(projectRoot, filePath),
        content: fs.readFileSync(filePath, 'utf8').trim(),
      };
    })
    .filter((document) => document.content);
}

function formatNamedDocuments(title, documents) {
  return [
    title,
    ...documents.map(
      (document) => `Source: ${document.label}\n${document.content}`,
    ),
  ].join('\n\n');
}
