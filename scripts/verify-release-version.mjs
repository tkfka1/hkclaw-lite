import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVersionConsistency,
  normalizeVersion,
  readReleaseManifestVersions,
} from './release-utils.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export function verifyReleaseVersion(rootDir, inputTagOrVersion) {
  const expectedVersion = normalizeVersion(inputTagOrVersion);
  const versions = readReleaseManifestVersions({
    packageJsonText: fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    packageLockText: fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
    chartYamlText: fs.readFileSync(path.join(rootDir, 'charts', 'hkclaw-lite', 'Chart.yaml'), 'utf8'),
  });

  assertVersionConsistency(versions, expectedVersion);
  return versions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tagOrVersion = process.argv[2] || process.env.GITHUB_REF_NAME;
  if (!tagOrVersion) {
    throw new Error('Usage: node scripts/verify-release-version.mjs <version-or-tag>');
  }
  const expectedVersion = normalizeVersion(tagOrVersion);
  const versions = verifyReleaseVersion(repoRoot, expectedVersion);
  console.log(`Release metadata verified for ${expectedVersion}: ${JSON.stringify(versions)}`);
}
