export function getClaudeRuntimeSourceBadge(details = {}) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const title = String(details.runtimeDetail || '').trim();
  if (details.runtimeSource === 'external') {
    return {
      label: '외부 Claude CLI',
      ok: true,
      title,
    };
  }
  if (details.runtimeSource === 'system') {
    return {
      label: 'Claude CLI',
      ok: true,
      title,
    };
  }
  return null;
}

export function getClaudeRuntimeSourceHintLines(details = {}) {
  const lines = [];
  const badge = getClaudeRuntimeSourceBadge(details);
  const runtimeVersion = formatRuntimeVersion(details);
  if (badge) {
    lines.push(`런타임: ${[badge.label, runtimeVersion].filter(Boolean).join(' · ')}`);
  }
  if (details?.runtimeSource === 'external') {
    lines.push('HKCLAW_LITE_CLAUDE_CLI 가 가리키는 외부 Claude CLI 를 사용 중입니다.');
  } else if (details?.runtimeSource === 'system') {
    lines.push('PATH 의 claude CLI 를 사용 중입니다. `npm install -g @anthropic-ai/claude-agent-sdk` 으로 설치되어 있어야 합니다.');
  }
  const runtimeDetail = String(details?.runtimeDetail || '').trim();
  if (runtimeDetail) {
    lines.push(`경로: ${runtimeDetail}`);
  }
  return lines;
}

function formatRuntimeVersion(details = {}) {
  const packageName = String(details?.runtimePackageName || '').trim();
  const packageVersion = String(details?.runtimePackageVersion || '').trim();
  if (!packageName && !packageVersion) {
    return '';
  }
  return packageVersion ? `${packageName || 'CLI'} v${packageVersion}` : packageName;
}
