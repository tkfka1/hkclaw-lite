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

let running = false;
setTimeout(() => {
  running = true;
}, 1500);

function writeStatus() {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(
    statusPath,
    JSON.stringify(
      {
        version: 1,
        projectRoot,
        agentName,
        pid: process.pid,
        running,
        desiredRunning: true,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        heartbeatAt: new Date().toISOString(),
        envFilePath: null,
        lastError: null,
        agents: agentName
          ? {
              [agentName]: {
                agent: 'command',
                tokenConfigured: true,
                connected: running,
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
}, 500);

const shutdown = () => {
  clearInterval(heartbeat);
  running = false;
  writeStatus();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
