import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSystemdUnit,
  getUnitPath,
  SERVICE_NAME,
  writeSystemdUnit,
} from '../src/service.js';

test('buildSystemdUnit emits a complete user unit invoking node explicitly', () => {
  const unit = buildSystemdUnit({
    binPath: '/opt/bin/hkclaw-lite',
    projectRoot: '/home/test/hkclaw-lite',
    host: '0.0.0.0',
    port: '5687',
    homeDir: '/home/test',
    nodePath: '/usr/local/bin/node',
  });

  assert.match(unit, /^\[Unit\]/u);
  assert.match(unit, new RegExp(`Description=${SERVICE_NAME} local admin`, 'u'));
  assert.match(unit, /After=network-online\.target/u);
  assert.match(unit, /Wants=network-online\.target/u);
  assert.match(unit, /^\[Service\]/mu);
  assert.match(unit, /^Type=simple$/mu);
  assert.match(unit, /^WorkingDirectory=\/home\/test\/hkclaw-lite$/mu);
  assert.match(
    unit,
    /^ExecStart=\/usr\/local\/bin\/node \/opt\/bin\/hkclaw-lite admin --host 0\.0\.0\.0 --port 5687 --root \/home\/test\/hkclaw-lite$/mu,
  );
  assert.match(unit, /^Restart=always$/mu);
  assert.match(unit, /^RestartSec=5$/mu);
  assert.match(unit, /^Environment=HOME=\/home\/test$/mu);
  assert.match(
    unit,
    /^Environment=PATH=\/usr\/local\/bin:\/opt\/bin:\/home\/test\/hkclaw-lite\/\.hkclaw-lite\/bundled-clis\/bin:\/usr\/local\/sbin/mu,
  );
  assert.match(unit, /^\[Install\]$/mu);
  assert.match(unit, /^WantedBy=default\.target$/mu);
});

test('buildSystemdUnit includes EnvironmentFile only when an env file is provided', () => {
  const without = buildSystemdUnit({
    binPath: '/usr/bin/hkclaw-lite',
    projectRoot: '/srv/hkclaw',
    host: '127.0.0.1',
    port: '5687',
    homeDir: '/home/srv',
  });
  assert.equal(/EnvironmentFile=/u.test(without), false);

  const withEnv = buildSystemdUnit({
    binPath: '/usr/bin/hkclaw-lite',
    projectRoot: '/srv/hkclaw',
    host: '127.0.0.1',
    port: '5687',
    envFile: '/srv/hkclaw/.hkclaw-lite/service.env',
    homeDir: '/home/srv',
  });
  assert.match(
    withEnv,
    /^EnvironmentFile=-\/srv\/hkclaw\/\.hkclaw-lite\/service\.env$/mu,
  );
});

test('writeSystemdUnit creates parent directories and writes the unit content', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hkclaw-service-'));
  const unitPath = path.join(tmpHome, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  writeSystemdUnit(unitPath, '[Unit]\nDescription=test\n');
  assert.equal(fs.existsSync(unitPath), true);
  assert.equal(fs.readFileSync(unitPath, 'utf8'), '[Unit]\nDescription=test\n');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('getUnitPath defaults under ~/.config/systemd/user', () => {
  const unitPath = getUnitPath('/tmp/fake-home');
  assert.equal(unitPath, `/tmp/fake-home/.config/systemd/user/${SERVICE_NAME}.service`);
});
