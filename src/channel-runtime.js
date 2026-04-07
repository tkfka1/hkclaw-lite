import { buildPromptEnvelope } from './prompt.js';
import { runAgentTurn } from './runners.js';
import {
  completeRuntimeRun,
  enqueueRuntimeOutboxEvent,
  failRuntimeRun,
  listRecentRoleSessionContext,
  recordRuntimeRoleMessage,
  recordRuntimeRoleSession,
  startRuntimeRun,
  transitionRuntimeRun,
} from './runtime-db.js';
import { getAgent } from './store.js';
import { assert, toErrorMessage } from './utils.js';

export async function executeChannelTurn({
  projectRoot,
  config,
  channel,
  prompt,
  workdir,
  onRoleMessage = null,
}) {
  const recorder = await createRuntimeRecorder(projectRoot, {
    channel,
    prompt,
    workdir,
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
      const content = await executeAgentTurnWithFallback({
        projectRoot,
        config,
        agent,
        channel,
        role: 'owner',
        userPrompt: prompt,
        workdir,
        sessionHistory: await loadRoleSessionHistory(projectRoot, {
          channel,
          role: 'owner',
          runId: recorder.runId,
        }),
      });

      await emitPersistedRoleMessage({
        role: 'owner',
        agent,
        content,
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
}) {
  const owner = getAgent(config, channel.agent);
  const reviewer = getAgent(config, channel.reviewer);
  const arbiter = getAgent(config, channel.arbiter);
  const maxRounds = channel.reviewRounds || 2;

  let ownerPrompt = prompt;
  let ownerResponse = '';
  let reviewerResponse = '';

  for (let round = 1; round <= maxRounds; round += 1) {
    await recorder.transition({
      status: 'owner_running',
      activeRole: 'owner',
      currentRound: round,
      maxRounds,
      note: `Owner round ${round} started.`,
    });
    ownerResponse = await executeAgentTurnWithFallback({
      projectRoot,
      config,
      agent: owner,
      channel,
      role: 'owner',
      userPrompt: ownerPrompt,
      workdir,
      sessionHistory: await loadRoleSessionHistory(projectRoot, {
        channel,
        role: 'owner',
        runId: recorder.runId,
      }),
    });
    await emitRoleMessage(onRoleMessage, {
      role: 'owner',
      agent: owner,
      content: ownerResponse,
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
    reviewerResponse = await executeAgentTurnWithFallback({
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
      workdir,
      sessionHistory: await loadRoleSessionHistory(projectRoot, {
        channel,
        role: 'reviewer',
        runId: recorder.runId,
      }),
    });
    const reviewerVerdict = parseReviewerVerdict(reviewerResponse);
    await emitRoleMessage(onRoleMessage, {
      role: 'reviewer',
      agent: reviewer,
      content: reviewerResponse,
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
      const arbiterResponse = await executeAgentTurnWithFallback({
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
        workdir,
      });
      await emitRoleMessage(onRoleMessage, {
        role: 'arbiter',
        agent: arbiter,
        content: arbiterResponse,
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
    reviewerVerdict: 'blocked',
    note: 'Arbiter invoked after review rounds were exhausted.',
  });
  const arbiterResponse = await executeAgentTurnWithFallback({
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
    }),
    workdir,
  });
  await emitRoleMessage(onRoleMessage, {
    role: 'arbiter',
    agent: arbiter,
    content: arbiterResponse,
    final: true,
    round: maxRounds,
    maxRounds,
    mode: 'tribunal',
    verdict: 'blocked',
  });
  return {
    role: 'arbiter',
    agent: arbiter,
    content: arbiterResponse,
    reviewerVerdict: 'blocked',
    runtimeFinalDisposition: 'arbiter_after_blocked_review',
  };
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
}) {
  assert(
    !visitedAgents.includes(agent.name),
    `Fallback loop detected: ${[...visitedAgents, agent.name].join(' -> ')}`,
  );

  const fullPrompt = buildPromptEnvelope({
    projectRoot,
    agent,
    channel,
    workdirOverride: workdir,
    userPrompt,
    sessionHistory,
  });

  try {
    return await runAgentTurn({
      projectRoot,
      agent,
      prompt: fullPrompt,
      rawPrompt: userPrompt,
      workdir,
      sharedEnv: config.sharedEnv,
    });
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

async function createRuntimeRecorder(projectRoot, { channel, prompt, workdir }) {
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
  } catch {}
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
