export function getClaudeRuntimeSourceBadge(details = {}) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const title = String(details.runtimeDetail || '').trim();
  if (details.runtimeSource === 'external') {
    return {
      label: '외부 Claude CLI',
      ok: false,
      title,
    };
  }
  if (details.runtimeSource === 'bundled') {
    return {
      label: '번들 Claude CLI',
      ok: true,
      title,
    };
  }
  return null;
}

export function getClaudeRuntimeSourceHintLines(details = {}) {
  const lines = [];
  const badge = getClaudeRuntimeSourceBadge(details);
  if (badge) {
    lines.push(`런타임: ${badge.label}`);
  }
  const runtimeDetail = String(details?.runtimeDetail || '').trim();
  if (runtimeDetail) {
    lines.push(`세부: ${runtimeDetail}`);
  }
  return lines;
}
