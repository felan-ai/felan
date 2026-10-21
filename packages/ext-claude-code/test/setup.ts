import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect } from 'vitest';
import { setBridgeAgentDir } from '../src/bridge/log-paths.js';
import { setClaudeAgentSdk } from '../src/sdk/runtime.js';
import { fakeSdk } from './upstream/lib/fake-sdk.mjs';

const root = mkdtempSync(join(tmpdir(), 'felan-claude-bridge-test-'));
const agentDir = join(root, 'agent');
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.FELAN_HOME = join(root, '.felan');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'sessions');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, 'claude-bridge.log');
delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
delete process.env.CLAUDE_BRIDGE_DEBUG;
setBridgeAgentDir(agentDir);
const upstream = expect.getState().testPath?.includes('/upstream/');
if (upstream) setClaudeAgentSdk(fakeSdk());

beforeEach(async () => {
  if (!upstream) return;
  const { __test } = await import('../src/bridge/index.js');
  __test.resetSharedSession();
  __test.setQuery(null);
  setClaudeAgentSdk(fakeSdk());
});
afterAll(() => {
  setClaudeAgentSdk(undefined);
  rmSync(root, { recursive: true, force: true });
});
