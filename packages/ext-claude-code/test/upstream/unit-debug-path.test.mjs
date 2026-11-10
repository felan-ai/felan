import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { debugLogPath, diagLogPath, setBridgeAgentDir } from '../../src/bridge/log-paths.ts';
import { activateWithMockPi } from './lib/mock-pi.mjs';

describe('log path overrides', () => {
  it('resolves lazily from activation and debug env changes made after import', () => {
    const previous = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const nextAgentDir = join(process.env.HOME, 'next-agent');
      process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(process.env.HOME, 'override.log');
      setBridgeAgentDir(nextAgentDir);
      assert.equal(diagLogPath(), join(nextAgentDir, 'claude-bridge-diag.log'));
      assert.equal(debugLogPath(), process.env.CLAUDE_BRIDGE_DEBUG_PATH);
    } finally {
      process.env.CLAUDE_BRIDGE_DEBUG_PATH = previous;
      setBridgeAgentDir(agentDir);
    }
  });
});

describe('log paths', () => {
  it('follow the activation agentDir when no debug path override is set', () => {
    const previous = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
    try {
      delete process.env.CLAUDE_BRIDGE_DEBUG_PATH;
      activateWithMockPi();
      assert.equal(debugLogPath(), join(process.env.PI_CODING_AGENT_DIR, 'claude-bridge.log'));
      assert.equal(diagLogPath(), join(process.env.PI_CODING_AGENT_DIR, 'claude-bridge-diag.log'));
    } finally {
      process.env.CLAUDE_BRIDGE_DEBUG_PATH = previous;
    }
  });
});
