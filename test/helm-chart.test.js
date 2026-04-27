import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Helm chart defaults to single-Pod Recreate rollouts for RWO state PVCs', () => {
  const values = readRepoFile('charts/hkclaw-lite/values.yaml');
  const deploymentTemplate = readRepoFile('charts/hkclaw-lite/templates/deployment.yaml');
  const readme = readRepoFile('README.md');

  assert.match(values, /deploymentStrategy:\n(?:  # .+\n)+  type: Recreate\n  rollingUpdate: \{\}/u);
  assert.match(deploymentTemplate, /type: \{\{ \.Values\.deploymentStrategy\.type \}\}/u);
  assert.match(
    deploymentTemplate,
    /\{\{- if and \(eq \.Values\.deploymentStrategy\.type "RollingUpdate"\) \.Values\.deploymentStrategy\.rollingUpdate \}\}/u,
  );
  assert.match(readme, /기본 Deployment 전략은 `Recreate`/u);
  assert.match(readme, /READY 2\/2.+한 Pod 안의 웹 어드민 컨테이너와 Kakao sidecar 두 컨테이너/us);
  assert.match(readme, /RollingUpdate의 `maxSurge=1`.+기본 운영 형태와 맞지 않는다/us);
});
