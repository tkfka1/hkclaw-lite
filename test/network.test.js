import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs/promises';

import {
  PREFERRED_DNS_RESULT_ORDER,
  preferIpv4Dns,
} from '../src/network.js';

test('runtime prefers IPv4 DNS for external messaging APIs', () => {
  assert.equal(preferIpv4Dns(), true);
  assert.equal(dns.getDefaultResultOrder(), PREFERRED_DNS_RESULT_ORDER);
});

test('cli installs DNS preference before command handlers load', async () => {
  const cliSource = await fs.readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.equal(cliSource.startsWith("import './network.js';\n"), true);
});
