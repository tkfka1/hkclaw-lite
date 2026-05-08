import { buildPromptEnvelope } from './prompt.js';
import { runAgentTurn } from './runners.js';
import {
  completeRuntimeRun,
  enqueueRuntimeOutboxEvent,
  failRuntimeRun,
  getRuntimeRoleSession,
  listRecentRoleSessionContext,
  recordRuntimeRoleMessage,
  recordRuntimeRoleSession,
  recordRuntimeUsageEvent,
  startRuntimeRun,
  transitionRuntimeRun,
} from './runtime-db.js';
import { getAgent, resolveProjectPath } from './store.js';
import { assert, toErrorMessage } from './utils.js';

export async function executeChannelTurn({
  projectRoot,
  config,
  channel,
  prompt,
  workdir,
  onRoleMessage = null,
  onTransition = null,
  onStreamEvent = null,
}) {
  const recorder = await createRuntimeRecorder(projectRoot, {
    channel,
    prompt,
    workdir,
    onTransition,
  });
  const emitPersistedRoleMessage = async (entry) => {
    await recorder.record(entry);
    await emitRoleMessage(onRoleMessage, entry);
  };

  try {
    let result;

    if (isTribunalChannel(channel)) {
      result = await executeTribunalTurn({
        projectRoot,
        config,
        channel,
        prompt,
        workdir,
        recorder,
        onRoleMessage: emitPersistedRoleMessage,
        onStreamEvent,
      });
    } else {
      const agent = getAgent(config, channel.agent);
      await recorder.transition({
        status: 'owner_running',
        activeRole: 'owner',
        currentRound: 1,
        maxRounds: 1,
        note: 'Owner is processing the request.',
      });
      const ownerTurn = await executeAgentTurnWithFallback({
        projectRoot,
        config,
        agent,
        channel,
        role: 'owner',
        userPrompt: prompt,
        workdir: resolveRoleWorkdir(projectRoot, channel, 'owner', workdir),
        sessionHistory: await loadRoleSessionHistory(projectRoot, {
          channel,
          role: 'owner',
          runId: recorder.runId,
        }),
        onStreamEvent,
      });
      const content = ownerTurn.content;

      await emitPersistedRoleMessage({
        role: 'owner',
        agent,
        content,
        runtimeBackend: ownerTurn.runtimeMeta?.runtimeBackend || null,
        runtimeSessionId: ownerTurn.runtimeMeta?.runtimeSessionId || null,
        final: true,
        round: 1,
        maxRounds: 1,
        mode: 'single',
      });

      result = {
        role: 'owner',
        agent,
        content,
        reviewerVerdict: null,
        runtimeFinalDisposition: 'owner_response_sent',
      };
    }

    await recorder.complete(result);
    return {
      ...result,
      runId: recorder.runId,
    };
  } catch (error) {
    await recorder.fail(error);
    if (error && typeof error === 'object') {
      error.runtimeRunId = recorder.runId;
    }
    throw error;
  }
}

export function isTribunalChannel(channel) {
  if (!channel) {
    return false;
  }
  return channel.mode === 'tribunal' || Boolean(channel.reviewer && channel.arbiter);
}

