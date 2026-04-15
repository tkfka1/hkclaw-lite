import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.argv[2];
const agentName = process.argv[3] || null;

if (!projectRoot) {
  console.error('project root is required');
  process.exit(1);
}

const toolRoot = path.join(projectRoot, '.hkclaw-lite');
const statusPath = agentName
  ? path.join(toolRoot, 'discord-agent-statuses', `${agentName}.json`)
  : path.join(toolRoot, 'discord-status.json');

fs.mkdirSync(toolRoot, { recursive: true });

function writeStatus(overrides = {}) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(
    statusPath,
    JSON.stringify(
      {
        version: 1,
        projectRoot,
        agentName,
        pid: process.pid,
        running: overrides.running ?? true,
        desiredRunning: overrides.desiredRunning ?? true,
        startedAt:
          overrides.startedAt === undefined ? new Date().toISOString() : overrides.startedAt,
        stoppedAt: overrides.stoppedAt || null,
        heartbeatAt: new Date().toISOString(),
        envFilePath: null,
        lastError: overrides.lastError || null,
        agents: agentName
          ? {
              [agentName]: {
                agent: 'command',
                tokenConfigured: true,
                connected: true,
                tag: `${agentName}#0001`,
                userId: '1',
              },
            }
          : {},
      },
      null,
      2,
    ),
  );
}

writeStatus();

const heartbeat = setInterval(() => {
  writeStatus();
}, 1000);

const shutdown = () => {
  clearInterval(heartbeat);
  writeStatus({
    stoppedAt: new Date().toISOString(),
    startedAt: undefined,
    lastError: null,
    running: false,
    desiredRunning: true,
  });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
