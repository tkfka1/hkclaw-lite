export function getClaudeRuntimeSourceBadge(details = {}) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const title = String(details.runtimeDetail || '').trim();
  if (details.runtimeSource === 'external') {
    return {
      label: '로컬 Claude CLI',
      ok: true,
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
  const runtimeVersion = formatRuntimeVersion(details);
  if (badge) {
    lines.push(`런타임: ${[badge.label, runtimeVersion].filter(Boolean).join(' · ')}`);
  }
  if (details?.runtimeSource === 'external') {
    lines.push('로컬 터미널의 Claude 로그인 상태를 공유합니다. 웹에서는 상태 확인과 테스트만 실행합니다.');
  } else if (details?.runtimeSource === 'bundled') {
    lines.push('웹에서 브라우저 로그인을 시작하고, 완료 후 callback URL을 붙여넣습니다.');
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