async function executeTribunalTurn({
  projectRoot,
  config,
  channel,
  prompt,
  workdir,
  recorder,
  onRoleMessage,
  onStreamEvent = null,
}) {
  const owner = getAgent(config, channel.agent);
  const reviewer = getAgent(config, channel.reviewer);
  const arbiter = getAgent(config, channel.arbiter);
  const maxRounds = channel.reviewRounds || 2;

  let ownerPrompt = prompt;
  let ownerResponse = '';
  let reviewerResponse = '';
  let lastReviewerVerdict = 'blocked';

  for (let round = 1; round <= maxRounds; round += 1) {
    await recorder.transition({
      status: 'owner_running',
      activeRole: 'owner',
      currentRound: round,
      maxRounds,
      note: `Owner round ${round} started.`,
    });
    const ownerTurn = await executeAgentTurnWithFallback({
      projectRoot,
      config,
      agent: owner,
      channel,
      role: 'owner',
      userPrompt: ownerPrompt,
      workdir: resolveRoleWorkdir(projectRoot, channel, 'owner', workdir),
      sessionHistory: await loadRoleSessionHistory(projectRoot, {
        channel,
        role: 'owner',
        runId: recorder.runId,
      }),
      onStreamEvent,
    });
    ownerResponse = ownerTurn.content;
    await emitRoleMessage(onRoleMessage, {
      role: 'owner',
      agent: owner,
      content: ownerResponse,
      runtimeBackend: ownerTurn.runtimeMeta?.runtimeBackend || null,
      runtimeSessionId: ownerTurn.runtimeMeta?.runtimeSessionId || null,
      final: false,
      round,
      maxRounds,
      mode: 'tribunal',
    });

    await recorder.transition({
      status: 'reviewer_running',
      activeRole: 'reviewer',
      currentRound: round,
      maxRounds,
      note: `Reviewer round ${round} started.`,
    });
    const reviewerTurn = await executeAgentTurnWithFallback({
      projectRoot,
      config,
      agent: reviewer,
      channel,
      role: 'reviewer',
      userPrompt: buildReviewerPrompt({
        prompt,
        ownerResponse,
        round,
        maxRounds,
      }),
      workdir: resolveRoleWorkdir(projectRoot, channel, 'reviewer', workdir),
      sessionHistory: await loadRoleSessionHistory(projectRoot, {
        channel,
        role: 'reviewer',
        runId: recorder.runId,
      }),
      onStreamEvent,
    });
    reviewerResponse = reviewerTurn.content;
    const reviewerVerdict = parseReviewerVerdict(reviewerResponse);
    lastReviewerVerdict = reviewerVerdict;
    await emitRoleMessage(onRoleMessage, {
      role: 'reviewer',
      agent: reviewer,
      content: reviewerResponse,
      runtimeBackend: reviewerTurn.runtimeMeta?.runtimeBackend || null,
      runtimeSessionId: reviewerTurn.runtimeMeta?.runtimeSessionId || null,
      final: reviewerVerdict === 'approved',
      round,
      maxRounds,
      mode: 'tribunal',
      verdict: reviewerVerdict,
    });

    if (reviewerVerdict === 'approved') {
      return {
        role: 'owner',
        agent: owner,
        content: ownerResponse,
        reviewerVerdict,
        runtimeFinalDisposition: 'reviewer_approved',
      };
    }

    if (reviewerVerdict === 'invalid') {
      await recorder.transition({
        status: 'arbiter_running',
        activeRole: 'arbiter',
        currentRound: round,
        maxRounds,
        reviewerVerdict,
        note: `Arbiter invoked after invalid reviewer verdict in round ${round}.`,
      });
      const arbiterTurn = await executeAgentTurnWithFallback({
        projectRoot,
        config,
        agent: arbiter,
        channel,
        role: 'arbiter',
        userPrompt: buildArbiterPrompt({
          prompt,
          ownerResponse,
          reviewerResponse,
          maxRounds,
          reviewerVerdict,
        }),
        workdir: resolveRoleWorkdir(projectRoot, channel, 'arbiter', workdir),
        onStreamEvent,
      });
      const arbiterResponse = arbiterTurn.content;
      await emitRoleMessage(onRoleMessage, {
        role: 'arbiter',
        agent: arbiter,
        content: arbiterResponse,
        runtimeBackend: arbiterTurn.runtimeMeta?.runtimeBackend || null,
        runtimeSessionId: arbiterTurn.runtimeMeta?.runtimeSessionId || null,
        final: true,
        round,
        maxRounds,
        mode: 'tribunal',
        verdict: reviewerVerdict,
      });
      return {
        role: 'arbiter',
        agent: arbiter,
        content: arbiterResponse,
        reviewerVerdict,
        runtimeFinalDisposition: 'arbiter_after_invalid_review',
      };
    }

    if (round < maxRounds) {
      await recorder.transition({
        status: 'awaiting_revision',
        activeRole: 'owner',
        currentRound: round + 1,
        maxRounds,
        reviewerVerdict,
        note: `Owner revision requested after reviewer blocked round ${round}.`,
      });
      ownerPrompt = buildOwnerRevisionPrompt({
        prompt,
        ownerResponse,
        reviewerResponse,
        round,
        maxRounds,
      });
    }
  }

  await recorder.transition({
    status: 'arbiter_running',
    activeRole: 'arbiter',
    currentRound: maxRounds,
    maxRounds,
    reviewerVerdict: lastReviewerVerdict,
    note: 'Arbiter invoked after review rounds were exhausted.',
  });
  const arbiterTurn = await executeAgentTurnWithFallback({
    projectRoot,
    config,
    agent: arbiter,
    channel,
    role: 'arbiter',
    userPrompt: buildArbiterPrompt({
      prompt,
      ownerResponse,
      reviewerResponse,
      maxRounds,
      reviewerVerdict: lastReviewerVerdict,
    }),
    workdir: resolveRoleWorkdir(projectRoot, channel, 'arbiter', workdir),
    onStreamEvent,
  });
  const arbiterResponse = arbiterTurn.content;
  await emitRoleMessage(onRoleMessage, {
    role: 'arbiter',
    agent: arbiter,
    content: arbiterResponse,
    runtimeBackend: arbiterTurn.runtimeMeta?.runtimeBackend || null,
    runtimeSessionId: arbiterTurn.runtimeMeta?.runtimeSessionId || null,
    final: true,
    round: maxRounds,
    maxRounds,
    mode: 'tribunal',
    verdict: lastReviewerVerdict,
  });
  return {
    role: 'arbiter',
    agent: arbiter,
    content: arbiterResponse,
    reviewerVerdict: lastReviewerVerdict,
    runtimeFinalDisposition: 'arbiter_after_blocked_review',
  };
}

