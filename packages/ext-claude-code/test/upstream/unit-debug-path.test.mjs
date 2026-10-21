import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@felan-ai/agent-core';
import { debugLogPath, diagLogPath, setBridgeAgentDir } from '../../src/bridge/log-paths.ts';
import { activateWithMockPi } from './lib/mock-pi.mjs';

describe('test harness', () => {
  it('redirects the bridge debug log away from the real one', () => {
    assert.ok(process.env.CLAUDE_BRIDGE_DEBUG_PATH);
    assert.notEqual(process.env.CLAUDE_BRIDGE_DEBUG_PATH, join(getAgentDir(), 'claude-bridge.log'));
  });

  it('keeps every path-derived location inside the temp root', () => {
    const root = process.env.HOME;
    assert.ok(root);
    for (const path of [homedir(), getAgentDir(), process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR,
      process.env.PI_CODING_AGENT_SESSION_DIR, process.env.FELAN_HOME, debugLogPath(), diagLogPath()]) {
      assert.ok(path.startsWith(root), `${path} must live under ${root}`);
    }
  });

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
