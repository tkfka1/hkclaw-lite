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

test('Helm chart does not require an initial admin password secret to start', () => {
  const values = readRepoFile('charts/hkclaw-lite/values.yaml');
  const deploymentTemplate = readRepoFile('charts/hkclaw-lite/templates/deployment.yaml');
  const adminSecretTemplate = readRepoFile('charts/hkclaw-lite/templates/admin-secret.yaml');

  assert.match(values, /Admin auth is optional/u);
  assert.match(values, /login stays disabled/u);
  assert.match(deploymentTemplate, /secretRef:\n\s+name: \{\{ include "hkclaw-lite\.adminSecretName" \. \}\}\n\s+optional: true/u);
  assert.doesNotMatch(adminSecretTemplate, /adminSecret\.stringData must contain/u);
  assert.match(adminSecretTemplate, /\{\{- with \.Values\.adminSecret\.stringData \}\}/u);
});

test('Helm chart keeps managed storage at or above 25Gi by default', () => {
  const values = readRepoFile('charts/hkclaw-lite/values.yaml');
  const helpers = readRepoFile('charts/hkclaw-lite/templates/_helpers.tpl');
  const deploymentTemplate = readRepoFile('charts/hkclaw-lite/templates/deployment.yaml');
  const serviceAccountTemplate = readRepoFile('charts/hkclaw-lite/templates/serviceaccount.yaml');
  const statePvcTemplate = readRepoFile('charts/hkclaw-lite/templates/state-pvc.yaml');
  const storageRbacTemplate = readRepoFile('charts/hkclaw-lite/templates/storage-rbac.yaml');
  const workspacePvcTemplate = readRepoFile('charts/hkclaw-lite/templates/workspace-pvc.yaml');

  assert.match(values, /state:\n[\s\S]*?persistence:\n[\s\S]*?size: 25Gi/u);
  assert.match(values, /workspace:\n[\s\S]*?persistence:\n[\s\S]*?size: 25Gi/u);
  assert.match(values, /storageResize:\n[\s\S]*?enabled: false/u);
  assert.match(helpers, /define "hkclaw-lite\.requireStorageAtLeast25Gi"/u);
  assert.match(helpers, /must be at least 25Gi/u);
  assert.match(statePvcTemplate, /requireStorageAtLeast25Gi" \(list "state\.persistence\.size"/u);
  assert.match(workspacePvcTemplate, /requireStorageAtLeast25Gi" \(list "workspace\.persistence\.size"/u);
  assert.match(deploymentTemplate, /HKCLAW_LITE_STORAGE_STATE_PVC/u);
  assert.match(deploymentTemplate, /HKCLAW_LITE_STORAGE_WORKSPACE_PVC/u);
  assert.match(deploymentTemplate, /or \.Values\.serviceAccount\.automountServiceAccountToken \.Values\.storageResize\.rbac\.enabled/u);
  assert.match(serviceAccountTemplate, /or \.Values\.serviceAccount\.automountServiceAccountToken \.Values\.storageResize\.rbac\.enabled/u);
  assert.match(storageRbacTemplate, /persistentvolumeclaims/u);
  assert.match(storageRbacTemplate, /verbs:\n\s+- get\n\s+- patch/u);
});