function resolveRoleWorkdir(projectRoot, channel, role, defaultWorkdir) {
  const override =
    role === 'owner'
      ? channel?.ownerWorkspace
      : role === 'reviewer'
        ? channel?.reviewerWorkspace
        : role === 'arbiter'
          ? channel?.arbiterWorkspace
          : null;
  if (!override) {
    return defaultWorkdir;
  }
  return resolveProjectPath(projectRoot, override);
}

async function executeAgentTurnWithFallback({
  projectRoot,
  config,
  agent,
  channel,
  role,
  userPrompt,
  workdir,
  sessionHistory = [],
  visitedAgents = [],
  onStreamEvent = null,
}) {
  assert(
    !visitedAgents.includes(agent.name),
    `Fallback loop detected: ${[...visitedAgents, agent.name].join(' -> ')}`,
  );

  const runtimeSession = await loadRoleRuntimeSession(projectRoot, {
    channel,
    role,
  });
  const effectiveSessionHistory =
    agent.agent === 'claude-code' &&
    runtimeSession?.runtimeBackend === 'claude-cli' &&
    runtimeSession?.runtimeSessionId
      ? []
      : sessionHistory;
  const fullPrompt =
    agent.agent === 'claude-code' &&
    runtimeSession?.runtimeBackend === 'claude-cli' &&
    runtimeSession?.runtimeSessionId
      ? String(userPrompt || '').trim()
      : buildPromptEnvelope({
          projectRoot,
          agent,
          channel,
          workdirOverride: workdir,
          userPrompt,
          sessionHistory: effectiveSessionHistory,
        });

  try {
    const result = await runAgentTurn({
      projectRoot,
      agent,
      prompt: fullPrompt,
      rawPrompt: userPrompt,
      workdir,
      channel,
      role,
      runtimeSession,
      captureRuntimeMetadata: true,
      onStreamEvent:
        typeof onStreamEvent === 'function'
          ? async (event) => {
              await onStreamEvent({
                ...event,
                role,
                agentName: agent.name,
                agentType: agent.agent,
                channelName: channel?.name || null,
              });
            }
          : null,
    });
    const normalized = normalizeTurnResult(result);
    await recordRuntimeUsageEvent(projectRoot, {
      agentType: agent.agent,
      agentName: agent.name,
      channelName: channel?.name || null,
      role,
      source: 'channel-turn',
      model: agent.model || null,
      runtimeBackend: normalized.runtimeMeta?.runtimeBackend || null,
      usage: normalized.usage,
    });
    return normalized;
  } catch (error) {
    if (!agent.fallbackAgent) {
      throw error;
    }

    const fallbackAgent = getAgent(config, agent.fallbackAgent);

    try {
      return await executeAgentTurnWithFallback({
        projectRoot,
        config,
        agent: fallbackAgent,
        channel,
        role,
        userPrompt,
        workdir,
        sessionHistory,
        visitedAgents: [...visitedAgents, agent.name],
        onStreamEvent,
      });
    } catch (fallbackError) {
      throw new Error(
        [
          `${agent.name} failed: ${toErrorMessage(error)}`,
          `${fallbackAgent.name} failed: ${toErrorMessage(fallbackError)}`,
        ].join('\n'),
      );
    }
  }
}

function parseReviewerVerdict(reviewText) {
  const normalized = String(reviewText || '').trim();
  if (/^APPROVED\b/imu.test(normalized)) {
    return 'approved';
  }
  if (/^BLOCKED\b/imu.test(normalized)) {
    return 'blocked';
  }
  return 'invalid';
}

