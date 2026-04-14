import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { toErrorMessage } from './utils.js';

const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'claude-worker.js');

export function createClaudeWorkerBridge({ cwd, env }) {
  const child = spawn(process.execPath, [workerPath], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  let closed = false;
  let nextRequestId = 1;
  const pending = new Map();
  const stderrChunks = [];

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error('Claude worker bridge closed.'));
    }
    pending.clear();
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };

  const finishPending = (error) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  }).on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      finishPending(new Error(`Invalid response from Claude worker: ${toErrorMessage(error)}`));
      return;
    }

    if (message.jsonrpc !== '2.0') {
      finishPending(new Error('Invalid Claude worker protocol version.'));
      return;
    }

    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) {
      return;
    }
    pending.delete(message.id);

    if (message.ok) {
      pendingRequest.resolve(message.result);
      return;
    }

    pendingRequest.reject(new Error(String(message.error || 'Claude worker request failed.')));
  });

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  child.stdin.on('error', (error) => {
    finishPending(error);
  });

  child.on('error', (error) => {
    finishPending(error);
  });

  child.on('exit', (code, signal) => {
    if (closed) {
      return;
    }
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const suffix = stderr ? `\n${stderr}` : '';
    finishPending(
      new Error(
        `Claude worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${suffix}`,
      ),
    );
  });

  return {
    async request(method, params = {}) {
      if (closed) {
        throw new Error('Claude worker bridge is closed.');
      }

      const id = nextRequestId;
      nextRequestId += 1;
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });

      child.stdin.write(`${payload}\n`, 'utf8');
      return result;
    },
    close,
  };
}
