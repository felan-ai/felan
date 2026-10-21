import { join } from "path";

let agentDir: string | undefined;

export function setBridgeAgentDir(directory: string): void {
	agentDir = directory;
}

function requireAgentDir(): string {
	if (!agentDir) throw new Error("Claude Code bridge has not been activated");
	return agentDir;
}

export function debugLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(requireAgentDir(), "claude-bridge.log");
}

export function diagLogPath(): string {
	return join(requireAgentDir(), "claude-bridge-diag.log");
}
