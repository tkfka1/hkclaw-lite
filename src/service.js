import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SERVICE_NAME = 'hkclaw-lite';
const UNIT_FILENAME = `${SERVICE_NAME}.service`;

export function getUnitPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'systemd', 'user', UNIT_FILENAME);
}

export function buildSystemdUnit({ binPath, projectRoot, host, port, envFile, homeDir, nodePath }) {
  const home = homeDir || os.homedir();
  const node = nodePath || process.execPath;
  const bundledClisBin = path.join(projectRoot, '.hkclaw-lite', 'bundled-clis', 'bin');
  const pathSegments = [
    path.dirname(node),
    path.dirname(binPath),
    bundledClisBin,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  const lines = [
    '[Unit]',
    `Description=${SERVICE_NAME} local admin`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=${node} ${binPath} admin --host ${host} --port ${port} --root ${projectRoot}`,
    'Restart=always',
    'RestartSec=5',
    `Environment=HOME=${home}`,
    `Environment=PATH=${pathSegments.join(':')}`,
  ];
  if (envFile) {
    lines.push(`EnvironmentFile=-${envFile}`);
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export function writeSystemdUnit(unitPath, content) {
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, content);
}

export function readBinPath() {
  return process.argv[1] ? path.resolve(process.argv[1]) : '';
}

function ensureLinux() {
  if (process.platform !== 'linux') {
    throw new Error(`${SERVICE_NAME} service supervision requires Linux with systemd.`);
  }
}

export function systemctl(args, { allowFailure = false, capture = false } = {}) {
  ensureLinux();
  const result = spawnSync('systemctl', ['--user', ...args], {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `systemctl --user ${args.join(' ')} failed with exit ${result.status}.`
        + (capture && result.stderr ? `\n${result.stderr.trim()}` : ''),
    );
  }
  return result;
}

export function journalctl(args) {
  ensureLinux();
  const result = spawnSync('journalctl', ['--user', '-u', SERVICE_NAME, ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

export function installSystemdUnit({ binPath, projectRoot, host, port }) {
  ensureLinux();
  const unitPath = getUnitPath();
  const envFile = path.join(projectRoot, '.hkclaw-lite', 'service.env');
  const content = buildSystemdUnit({
    binPath,
    projectRoot,
    host,
    port,
    envFile: fs.existsSync(envFile) ? envFile : null,
  });
  writeSystemdUnit(unitPath, content);
  systemctl(['daemon-reload']);
  return { unitPath, envFile: fs.existsSync(envFile) ? envFile : null };
}

export function uninstallSystemdUnit() {
  ensureLinux();
  systemctl(['disable', '--now', SERVICE_NAME], { allowFailure: true });
  const unitPath = getUnitPath();
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
  }
  systemctl(['daemon-reload'], { allowFailure: true });
}

export function startService() {
  ensureLinux();
  systemctl(['enable', '--now', SERVICE_NAME]);
}

export function stopService() {
  ensureLinux();
  systemctl(['stop', SERVICE_NAME]);
}

export function restartService() {
  ensureLinux();
  systemctl(['restart', SERVICE_NAME]);
}

export function serviceStatus() {
  ensureLinux();
  systemctl(['status', '--no-pager', SERVICE_NAME], { allowFailure: true });
}

export function serviceLogs({ follow = false, lines = 200 } = {}) {
  ensureLinux();
  const args = ['--no-pager', '-n', String(lines)];
  if (follow) {
    args.push('-f');
  }
  return journalctl(args);
}
