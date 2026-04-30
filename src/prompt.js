import fs from 'node:fs';
import path from 'node:path';

import { resolveProjectPath } from './store.js';

export function buildPromptEnvelope({
  projectRoot,
  agent,
  channel,
  workdirOverride,
  userPrompt,
  sessionHistory = [],
}) {
  const sections = [];
  const systemPrompt = loadSystemPrompt(projectRoot, agent);
  const skills = loadSkillDocuments(projectRoot, agent);
  const contextFiles = loadContextDocuments(projectRoot, agent);
  const topologyGuidance = buildTopologyGuidance(agent);

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }

  if (skills.length > 0) {
    sections.push(formatNamedDocuments('Installed skills:', skills));
  }

  if (contextFiles.length > 0) {
    sections.push(formatNamedDocuments('Baseline context:', contextFiles));
  }

  if (topologyGuidance) {
    sections.push(topologyGuidance);
  }

  sections.push(
    [
      'Runtime context:',
      `- agent name: ${agent.name}`,
      `- agent type: ${agent.agent}`,
      resolveRuntimeAccessMode(agent),
      resolveRuntimeWorkdir(projectRoot, agent, channel, workdirOverride),
      channel ? `- channel: ${channel.name}` : null,
      channel?.platform === 'telegram'
        ? `- telegram channel: ${channel.name}`
        : channel
          ? `- discord channel: ${channel.name}`
          : null,
      channel?.platform ? `- channel platform: ${channel.platform}` : null,
      channel?.targetType ? `- message target: ${channel.targetType}` : null,
      channel?.discordChannelId ? `- discord channel id: ${channel.discordChannelId}` : null,
      channel?.discordUserId ? `- discord user id: ${channel.discordUserId}` : null,
      channel?.guildId ? `- discord guild id: ${channel.guildId}` : null,
      channel?.telegramChatId ? `- telegram chat id: ${channel.telegramChatId}` : null,
      channel?.telegramThreadId ? `- telegram thread id: ${channel.telegramThreadId}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (sessionHistory.length > 0) {
    sections.push(formatSessionHistory(sessionHistory));
  }

  sections.push(`User request:\n${userPrompt.trim()}`);

  return sections.join('\n\n---\n\n');
}

function resolveRuntimeAccessMode(agent) {
  const accessMode = agent?.sandbox || (agent?.dangerous ? 'danger-full-access' : '');
  if (accessMode) {
    return `- access mode: ${accessMode}`;
  }
  if (agent?.permissionMode) {
    return `- permission mode: ${agent.permissionMode}`;
  }
  return null;
}

function resolveRuntimeWorkdir(projectRoot, agent, channel, workdirOverride) {
  const workdir = workdirOverride || channel?.workspace || channel?.workdir || agent.workdir;
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

function buildTopologyGuidance(agent) {
  const policy = agent?.managementPolicy;
  if (!policy?.canPlan && !policy?.canApply) {
    return '';
  }
  return [
    'Topology management:',
    '- You may propose hkclaw-lite topology changes by writing a JSON spec to a file.',
    '- Dry-run first with: hkclaw-lite topology plan --file <file>.',
    policy.canApply
      ? '- Apply only when explicitly requested and allowed by your management policy: hkclaw-lite topology apply --file <file> --yes.'
      : '- You are not allowed to apply topology changes; ask an operator to run apply.',
    '- Never write raw tokens into topology files; use secretRefs.*Env fields.',
  ].join('\n');
}

function formatSessionHistory(entries) {
  return [
    'Recent role session history:',
    ...entries.map((entry, index) => {
      const lines = [
        `Session ${index + 1}:`,
        `- prior user request: ${truncateInline(entry.prompt, 220)}`,
        `- prior role output: ${truncateInline(entry.content, 320)}`,
      ];
      if (entry.reviewerVerdict) {
        lines.push(`- prior reviewer verdict: ${entry.reviewerVerdict}`);
      }
      if (entry.agentName) {
        lines.push(`- prior agent: ${entry.agentName}`);
      }
      return lines.join('\n');
    }),
  ].join('\n\n');
}

function truncateInline(value, maxLength) {
  const normalized = String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