function buildReviewerPrompt({ prompt, ownerResponse, round, maxRounds }) {
  return [
    `Tribunal review round ${round} of ${maxRounds}.`,
    'Review the owner draft against the original request.',
    'Reply with either "APPROVED" or "BLOCKED: <reason>".',
    `Original user request:\n${prompt}`,
    `Owner draft:\n${ownerResponse}`,
  ].join('\n\n');
}

function buildOwnerRevisionPrompt({
  prompt,
  ownerResponse,
  reviewerResponse,
  round,
  maxRounds,
}) {
  return [
    `Revise the draft for tribunal round ${round + 1} of ${maxRounds}.`,
    'Return only the improved response for the user.',
    `Original user request:\n${prompt}`,
    `Current draft:\n${ownerResponse}`,
    `Reviewer feedback:\n${reviewerResponse}`,
  ].join('\n\n');
}

function buildArbiterPrompt({
  prompt,
  ownerResponse,
  reviewerResponse,
  maxRounds,
  reviewerVerdict = 'blocked',
}) {
  return [
    `You are the arbiter after ${maxRounds} tribunal round(s).`,
    'Provide the final response that should be sent to the user.',
    reviewerVerdict === 'invalid'
      ? 'The reviewer did not return a valid "APPROVED" or "BLOCKED" verdict. Treat the reviewer output as non-conforming feedback.'
      : null,
    `Original user request:\n${prompt}`,
    `Latest owner draft:\n${ownerResponse}`,
    `Latest reviewer feedback:\n${reviewerResponse}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function emitRoleMessage(callback, payload) {
  if (!callback) {
    return;
  }
  await callback(payload);
}

async function createRuntimeRecorder(projectRoot, { channel, prompt, workdir, onTransition = null }) {
  try {
    const run = await startRuntimeRun(projectRoot, {
      channel,
      prompt,
      workdir,
    });

    return {
      runId: run.runId,
      async transition(entry) {
        await swallowRuntimePersistenceError(() =>
          transitionRuntimeRun(projectRoot, run.runId, entry),
        );
        if (typeof onTransition === 'function') {
          await onTransition({
            ...entry,
            runId: run.runId,
            startedAt: run.startedAt,
          });
        }
      },
      async record(entry) {
        await swallowRuntimePersistenceError(async () => {
          await recordRuntimeRoleMessage(projectRoot, run.runId, entry);
          await enqueueRuntimeOutboxEvent(projectRoot, {
            runId: run.runId,
            channel,
            entry,
          });
          await recordRuntimeRoleSession(projectRoot, {
            channel,
            runId: run.runId,
            entry,
          });
        });
      },
      async complete(result) {
        await swallowRuntimePersistenceError(() =>
          completeRuntimeRun(projectRoot, run.runId, result),
        );
      },
      async fail(error) {
        await swallowRuntimePersistenceError(() =>
          failRuntimeRun(projectRoot, run.runId, error),
        );
      },
    };
  } catch {
    return {
      runId: null,
      async transition() {},
      async record() {},
      async complete() {},
      async fail() {},
    };
  }
}

async function swallowRuntimePersistenceError(callback) {
  try {
    await callback();
  } catch (error) {
    console.error(`Runtime persistence error: ${toErrorMessage(error)}`);
  }
}

async function loadRoleSessionHistory(projectRoot, { channel, role, runId }) {
  if (!channel?.name || !['owner', 'reviewer'].includes(role)) {
    return [];
  }

  try {
    return await listRecentRoleSessionContext(projectRoot, {
      channelName: channel.name,
      role,
      excludeRunId: runId,
      limit: 3,
    });
  } catch {
    return [];
  }
}

async function loadRoleRuntimeSession(projectRoot, { channel, role }) {
  if (!channel?.name || !role) {
    return null;
  }
  if (role === 'arbiter') {
    return null;
  }

  try {
    const session = await getRuntimeRoleSession(projectRoot, {
      channelName: channel.name,
      role,
    });
    if (!session) {
      return null;
    }
    if (session.sessionPolicy === 'ephemeral') {
      return null;
    }
    const currentAgentName =
      role === 'reviewer' ? channel.reviewer : channel.agent;
    if (currentAgentName && session.agentName && session.agentName !== currentAgentName) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function normalizeTurnResult(result) {
  if (result && typeof result === 'object' && 'text' in result) {
    return {
      content: String(result.text || ''),
      runtimeMeta: result.runtimeMeta || null,
      usage: result.usage || null,
    };
  }

  return {
    content: String(result || ''),
    runtimeMeta: null,
    usage: null,
  };
}
