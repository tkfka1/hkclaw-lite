import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertVersionConsistency,
  buildNpmTarballUrl,
  normalizeVersion,
  readReleaseManifestVersions,
  renderHomebrewFormula,
  updateChartYamlVersion,
  updatePackageJsonVersion,
  updatePackageLockVersion,
} from '../scripts/release-utils.mjs';

test('normalizeVersion accepts semver and strips the v tag prefix', () => {
  assert.equal(normalizeVersion('1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.throws(() => normalizeVersion('release-1.2.3'), /Expected a semantic version/u);
});

test('release metadata helpers keep package, lockfile, and chart versions aligned', () => {
  const packageJson = updatePackageJsonVersion(
    JSON.stringify({ name: 'hkclaw-lite', version: '1.0.1' }),
    '1.4.0',
  );
  const packageLock = updatePackageLockVersion(
    JSON.stringify({
      name: 'hkclaw-lite',
      version: '1.0.1',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'hkclaw-lite',
          version: '1.0.1',
        },
      },
    }),
    'v1.4.0',
  );
  const chartYaml = updateChartYamlVersion(
    [
      'apiVersion: v2',
      'name: hkclaw-lite',
      'version: 1.0.0',
      'appVersion: "1.0.0"',
      '',
    ].join('\n'),
    '1.4.0',
  );

  const versions = readReleaseManifestVersions({
    packageJsonText: packageJson,
    packageLockText: packageLock,
    chartYamlText: chartYaml,
  });

  assert.deepEqual(versions, {
    packageVersion: '1.4.0',
    packageLockVersion: '1.4.0',
    packageLockRootVersion: '1.4.0',
    chartVersion: '1.4.0',
    chartAppVersion: '1.4.0',
  });
  assert.doesNotThrow(() => assertVersionConsistency(versions, 'v1.4.0'));
});

test('assertVersionConsistency reports the mismatched release metadata field', () => {
  assert.throws(
    () =>
      assertVersionConsistency(
        {
          packageVersion: '1.4.0',
          packageLockVersion: '1.4.0',
          packageLockRootVersion: '1.4.0',
          chartVersion: '1.3.9',
          chartAppVersion: '1.4.0',
        },
        '1.4.0',
      ),
    /chartVersion=1.3.9/u,
  );
});

test('homebrew formula renderer targets the npm release tarball', () => {
  const sha256 = 'a'.repeat(64);
  assert.equal(
    buildNpmTarballUrl('hkclaw-lite', 'v1.4.0'),
    'https://registry.npmjs.org/hkclaw-lite/-/hkclaw-lite-1.4.0.tgz',
  );

  const formula = renderHomebrewFormula({ version: 'v1.4.0', sha256 });
  assert.match(formula, /class HkclawLite < Formula/u);
  assert.match(formula, /url "https:\/\/registry\.npmjs\.org\/hkclaw-lite\/-\/hkclaw-lite-1\.4\.0\.tgz"/u);
  assert.match(formula, /sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/u);
  assert.match(formula, /depends_on "node"/u);
  assert.match(formula, /system "npm", "install", \*std_npm_args/u);
  assert.match(formula, /bin\.install_symlink libexec\.glob\("bin\/\*"\)/u);
});
