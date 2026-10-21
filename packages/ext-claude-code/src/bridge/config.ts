export type ClaudeCodeSettings = {
	plan?: "pro" | "max";
	longContextExtraUsage?: boolean;
	forceTwoHundredK?: string[];
	strictMcpConfig?: boolean;
	autoMemoryEnabled?: boolean;
	pathToClaudeCodeExecutable?: string;
	inheritAnthropicEnvironment?: boolean;
};

export function claudeCodeSettings(settings: ClaudeCodeSettings = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: settings.autoMemoryEnabled ?? false };
}
