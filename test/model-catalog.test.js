import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentEffortChoices } from '../src/model-catalog.js';

test('codex effort choices expand for xhigh-capable models', () => {
  assert.deepEqual(resolveAgentEffortChoices('codex', 'gpt-5.4'), [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  assert.deepEqual(resolveAgentEffortChoices('codex', 'gpt-5.3-codex'), [
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  assert.deepEqual(resolveAgentEffortChoices('codex', 'gpt-5-pro'), ['high']);
});

test('gemini effort choices depend on model family', () => {
  assert.deepEqual(resolveAgentEffortChoices('gemini-cli', 'gemini-2.5-flash'), [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
  ]);
  assert.deepEqual(resolveAgentEffortChoices('gemini-cli', 'gemini-3-flash-preview'), [
    'minimal',
    'low',
    'medium',
    'high',
  ]);
});

test('claude effort choices stay within cli-supported values', () => {
  assert.deepEqual(resolveAgentEffortChoices('claude-code', 'claude-sonnet-4-6'), [
    'low',
    'medium',
    'high',
    'max',
  ]);
});
