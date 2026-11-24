// Pi session id -> cwd. In the pi CLI process.cwd() is the session's cwd, but a
// host serving many sessions from one process (pi-web) has a single process cwd,
// so Claude Code would run in, and load project instructions from, the host's
// directory. Kept on globalThis because every module instance's session_start
// only sees its own session while provider calls can enter another loaded instance.
const SESSION_CWDS_KEY = Symbol.for("claude-bridge:sessionCwds");
const SUMMARY_SESSIONS_KEY = Symbol.for("claude-bridge:summarySessions");
const CWD_OVERRIDE_KEY = Symbol.for("claude-bridge:sessionCwdOverride");

function summarySessions(): WeakMap<AbortSignal, string> {
	const g = globalThis as Record<symbol, unknown>;
	return (g[SUMMARY_SESSIONS_KEY] ??= new WeakMap<AbortSignal, string>()) as WeakMap<AbortSignal, string>;
}

// Pi forwards the operation's signal from the before hook to every summary call.
export function rememberSummarySession(signal: AbortSignal, sessionId: string): void {
	summarySessions().set(signal, sessionId);
}

export function summarySessionFor(signal: AbortSignal | undefined): string | undefined {
	return signal ? summarySessions().get(signal) : undefined;
}

/** Felan: on a runtime whose workspace is not on this process's filesystem, every session
 *  runs Claude Code in one local directory instead of a pi cwd the child cannot enter.
 *  Applied when the cwd is read, so a session recorded by another module instance — or a
 *  summary call that never saw session_start — cannot fall back to the workspace path. */
export function setSessionCwdOverride(cwd: string | undefined): void {
	(globalThis as Record<symbol, unknown>)[CWD_OVERRIDE_KEY] = cwd;
}

function sessionCwdOverride(): string | undefined {
	return (globalThis as Record<symbol, unknown>)[CWD_OVERRIDE_KEY] as string | undefined;
}

function store(): Map<string, string> {
	const g = globalThis as Record<symbol, unknown>;
	return (g[SESSION_CWDS_KEY] ??= new Map<string, string>()) as Map<string, string>;
}

export function rememberSessionCwd(sessionId: string, cwd: string): void {
	store().set(sessionId, cwd);
}

export function forgetSessionCwd(sessionId: string): void {
	store().delete(sessionId);
}

export function sessionCwdFor(sessionId: string | null | undefined): string {
	return sessionCwdOverride() ?? (sessionId ? store().get(sessionId) : undefined) ?? process.cwd();
}
