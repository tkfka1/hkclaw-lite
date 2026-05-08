export const TOOL_DIRNAME = '.hkclaw-lite';
export const CONFIG_FILENAME = 'config.json';
export const CURRENT_CONFIG_VERSION = 3;
export const DEFAULT_ADMIN_PORT = 5687;
export const DEFAULT_DASHBOARD_REFRESH_MS = 5000;
export const DEFAULT_CHANNEL_WORKSPACE = '~';
export const DEFAULT_CODEX_SANDBOX = 'workspace-write';
export const DEFAULT_CLAUDE_PERMISSION_MODE = 'bypassPermissions';
export const DEFAULT_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
export const SUPPORTED_AGENTS = [
  'codex',
  'claude-code',
  'gemini-cli',
  'local-llm',
  'command',
];
export const AGENT_TYPE_CHOICES = [
  {
    value: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI based coding agent',
  },
  {
    value: 'claude-code',
    label: 'Claude Code CLI',
    description: 'Anthropic Claude Code CLI based coding agent',
  },
  {
    value: 'gemini-cli',
    label: 'Gemini CLI',
    description: 'Google Gemini CLI based agent',
  },
  {
    value: 'local-llm',
    label: 'Local LLM',
    description: 'OpenAI-compatible local model endpoint',
  },
  {
    value: 'command',
    label: 'Custom Command',
    description: 'Any local command that reads stdin and writes stdout',
  },
];
export const CHANNEL_MODE_CHOICES = [
  {
    value: 'single',
    label: 'Single',
    description: 'One owner agent handles the channel',
  },
  {
    value: 'tribunal',
    label: 'Tribunal',
    description: 'Owner, reviewer, and arbiter collaborate on each turn',
  },
];
export const MESSAGING_PLATFORM_CHOICES = [
  {
    value: 'discord',
    label: 'Discord',
    description: 'Use a Discord bot token and Discord channel ID',
  },
  {
    value: 'telegram',
    label: 'Telegram',
    description: 'Use a Telegram bot token and Telegram chat ID',
  },
  {
    value: 'kakao',
    label: 'KakaoTalk',
    description: 'Use a Kakao TalkChannel relay session or token',
  },
];
export const CONNECTOR_PLATFORM_CHOICES = [
  {
    value: 'kakao',
    label: 'KakaoTalk',
    description: 'Reusable connectors are reserved for Kakao TalkChannel relay sessions',
  },
];
export const CHANNEL_TARGET_TYPE_CHOICES = [
  {
    value: 'channel',
    label: '서버/그룹 채널',
    description: 'Use a Discord server channel or Telegram group/channel chat',
  },
  {
    value: 'direct',
    label: '개인 대화/DM',
    description: 'Use a Discord DM or Telegram one-on-one bot chat',
  },
];
export const CODEX_SANDBOX_CHOICES = [
  {
    value: 'workspace-write',
    label: 'Workspace Write',
    description: 'Allow edits inside the workspace',
  },
  {
    value: 'read-only',
    label: 'Read Only',
    description: 'Do not allow model-generated writes',
  },
  {
    value: 'danger-full-access',
    label: 'Danger Full Access',
    description: 'No sandboxing',
  },
];
export const AGENT_ACCESS_MODE_CHOICES = CODEX_SANDBOX_CHOICES;
export const AGENT_ACCESS_MODE_AGENT_TYPES = [
  'codex',
  'gemini-cli',
  'local-llm',
  'command',
];
export const CLAUDE_PERMISSION_MODE_CHOICES = [
  {
    value: 'default',
    label: 'Default',
    description: 'Use Claude Code CLI default permission behavior',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Allow edits but keep other checks',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    description: 'Run without permission prompts',
  },
];
export const DASHBOARD_ALL_AGENTS = '*';
