const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function normalizeVersion(input) {
  const raw = String(input || '').trim();
  const version = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Expected a semantic version like 1.2.3 or v1.2.3, received "${raw || '(empty)'}".`);
  }
  return version;
}

export function updatePackageJsonVersion(text, version) {
  const nextVersion = normalizeVersion(version);
  const payload = JSON.parse(text);
  payload.version = nextVersion;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function updatePackageLockVersion(text, version) {
  const nextVersion = normalizeVersion(version);
  const payload = JSON.parse(text);
  payload.version = nextVersion;
  if (payload.packages && payload.packages['']) {
    payload.packages[''].version = nextVersion;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function updateChartYamlVersion(text, version) {
  const nextVersion = normalizeVersion(version);
  let updated = text;

  const versionPattern = /^version:\s*.+$/mu;
  if (!versionPattern.test(updated)) {
    throw new Error('charts/hkclaw-lite/Chart.yaml is missing a version field.');
  }
  updated = updated.replace(versionPattern, `version: ${nextVersion}`);

  const appVersionPattern = /^appVersion:\s*.+$/mu;
  if (!appVersionPattern.test(updated)) {
    throw new Error('charts/hkclaw-lite/Chart.yaml is missing an appVersion field.');
  }
  updated = updated.replace(appVersionPattern, `appVersion: "${nextVersion}"`);

  return updated;
}

export function readReleaseManifestVersions({ packageJsonText, packageLockText, chartYamlText }) {
  const packageJson = JSON.parse(packageJsonText);
  const packageLock = JSON.parse(packageLockText);

  const chartVersionMatch = chartYamlText.match(/^version:\s*(.+)$/mu);
  const chartAppVersionMatch = chartYamlText.match(/^appVersion:\s*"?([^"\n]+)"?$/mu);
  if (!chartVersionMatch || !chartAppVersionMatch) {
    throw new Error('charts/hkclaw-lite/Chart.yaml must define both version and appVersion.');
  }

  return {
    packageVersion: normalizeVersion(packageJson.version),
    packageLockVersion: normalizeVersion(packageLock.version),
    packageLockRootVersion: normalizeVersion(packageLock.packages?.['']?.version || packageLock.version),
    chartVersion: normalizeVersion(chartVersionMatch[1].trim()),
    chartAppVersion: normalizeVersion(chartAppVersionMatch[1].trim()),
  };
}

export function assertVersionConsistency(versions, expectedVersion) {
  const targetVersion = normalizeVersion(expectedVersion);
  const mismatches = Object.entries(versions).filter(([, value]) => normalizeVersion(value) !== targetVersion);
  if (mismatches.length > 0) {
    const details = mismatches.map(([key, value]) => `${key}=${value}`).join(', ');
    throw new Error(`Release metadata is out of sync for ${targetVersion}: ${details}`);
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/u;

export function buildNpmTarballUrl(packageName, version) {
  const normalizedVersion = normalizeVersion(version);
  const encodedName = encodeURIComponent(packageName).replace(/^%40/u, '@');
  const tarballName = packageName.includes('/') ? packageName.split('/').pop() : packageName;
  return `https://registry.npmjs.org/${encodedName}/-/${tarballName}-${normalizedVersion}.tgz`;
}

export function renderHomebrewFormula({
  version,
  sha256,
  tarballUrl = buildNpmTarballUrl('hkclaw-lite', version),
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedSha256 = String(sha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(normalizedSha256)) {
    throw new Error('Homebrew formula sha256 must be a 64 character lowercase hex digest.');
  }
  const normalizedTarballUrl = String(tarballUrl || '').trim();
  if (!/^https:\/\//u.test(normalizedTarballUrl)) {
    throw new Error('Homebrew formula URL must be an https URL.');
  }

  return `class HkclawLite < Formula
  desc "Discord/Telegram/KakaoTalk AI agent runtime with a local web admin"
  homepage "https://github.com/tkfka1/hkclaw-lite"
  url "${normalizedTarballUrl}"
  sha256 "${normalizedSha256}"
  license "MIT"
  version "${normalizedVersion}"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def post_install
    (var/"hkclaw-lite").mkpath
    (var/"log").mkpath
  end

  service do
    run [opt_bin/"hkclaw-lite", "--root", var/"hkclaw-lite", "admin", "--host", "0.0.0.0", "--port", "5687"]
    working_dir var/"hkclaw-lite"
    keep_alive true
    log_path var/"log/hkclaw-lite.log"
    error_log_path var/"log/hkclaw-lite.err.log"
    environment_variables PATH: std_service_path_env
  end

  test do
    assert_match "hkclaw-lite", shell_output("#{bin}/hkclaw-lite --help")
  end
end
`;
}
