import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeVersion,
  updateChartYamlVersion,
  updatePackageJsonVersion,
  updatePackageLockVersion,
} from './release-utils.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export function syncReleaseVersion(rootDir, inputVersion) {
  const version = normalizeVersion(inputVersion);
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const chartYamlPath = path.join(rootDir, 'charts', 'hkclaw-lite', 'Chart.yaml');

  fs.writeFileSync(
    packageJsonPath,
    updatePackageJsonVersion(fs.readFileSync(packageJsonPath, 'utf8'), version),
  );
  fs.writeFileSync(
    packageLockPath,
    updatePackageLockVersion(fs.readFileSync(packageLockPath, 'utf8'), version),
  );
  fs.writeFileSync(
    chartYamlPath,
    updateChartYamlVersion(fs.readFileSync(chartYamlPath, 'utf8'), version),
  );

  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    throw new Error('Usage: node scripts/sync-release-version.mjs <version>');
  }
  const nextVersion = syncReleaseVersion(repoRoot, version);
  console.log(`Synchronized release metadata to ${nextVersion}.`);
}
