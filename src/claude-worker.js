import readline from 'node:readline';

import { loadClaudeAgentSdk } from './runners.js';
import { toErrorMessage, trimTrailingWhitespace } from './utils.js';

let authQueryHandle = null;
let authCompletionPromise = null;

async function* createIdlePromptStream() {
  await new Promise(() => {});
}

async function closeAuthQueryHandle() {
  const activeHandle = authQueryHandle;
  authQueryHandle = null;
  authCompletionPromise = null;
  try {
    activeHandle?.close?.();
  } catch {
    // Ignore cleanup failures during worker shutdown.
  }
}

async function startAuth({ cwd, loginMode }) {
  await closeAuthQueryHandle();
  const sdk = await loadClaudeAgentSdk(process.env);
  const queryHandle = sdk.query({
    prompt: createIdlePromptStream(),
    options: {
      cwd,
      env: process.env,
    },
  });

  try {
    await queryHandle.initializationResult?.();
    const auth = await queryHandle.claudeAuthenticate(loginMode === 'claudeai');
    authQueryHandle = queryHandle;
    return {
      manualUrl: String(auth?.manualUrl || '').trim(),
      automaticUrl: String(auth?.automaticUrl || '').trim(),
    };
  } catch (error) {
    queryHandle.close?.();
    throw error;
  }
}

async function completeAuth({ authorizationCode, state }) {
  if (!authQueryHandle) {
    throw new Error('Claude worker auth session is not active.');
  }

  authCompletionPromise ||= authQueryHandle.claudeOAuthWaitForCompletion();
  await authQueryHandle.claudeOAuthCallback(authorizationCode, state);
  const completion = await authCompletionPromise;
  const account = await authQueryHandle.accountInfo().catch(() => completion?.account || {});
  await closeAuthQueryHandle();
  return {
    account,
  };
}

async function runTurn({ prompt, options }) {
  const sdk = await loadClaudeAgentSdk(process.env);
  const queryHandle = sdk.query({
    prompt,
    options,
  });
  let finalResult = '';

  try {
    for await (const message of queryHandle) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      if (message.type !== 'result') {
        continue;
      }
      if (message.subtype === 'success') {
        finalResult = String(message.result || '');
        continue;
      }

      const errors = Array.isArray(message.errors)
        ? message.errors.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      throw new Error(errors.join('\n') || 'claude execution failed.');
    }
  } finally {
    queryHandle.close?.();
  }

  return {
    text: trimTrailingWhitespace(finalResult).trim(),
  };
}

async function handleRequest(method, params) {
  switch (method) {
    case 'auth.start':
      return startAuth(params || {});
    case 'auth.complete':
      return completeAuth(params || {});
    case 'auth.close':
      await closeAuthQueryHandle();
      return { closed: true };
    case 'turn.run':
      return runTurn(params || {});
    default:
      throw new Error(`Unsupported Claude worker method "${method}".`);
  }
}

function writeResponse(message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    ...message,
  })}\n`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', async (line) => {
  const text = String(line || '').trim();
  if (!text) {
    return;
  }

  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    writeResponse({
      id: null,
      ok: false,
      error: `Invalid worker request: ${toErrorMessage(error)}`,
    });
    return;
  }

  if (request.jsonrpc !== '2.0') {
    writeResponse({
      id: request.id ?? null,
      ok: false,
      error: 'Invalid worker protocol version.',
    });
    return;
  }

  try {
    const result = await handleRequest(request.method, request.params || {});
    writeResponse({
      id: request.id,
      ok: true,
      result,
    });
  } catch (error) {
    writeResponse({
      id: request.id,
      ok: false,
      error: toErrorMessage(error),
    });
  }
});

input.on('close', async () => {
  await closeAuthQueryHandle();
});
