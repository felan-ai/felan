import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@felan-ai/agent-core";
import { builtinProviders } from "@felan-ai/agent-core";
import type { ExtensionAPI, ExtensionUIContext } from "@felan-ai/agent-core";
import { claudeAgentSdk } from "../sdk/runtime.js";
import type { Query, EffortLevel, SDKMessage, SettingSource, Base64ImageSource, ContentBlockParam } from "../sdk/types.js";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { debugLogPath, diagLogPath, setBridgeAgentDir } from "./log-paths.js";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeSettings, type ClaudeCodeSettings } from "./config.js";
import {
	assertIsolatedPromptSendable,
	projectPromptCapture,
	sharedPromptCaptures,
	type PromptCapture,
} from "./prompt-capture.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession, sessionCwdFor, summarySessionFor } from "./session-cwd.js";
import { updateUsage, type SdkUsage } from "./usage.js";
import { rateLimitResponse } from "./rate-limit.js";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging under the activation agentDir
// (log-paths.ts), not a fixed ~/.pi/agent.

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

// Applied to every Claude Code subprocess the bridge spawns — provider
// and the compact summary. One place, so a missing guard is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	// Felan: suppress background traffic in children without changing the daemon environment.
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

const ANTHROPIC_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;

// Felan: every child defaults to the local Claude plan login, not the daemon's API credentials.
function buildChildEnv(settings: ClaudeCodeSettings): Record<string, string | undefined> {
	const env = { ...process.env, ...CC_CHILD_ENV };
	if (!settings.inheritAnthropicEnvironment) {
		for (const key of ANTHROPIC_ENV_KEYS) delete env[key];
	}
	return env;
}

function inheritsAnthropicEnvironment(env: Record<string, string | undefined>): boolean {
	return ANTHROPIC_ENV_KEYS.some((key) => env[key] !== undefined);
}

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise project CLAUDE.md/AGENTS.md files arrive twice, and
// ~/.claude/CLAUDE.md — a user persona written for a harness that is not the
// one running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; the filename globs cover user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const logPath = debugLogPath();
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(logPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// debug, debugFile, and stderr options. Without this, CC's internal view is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths. Creates the agent
 *  dir itself: callers run inside streamSimple, where a missing dir must not throw. */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	const logPath = diagLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	appendFileSync(logPath, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${logPath})`);
}

// --- Constants ---

const MODELS = buildModels([...(builtinProviders().find((provider) => provider.id === "anthropic")?.getModels() ?? [])]);
// Felan: activations share one daemon module; the latest settings govern subsequent queries.
let providerSettings: ClaudeCodeSettings = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// Felan: local Claude Code credentials are independent of Felan provider credentials.
function describeClaudeCodeFailure(failure: string, inheritedAnthropicEnvironment = false): string {
	if (!/invalid api key|please run\s+\/login|not logged in|authentication_error|oauth token has expired|invalid bearer token|invalid credentials|authentication failed/i.test(failure)) return failure;
	const inherited = inheritedAnthropicEnvironment
		? " ANTHROPIC_* variables were inherited; disable the inheritAnthropicEnvironment setting to use the Claude plan login."
		: "";
	return "Claude Code is not signed in on this machine; run `claude` and then `/login`, then retry."
		+ inherited + "\n" + failure;
}

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// The pi session this CC conversation serves, from the provider call's
	// options.sessionId. Attribution for history rewrites: a subagent's
	// session_compact must not force a rebuild of a conversation that belongs
	// to a different pi session. Null until a provider call recorded it.
	piSessionId?: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY where we have just killed a CC subprocess: an abort, or a query
	// discarded because pi rewrote the history under it. The killed subprocess
	// may still be flushing a late "[Request interrupted by user]" record to the
	// session JSONL. Reusing the same sessionId/path would race that orphan write
	// into our fresh file and break CC's parent-uuid chain on the next resume.
	// When this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. A compact or tree navigation
	// with no query in flight does NOT set this — there's no concurrent CC writer
	// then, so in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		return collectCarriedAttachments(previous.records);
	} catch (error) {
		// A post-abort rebuild reads a file the killed CC subprocess may have been
		// midway through writing, and cc-session-io parses each line with a bare
		// JSON.parse, so a truncated last line throws. Throwing here would turn a
		// lost attachment into a failed turn; carrying none is exactly what happened
		// before this existed, so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

/** The session key a pi session's provider calls address. Unattributed calls
 *  (no options.sessionId — a host that omits it)
 *  share the "(none)" bucket: they cannot be told apart, so they share the
 *  pre-existing single-slot semantics. */
function sessionKey(piSessionId: string | null | undefined): string {
	return piSessionId ?? "(none)";
}

/** Mirror of the CC conversation one pi session's turns are running on. One
 *  entry per pi session: a bridge process serves several sessions at once
 *  (pi-subagents children run their own AgentSessions), and a single shared
 *  slot forced them to fight over it — a length-matching foreign sync could
 *  REUSE or rebuild another session's CC file, and the completion capture was
 *  last-writer-wins (a foreground child in the parent's first turn permanently
 *  reassigned the parent's conversation). Keyed lookup removes the fight: each
 *  session's reads, writes and teardown marks touch only its own mirror. */
const sharedSessions = new Map<string, SessionState>();
// Felan: a missing capture must fail a live session turn, not turn it into a one-off request.
const liveSessionIds = new Set<string>();

/** The mirror for `piSessionId`, or null when this session has none yet. */
function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	return sharedSessions.get(sessionKey(piSessionId)) ?? null;
}

/** Replace (or plant) the mirror for `piSessionId`. */
function setSessionStateFor(piSessionId: string | null | undefined, state: SessionState | null): void {
	if (state === null) {
		// Felan: clearing a session also invalidates in-flight writers, even before their first mirror exists.
		for (const c of activeQueryContexts) {
			if (sessionKey(c.piSessionId) === sessionKey(piSessionId) && c.activeQuery && typeof c.activeQuery === "object") {
				clearedSessionQueries.add(c.activeQuery);
			}
		}
		const live = liveQueries.get(sessionKey(piSessionId));
		if (live) clearedSessionQueries.add(live.sdkQuery);
		sharedSessions.delete(sessionKey(piSessionId));
	} else sharedSessions.set(sessionKey(piSessionId), state);
}

// pi replaced one of its sessions' history (compact, tree) rather than appending
// to it. Read on the tool-result path — the one provider call that never reaches
// syncSharedSession — so a query parked at a tool boundary is discarded rather
// than resumed (issue #101). Keyed by pi session id, not process-global: a bridge
// process serves several pi sessions at once (subagents run their own
// AgentSessions and can compact mid-run while the parent is parked), and
// marking across that boundary kills healthy queries (or, worse, rebuilds the
// parent around a compaction that never touched it).
//
// Holds real pi session ids only, never the "(none)" key: no production caller
// marks with null (the rewrite events attribute via ctx.sessionManager), and
// every reader guards on a non-null piSessionId — so a "(none)" entry could
// never be matched or consumed, only leaked.
const historyRewrittenBySession = new Set<string>();

/** Handlers that arm rewrite staleness, one per module instance. Worktree-
 *  spawned subagents can load this module fresh (pi's loader cache is keyed on
 *  cwd, and a worktree cwd clears it). A fresh instance must forward its
 *  session's rewrites to whichever instance serves that session's provider.
 *  Symbol.for: one registry per process, like SHARED_CAPTURES_KEY below. */
const MARK_REBUILD_HOOKS_KEY = Symbol.for("claude-bridge:markRebuildHooks");
type MarkRebuildHook = (piSession: string | null, event: string) => void;
const markRebuildHooks: Set<MarkRebuildHook> =
	((globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] as Set<MarkRebuildHook> | undefined) ?? new Set();
(globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] = markRebuildHooks;

/** pi mutated its messages array out from under us: force the next
 *  syncSharedSession down REBUILD, and arm the discard above. `piSession`
 *  is never null from an event handler (each pi session has its own runner).
 *  The "(none)" key still covers the mirror for a hypothetical direct caller
 *  with no session id, so such a rewrite forces the REBUILD side; the discard
 *  set holds real ids only — see the comment on historyRewrittenBySession. */
function markRebuildForSession(piSession: string | null, event: string): void {
	// The rewriting session's own mirror: the rewrite changed the history it was
	// built from, so its next sync must REBUILD rather than REUSE. Every other
	// session's mirror stays untouched — its conversation was never rewritten.
	const key = sessionKey(piSession);
	const state = sharedSessions.get(key);
	if (!state) {
		debug(`${event}: history rewritten, no session to mark yet`);
	} else {
		sharedSessions.set(key, { ...state, needsRebuild: true });
		debug(`${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`);
	}
	// Arming parked contexts cannot wait for delivery: the entry checks
	// `resultCtx.historyStale`, and a rewrite usually lands *while* the query is
	// parked (compaction runs inside pi's turn loop, not between provider calls).
	if (piSession) historyRewrittenBySession.add(piSession);
	armStaleContexts();
	// Felan: an idle process holds the history pi just rewrote; retire it before the next prompt needs to.
	if (piSession && liveQueries.get(piSession)?.idle) void retireLiveQuery(piSession, event);
}

/** Copy each armed session's mark onto the parked queries built from it. */
function armStaleContexts(): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
	}
}

// This instance enlists. Session ids reaching any hook equal options.sessionId
// on the serving instance's provider calls, so forwarding is safe: only the
// owning instance's contexts and SessionState match the key.
markRebuildHooks.add(markRebuildForSession);

/** Event handlers call this: it fans the rewrite out to every module instance
 *  in the process, of which exactly one is serving provider traffic for any
 *  given pi session. */
function sponsorMarkRebuildForSession(piSession: string | null, event: string): void {
	for (const hook of markRebuildHooks) hook(piSession, event);
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	carried?: readonly CarriedAttachment[],
): void {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	// Placement runs against the repaired array because that is the index space
	// importMessages reads. Attachments are links in CC's uuid chain, so they have
	// to be written in order with the messages, not appended afterwards.
	const placed = carried?.length
		? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
		: undefined;
	if (placed?.skipped.length) {
		debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
	}
	if (placed?.attachments.length) {
		debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
	}
	if (repaired.length) {
		session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
	}
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string | ContentBlockParam[] {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const prompt = extractUserPromptBlocks(messages) ?? extractUserPrompt(messages);
	if (!prompt) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return prompt;
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. */
function resultErrorText(message: SDKMessage, inheritedAnthropicEnvironment = false): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	let failure: string;
	if (result.subtype === "success") {
		if (!result.is_error) return undefined;
		failure = result.result || "Claude Code reported an error";
	} else if (Array.isArray(result.errors) && result.errors.length) {
		failure = result.errors.map(errorMessage).join("\n");
	} else if (result.error !== undefined) {
		failure = errorMessage(result.error);
	} else if (result.result) {
		failure = result.result;
	} else {
		failure = `Claude Code failed: ${result.subtype ?? "unknown result"}`;
	}
	return describeClaudeCodeFailure(failure, inheritedAnthropicEnvironment);
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude quota exceeded — rate limit" rather than appending keeps both phrases
 *  in any truncated render, and avoids the `<tool> failed (exit N):` shape that pi-subagents
 *  treats as a tool failure and refuses to retry. "quota exceeded" is on pi-ai's non-retryable
 *  list, which wins over its retryable "rate limit" pattern, so pi hands the rejected window
 *  straight to fallback instead of retrying a limit that resets in hours (issue #183). */
function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

/** Reports to the call that owns the open stream, before its next event, as pi's own
 *  providers do. A failing consumer must not end the turn it is observing. */
async function reportHeldRateLimit(c: QueryContext, model: Model<any>): Promise<void> {
	const info = c.heldRateLimit;
	if (!info || !c.currentPiStream || !c.currentOnResponse) return;
	c.heldRateLimit = undefined;
	try {
		await c.currentOnResponse(rateLimitResponse(info), model);
	} catch (error) {
		debug("rate limit: onResponse failed", error);
	}
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	// pi delivers compaction/branch-summary requests as a transcript: the summarization
	// prompt folded into a leading system message ahead of the lone user message
	// (issue #106). toBridgeContext restores the prompt/tools fields the extraction
	// assertion below assumes; the summarization prompt still reaches CC as its systemPrompt.
	context = toBridgeContext(context);
	let sdkQuery: ReturnType<Query> | undefined;
	let wasAborted = false;
	let inheritedAnthropicEnvironment = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		// One-off summarizer calls (compaction, branch summary, turn prefix, bug report —
		// anything routed through pi's completeSummarization) are marked cacheRetention:
		// "none". Any of them may appear in a future pi release without a bridge change,
		// so route on the marker, not on which summarizer is calling. Non-summarizer calls
		// must still match the [system,user] compaction shape exactly.
		assertIsolatedPromptSendable(context.systemPrompt);
		const isOneOffSummary = options?.cacheRetention === "none";
		const prompt = isOneOffSummary
			? extractUserPromptBlocks(context.messages) ?? extractUserPrompt(context.messages)
			: extractIsolatedSummaryPrompt(context.messages);
		if (!prompt) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId);
		const compactProviderSettings = providerSettings;
		const childEnv = buildChildEnv(compactProviderSettings);
		inheritedAnthropicEnvironment = inheritsAnthropicEnvironment(childEnv);
		const claudeExecutable = compactProviderSettings?.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		// Honour the caller's reasoning level, same mapping as the provider path.
		const effort = effortForReasoning(model, options?.reasoning);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"} promptLen=${prompt.length}`);

		sdkQuery = queryImpl({
			// Felan: prompt-only calls can carry images; the SDK needs streaming input to preserve them.
			prompt: typeof prompt === "string" ? prompt : (async function* () { yield userMessage(prompt); })(),
			options: {
				cwd,
				env: childEnv,
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(effort ? { effort } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message, inheritedAnthropicEnvironment);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = describeClaudeCodeFailure(errorMessage(err), inheritedAnthropicEnvironment);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + the owning session UI + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
	piSessionId?: string | null,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		// Felan: unattributed or closed sessions have no UI; keep their warnings in debug logs only.
		if (!piSessionId || !sessionUIs.get(piSessionId)) continue;
		// Felan: keep local paths in diagnostics and point npm users to shipped troubleshooting guidance.
		notifySession(piSessionId,
			`Session file issue: ${msg}\n` +
			`See the @felan-ai/ext-claude-code README (Compatibility section) and run /claude-code status for troubleshooting.` +
			(DEBUG ? ` Debug log: ${debugLogPath()}. Review it for private data before sharing.` : ` Rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log.`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
	function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	piSessionId?: string | null,
): SyncResult {
	// System messages are pi's transcript representation of prompt and tool state, not
	// conversation history — they are never imported into a CC session, so exclude them from
	// the history space (priorMessages, cursor, missed) everywhere below (issue #106).
	// The mirror this sync coordinates belongs to the syncing pi session alone:
	// every read and write below addresses sessionStateFor(piSessionId), so a
	// foreign session's shape-matching context can never REUSE or rebuild another
	// session's CC file.
	const sharedSession = sessionStateFor(piSessionId);
	const history = nonSystemMessages(messages);
	const priorMessages = history.slice(0, turnStart(history)); // everything before the current user turn

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
		if (trailingAssistantOnly) {
			setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd });
			debug(`Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${priorMessages.length}`);
		} else {
			debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		}
		debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession?.cursor}`);
		return { sessionId: sharedSession.sessionId };
		}
	}
	// This is what keeps a caller with a pruned or short context from resuming
	// — then overwriting — the bucket's session: shorter-than-cursor means the
	// incoming history cannot be a continuation, so start clean and preserve.
	// Historically this also caught reentrant subagents (a subagent's priors are
	// shorter than the parent's cursor); with per-session mirrors it now catches
	// the pruned-context shapes on a session's own bucket. The captured ephemeral session is
	// deleted once its query completes (see preserveSharedSession in the
	// completion handler).
	//
	// It is NOT, despite an earlier comment here, the isolated compact-summary
	// path: runIsolatedSummary never calls syncSharedSession at all.
	//
	// Only reachable when needsRebuild is false — user-facing history rewrites
	// (/compact, session_tree, /new, fork) always set needsRebuild or clear
	// sharedSession before the next syncSharedSession call.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${history.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped when there's a concurrent
	// writer we shouldn't race (forceRotate).
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : [];
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	session.save();
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd, piSessionId);
	setSessionStateFor(piSessionId, { sessionId: session.sessionId, cursor: priorMessages.length, cwd, piSessionId: piSessionId ?? undefined });
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// The SDK's query(), or a test double (see setQuery).
const managedQuery: Query = (request) => claudeAgentSdk().query(request);
let queryImpl: Query = managedQuery;

// @internal
export const __test = {
	setQuery(fn: Query | null) {
		queryImpl = fn ?? managedQuery;
	},
	resetSharedSession(piSessionId?: string | null) {
		// No id: full reset (the pre-map semantics — tests start from a blank slate).
		// Felan: fixtures must reset lifecycle ownership as well as conversation mirrors.
		if (piSessionId === undefined) {
			sharedSessions.clear();
			liveSessionIds.clear();
		} else {
			setSessionStateFor(piSessionId, null);
			liveSessionIds.delete(piSessionId);
		}
		historyRewrittenBySession.clear();
	},
	markRebuildForSession,
	getHistoryRewritten: () => historyRewrittenBySession.size > 0,
	historyRewrittenBySession,
	armStaleContexts,
	discardRewrittenQuery,
	contextForToolResults,
	isQueryAbandoned: (q: object) => abandonedQueries.has(q),
	get activeQueryContexts() {
		return activeQueryContexts;
	},
	get liveQueries() {
		return liveQueries;
	},
	retireLiveQuery,
	setSharedSession(piSessionId: string | null, state: SessionState | null) {
		setSessionStateFor(piSessionId, state);
	},
	getSharedSession(piSessionId: string | null = null) {
		return sessionStateFor(piSessionId);
	},
	setPiUI(ui: ExtensionUIContext | null, piSessionId: string) {
		if (ui) sessionUIs.set(piSessionId, ui);
		else sessionUIs.delete(piSessionId);
	},
	verifyWrittenSession,
	toBridgeContext,
	isolatedStreamFn,
	effortForReasoning,
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers,
	get promptCaptures() {
		return promptCaptures;
	},
};

// --- Provider helpers: tool name mapping ---

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Felan: each activation owns a session UI; never notify the most recently active session by default.
const sessionUIs = new Map<string, ExtensionUIContext>();
function notifySession(piSessionId: string | null | undefined, message: string, type: "warning"): void {
	const ui = piSessionId ? sessionUIs.get(piSessionId) : undefined;
	if (ui) ui.notify(message, type);
	else debug(message);
}

const activeQueryContexts = new Set<QueryContext>();
// Felan: weak ownership survives late completions without retaining closed sessions or SDK queries.
const clearedSessionQueries = new WeakSet<object>();

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot. One process-wide instance, shared
// across every extension module instance: isolated subagents re-evaluate this
// module, and the pinned stream they all route through resolves against it.
const promptCaptures = sharedPromptCaptures((diagnostic) => {
	const first = diagnostic.matches[0];
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string, piSessionId: string): void {
	const contexts = [...activeQueryContexts].filter((c) => c.piSessionId === piSessionId);
	const pendingCalls = contexts.reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = contexts.filter((c) => c.promptStream !== null).length;
	if (contexts.length === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${contexts.length} `
		+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Usage helpers ---

// The counter mapping lives in usage.ts; the debug line is this side's job, so every
// call site logs the same way rather than three times over.
function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>): void {
	const { cachePct, reasoning } = updateUsage(output, usage, model);
	const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
// ships a map for most Claude models; the table above covers models without
// one, and the levels a map leaves unnamed. A null entry means the level is
// unsupported on that model: no effort argument is sent, so Claude Code's own
// default applies rather than the generic table's value. Map values are
// provider-generic strings, so a map value is trusted only when it names a
// level CC accepts.
function effortForReasoning(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
	c.currentOnResponse = options?.onResponse;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	if (c.turnOutput.stopReason === "error") {
		stream!.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream!.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		// Still open from an earlier message_start: Claude Code gave up on that
		// stream and is retrying it. Its blocks were never completed.
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) recordUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") {
		dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
		c.turnStreamOpen = false;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

/** Remove the blocks of the message that just stopped which never got their own
 *  content_block_stop, because the stream was cut inside them. A tool call left
 *  that way carries whatever JSON survived the cut — `{}` when no delta landed at
 *  all — under an id Claude Code drops from its own conversation before resuming
 *  the turn, so it will never dispatch that id and nothing could answer a result
 *  keyed to it; pi would reject the call, and its result would sit unmatched while
 *  the resumed call waited in a handler. A thinking block left that way has no
 *  signature.
 *
 *  Per block rather than per message: Claude Code keeps the blocks that did
 *  complete, tool calls included, and one it dispatched while pi was never told is
 *  the same deadlock the other way round. Nothing here ends the pi turn — with no
 *  finished tool call left the resume is more of this same turn, and a turn ended
 *  here would leave the real call with no stream to arrive on. */
function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
	const dropped: string[] = [];
	for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
		// `index` is deleted at content_block_stop, so it marks a block that never closed.
		if (c.turnBlocks[i].index === undefined) continue;
		dropped.push(`${c.turnBlocks[i].type}${c.turnBlocks[i].id ? `[${c.turnBlocks[i].id}]` : ""}`);
		c.turnBlocks.splice(i, 1);
	}
	if (!dropped.length) return;
	debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.reverse().join(",")}`);
	c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
}

/** Remove the blocks a stream Claude Code abandoned mid-message. Their own
 *  content_block_stop never came, so a thinking block has no signature and a tool
 *  call is one CC will never dispatch; left in, pi would run the tool and the turn
 *  would wait on a handler that never comes, or the next request would replay a
 *  broken block.
 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
 *  rejects a repeated start, so it would need a change there to drive this provider. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks
// again without streaming ("Error streaming, falling back to non-streaming mode"),
// and the answer arrives as one assistant message, under a new message id, with no
// stream_events of its own. turnSawStreamEvent is already set by the dead stream,
// so gating on it alone dropped that message: its tool calls never reached pi, CC
// sat in the MCP handler waiting for their results, and the turn hung on "Working"
// until the user aborted it.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	// Claude Code reports API failures and its own quota/context notices as a
	// `<synthetic>` assistant message: a report, not model output. Streaming its text
	// pins the turn's output before the failure it describes, and a consumer that only
	// fails over before output commits (pi-model-fallback-alias) then cannot reach the
	// next provider. Keep the wording on the failed turn — the error event carries it —
	// but emit no events, so the turn still reads as a call that produced no output.
	// Issue #162.
	if (assistantMsg.model === "<synthetic>") {
		// The report can follow a stalled stream whose non-streaming retry also failed;
		// drop the abandoned partial blocks (unsigned thinking, a tool call CC will never
		// dispatch) the way the fallback path below would.
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c, "synthetic failure report");
		debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
			else debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);
		return;
	}
	if (c.turnSawStreamEvent) {
		// Same id was already delivered; a new id is CC's non-streaming fallback.
		// Drop the stalled stream's partial blocks if it never stopped. Deliberately
		// deliver even if it stopped, at the risk of duplication if CC renumbers it.
		const id = assistantMsg.id;
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
	}
	c.turnToolCallIds = [];
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<Query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery
		// sees, one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to
		// capture replay fixtures, so unit tests assert against message shapes Claude
		// Code really emitted rather than ones we imagined.
		const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;
		if (recordStreamPath) appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`);
		queryCtx.turnSdkMessages++;
		if (wasAborted()) break;
		await reportHeldRateLimit(queryCtx, model);
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message, queryCtx.inheritedAnthropicEnvironment);
			// Felan: a live session's process waits for its next prompt; a failed turn still ends it.
			if (resultError !== undefined || !queryCtx.endLiveTurn) queryCtx.promptStream?.end();
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info) queryCtx.heldRateLimit = info;
			await reportHeldRateLimit(queryCtx, model);
			// Felan: no allowed_warning toast; Powerline shows plan utilization from the headers above.
			if (info?.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
				// resetsAt is Unix seconds, not milliseconds.
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
				notifySession(queryCtx.piSessionId, `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
			}
			continue;
		}
		// Only the query that owns the context: a discarded one may still be draining into it.
		const liveTurnEnded = message.type === "result" && resultError === undefined
			&& queryCtx.endLiveTurn !== null && queryCtx.activeQuery === sdkQuery;
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) {
			if (liveTurnEnded) queryCtx.endLiveTurn(capturedSessionId);
			// Felan: an idle live process answering a prompt pi never sent has left pi's history.
			else if (!queryCtx.turnOutput && queryCtx.endLiveTurn && message.type !== "system") retireDivergedLiveQuery(queryCtx);
			continue;
		}

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
					// The failure itself was recorded above the guard, along with the served
					// context window. What is left here is the success path: push the result
					// text when no assistant message already delivered it.
					if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
		if (liveTurnEnded) queryCtx.endLiveTurn(capturedSessionId);
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
function steerMissedSession(c: QueryContext, text: string): void {
	c.missedSteer = true;
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
	debug(`provider: steer never reached CC, marked query for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(c, text);
		} else {
			try {
				// Felan: set before the write lands; the turn's result can arrive first.
				c.steeredSincePrompt = true;
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(c, text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		notifySession(c.piSessionId, `Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** Queries pi's history moved out from under. Their completion must not touch
 *  `sharedSession` or the pi stream: the query that took over the turn has
 *  already rebuilt both from the new history, and this one's session id names the
 *  conversation pi just discarded. */
const abandonedQueries = new WeakSet<object>();

/** The prompt a continuation query is opened with: the pi turn goes on, but its
 *  last message is a tool result rather than a prompt, and query() cannot resume
 *  a session without one. */
const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";

/** The prompt a resumed tool result is opened with: no query of this process
 *  was parked on it (a restart, a crash, a stall), so the turn goes on from
 *  history that ends at the result. */
const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

/** Drop a Claude Code query parked at a tool boundary whose conversation pi has
 *  since rewritten (/compact, tree navigation).
 *
 *  Delivering the turn's tool result into that query hands Claude Code the
 *  context pi just shrank: one pi turn is one CC query, and the query keeps its
 *  own context inside the CLI whatever pi does to its transcript. It answers off
 *  the pre-compaction conversation, reports the pre-compaction usage back, and pi
 *  crosses the same threshold at the next boundary — measured as one compaction
 *  per tool call with usage never dropping (issue #101). `needsRebuild` does not
 *  prevent it: only syncSharedSession reads that flag, and tool-result delivery
 *  is the one call that never syncs.
 *
 *  The caller then takes the fresh-query path, where REBUILD imports pi's
 *  rewritten history — this tool result included, since it is already in that
 *  history — so the turn continues instead of ending here. Nothing is lost by
 *  killing the subprocess: pi owns the only copy of the conversation that counts. */
function discardRewrittenQuery(c: QueryContext): void {
	const discarded = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
	if (discarded) abandonedQueries.add(discarded);
	if (c.piSessionId && liveQueries.get(c.piSessionId)?.ctx === c) liveQueries.delete(c.piSessionId);
	c.activeQuery = null;
	// Leaving the routing set is what stops this result coming straight back here:
	// contextForToolResults only matches ids against contexts still in it.
	activeQueryContexts.delete(c);
	c.turnToolCallIds = [];
	c.promptStream?.fail(new Error("conversation rewritten"));
	c.promptStream = null;
	// Settle the parked handlers before killing the CLI, for drainForAbort's
	// reason: one left awaiting a dead subprocess never settles.
	c.releasePendingToolCalls("Context was compacted; this query was discarded.");
	void discarded?.interrupt?.().catch(() => {});
	try { discarded?.close?.(); } catch {}
	// The CLI we just killed may still flush a record into the session JSONL, and
	// the rebuild is the next thing that happens — so rotate rather than race it,
	// exactly as after an abort. Only this session's mirror: the discarding query
	// proves its own conversation is the one being rebuilt around.
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
	if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
	debug("provider: history rewritten under a parked query — discarded it, rebuilding from current history");
}

/** Felan: a live pi session keeps its Claude Code process between prompts. The next
 *  prompt is written to its stdin, skipping the process start and session reload a
 *  resumed process pays; a prompt the running process cannot continue retires it. */
interface LiveQuery {
	ctx: QueryContext;
	sdkQuery: object;
	/** What the process was started with; a prompt that needs anything else retires it. */
	config: LiveQueryConfig;
	/** Between turns: the last one ended on a successful result. */
	idle: boolean;
	bindTurnAbort: (signal: AbortSignal | undefined) => void;
	/** Closes stdin, so Claude Code finishes writing its session and exits. */
	end: () => void;
	/** Kills the process, as an abort does. */
	kill: () => void;
	/** Settles once the process has exited and its completion handlers have run. */
	exited: Promise<void>;
	/** Reruns the current turn on a fresh process, for a prompt the exiting process never answered. */
	replay: (() => void) | null;
}
type LiveQueryConfig = Record<"model" | "cliModel" | "effort" | "cwd" | "systemPrompt" | "tools" | "settings", string>;
const liveQueries = new Map<string, LiveQuery>();
/** Idle processes still exiting; a fresh query for their session waits so it resumes a complete session file. */
const retiringQueries = new Map<string, Promise<void>>();
const RETIRE_GRACE_MS = 10_000;

function liveQueryConfig(model: Model<any>, tools: Tool[], systemPromptAppend: string | undefined, options: SimpleStreamOptions | undefined): LiveQueryConfig {
	return {
		model: model.id,
		cliModel: claudeCodeModelId(model, longContextSettings),
		effort: effortForReasoning(model, options?.reasoning) ?? "",
		cwd: sessionCwdFor(options?.sessionId),
		systemPrompt: systemPromptAppend ?? "",
		tools: JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.parameters])),
		settings: JSON.stringify(providerSettings),
	};
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		timer.unref?.();
		void promise.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Stop keeping a session's Claude Code process. An idle one has its stdin closed so
 *  it finishes writing the session the next query resumes, and is killed if it
 *  outlasts the grace period. One mid-turn is only released: it ends with its turn,
 *  as a query that was never live does. */
function retireLiveQuery(piSessionId: string | null | undefined, why: string): Promise<void> {
	if (!piSessionId) return Promise.resolve();
	const live = liveQueries.get(piSessionId);
	if (!live) return retiringQueries.get(piSessionId) ?? Promise.resolve();
	liveQueries.delete(piSessionId);
	debug(`provider: retiring Claude Code process for ${piSessionId} (${why}), idle=${live.idle}`);
	if (!live.idle) return Promise.resolve();
	const retired: Promise<void> = (async () => {
		live.end();
		if (await settlesWithin(live.exited, RETIRE_GRACE_MS)) return;
		debug(`provider: Claude Code process for ${piSessionId} did not exit after its input closed, killing it`);
		live.kill();
		if (await settlesWithin(live.exited, RETIRE_GRACE_MS)) return;
		// Still running: it may yet write the session file, so the next query must not resume it.
		const state = clearedSessionQueries.has(live.sdkQuery) ? null : sessionStateFor(piSessionId);
		if (state) setSessionStateFor(piSessionId, { ...state, needsRebuild: true, forceRotate: true });
	})().finally(() => {
		if (retiringQueries.get(piSessionId) === retired) retiringQueries.delete(piSessionId);
	});
	retiringQueries.set(piSessionId, retired);
	return retired;
}

/** The idle process produced output for a prompt pi never sent. Its conversation now
 *  holds an exchange pi's history lacks, so the next query rebuilds from pi's. */
function retireDivergedLiveQuery(c: QueryContext): void {
	if (!c.piSessionId || liveQueries.get(c.piSessionId)?.ctx !== c) return;
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
	void retireLiveQuery(c.piSessionId, "output arrived between turns");
}

/** syncSharedSession's REUSE test without its side effects: the cursor the session
 *  advances to when pi's history before this prompt only adds the final assistant
 *  message Claude Code already holds, or undefined when the histories diverged. */
function continuedSessionCursor(messages: Context["messages"], cursor: number): number | undefined {
	const history = nonSystemMessages(messages);
	const priorMessages = history.slice(0, turnStart(history));
	if (priorMessages.length < cursor) return undefined;
	const missed = priorMessages.slice(cursor);
	if (missed.length === 0 || (missed.length === 1 && (missed[0] as { role?: string }).role === "assistant")) return priorMessages.length;
	return undefined;
}

/** Writes this prompt to the session's idle Claude Code process. Returns why it
 *  cannot, without touching the stream, when the prompt needs a fresh process. */
function continueLiveQuery(live: LiveQuery, stream: AssistantMessageEventStream, model: Model<any>, context: Context, options: SimpleStreamOptions | undefined): string | undefined {
	const c = live.ctx;
	const piSessionId = c.piSessionId!;
	const state = sessionStateFor(piSessionId);
	if (!c.promptStream) return "its input is closed";
	if (c.historyStale || historyRewrittenBySession.has(piSessionId)) return "history was rewritten";
	if (!state || state.needsRebuild) return "the session needs a rebuild";
	if (context.messages[context.messages.length - 1]?.role !== "user") return "the turn does not start with a prompt";
	const cursor = continuedSessionCursor(context.messages, state.cursor);
	if (cursor === undefined) return "history diverged from the running session";
	const { mcpTools } = resolveMcpTools(context);
	let systemPromptAppend: string | undefined;
	try {
		const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
		systemPromptAppend = promptCapture
			? projectPromptCapture(promptCapture, { skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none" })
			: undefined;
	} catch {
		return "the system prompt is unresolved";
	}
	const config = liveQueryConfig(model, mcpTools, systemPromptAppend, options);
	const changed = (Object.keys(config) as (keyof LiveQueryConfig)[]).find((key) => config[key] !== live.config[key]);
	if (changed) return `${changed} changed`;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	const promptText = extractUserPrompt(context.messages);
	if (!promptBlocks && !promptText) return "the prompt is empty";

	claimCurrentPiStream(stream, "live-turn", c, options);
	c.resetTurnState(model);
	c.turnToolCallIds = [];
	c.latestCursor = 0;
	c.turnContextLength = context.messages.length;
	c.turnSdkMessages = 0;
	c.steeredSincePrompt = false;
	c.missedSteer = false;
	setSessionStateFor(piSessionId, { ...state, cursor });
	live.idle = false;
	live.replay = () => void streamAfter(Promise.resolve(), model, context, options, stream);
	activeQueryContexts.add(c);
	debug(`provider: live turn on session ${state.sessionId.slice(0, 8)}, msgs=${context.messages.length}, cursor=${cursor}`);
	live.bindTurnAbort(options?.signal);
	void c.promptStream?.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText! }]))
		.catch((error) => debug("provider: live prompt push rejected:", error));
	return undefined;
}

/** Runs a provider call once `pending` settles, forwarding its events into `stream`.
 *  An abort while waiting ends the call without starting it. */
function streamAfter(
	pending: Promise<void>, model: Model<any>, context: Context, options: SimpleStreamOptions | undefined,
	stream = createAssistantMessageEventStream(),
): AssistantMessageEventStream {
	const signal = options?.signal;
	let onAbort: () => void = () => {};
	const aborted = new Promise<boolean>((resolve) => {
		onAbort = () => resolve(true);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
	void Promise.race([pending.then(() => false), aborted]).then(async (wasAborted) => {
		signal?.removeEventListener("abort", onAbort);
		if (wasAborted) {
			stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
			return;
		}
		for await (const event of streamClaudeAgentSdk(model, context, options)) stream.push(event);
	}).catch((error) => {
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", errorMessage(error)) });
	}).finally(() => stream.end());
	return stream;
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	// pi hands providers a transcript (prompt/tools folded into system messages) — fold it
	// back out to the prompt/tools fields every cursor write, syncSharedSession call and
	// prompt-capture lookup below assumes (issue #106).
	context = toBridgeContext(context);

	// Pi's compaction, branch-summary and bug-report calls use cacheRetention:"none"
	// in completeSummarization. Their prompts bypass the capture boundaries, so route
	// them to an isolated persistSession:false CC process without session sync.
	// Felan: lifecycle identity separates real session turns from one-off Models calls, which can embed captures too.
	const isPromptOnly = !context.tools?.length
		&& context.messages.length === 1 && context.messages[0].role === "user"
		&& !liveSessionIds.has(options?.sessionId);
	if (options?.cacheRetention === "none" || isPromptOnly) {
		debug(`provider: one-off call routed to isolated summary, msgs=${context.messages.length}`);
		return isolatedStreamFn(model, context, options);
	}

	// Felan: a live session's prompt continues its running Claude Code process. Any other
	// call for that session waits until the process it would replace has exited.
	const running = options?.sessionId ? liveQueries.get(options.sessionId) : undefined;
	if (running?.idle) {
		const liveStream = createAssistantMessageEventStream();
		const refusal = continueLiveQuery(running, liveStream, model, context, options);
		if (refusal === undefined) return liveStream;
		void retireLiveQuery(options.sessionId, refusal);
	}
	const retiring = options?.sessionId ? retiringQueries.get(options.sessionId) : undefined;
	if (retiring) return streamAfter(retiring, model, context, options);

	const stream = createAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	let activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

	// pi rewrote its history while this query sat parked at a tool boundary, so the
	// query answers about a conversation that no longer exists. Discard it and let
	// this tool result carry the turn into a fresh query over the rewritten history.
	// The staleness mark is per pi session: a subagent's compaction (its own
	// AgentSession, sharing this process) must not discard the parent's parked
	// query, and vice versa.
	const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);
	if (resultCtx && rewrittenUnderQuery) {
		discardRewrittenQuery(resultCtx);
		resultCtx = undefined;
		// Recomputed, not cleared: a reentrant subagent may still hold a query of its own.
		activeQuery = ctx().activeQuery !== null;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx, options);
		resultCtx.resetTurnState(model);
		// A rewrite that armed the mark after this query parked gets copied here,
		// though markRebuildForSession usually reaches it directly.
		if (!resultCtx.historyStale && resultCtx.piSessionId && historyRewrittenBySession.has(resultCtx.piSessionId)) {
			resultCtx.historyStale = true;
		}
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		const state = sessionStateFor(resultCtx.piSessionId);
		if (state) state.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message. The discard
	// branch above already siphoned off the stale-query case, which goes on to a
	// rebuild instead — that one has somewhere to deliver the result to.
	// Only when this call's own signal is aborted: after an abort during a tool
	// call, pi calls back with the run's (already aborted) signal. A result that
	// arrives otherwise -- after a restart (a durable host resuming a run), a
	// crash, a stall, or an overflow/quota retry -- has no parked query either, and
	// falls through to the fresh-query path, which resumes the CC session and
	// delivers it.
	const lastMsg = context.messages[context.messages.length - 1];
	const unparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
	if (unparkedToolResult && options?.signal?.aborted) {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		// With no query in flight anywhere, the top-level session this result
		// belongs to is the one whose turn just ended: its cursor advances to
		// count the result (options.sessionId is that session — pi emits the
		// result event through the same session's streamSimple call).
		const orphanState = sessionStateFor(options?.sessionId ?? null);
		if (orphanState && activeQueryContexts.size === 0) orphanState.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt fails this query before anything
	// is claimed or reset, leaving no half-built query behind — in particular no stream
	// claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	// Derive the key from the transcript replay (toBridgeContext), NOT from the
	// recorded keys: under a forced prompt the transcript head is projected via
	// transformContext after turn_start, so ctx.getSystemPrompt() is not the head.
	let promptCapture: PromptCapture | undefined;
	let systemPromptAppend: string | undefined;
	try {
		promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
		systemPromptAppend = promptCapture
			? projectPromptCapture(promptCapture, {
				skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
			})
			: undefined;
	} catch (err) {
		// resolveOrDerive and projectPromptCapture throw to stop a turn that would lose
		// its instructions or leak pi's harness text. Report it on the stream, as pi-ai's
		// provider contract expects, so any caller — not only pi's agent loop, which
		// catches a throw — sees a failed turn rather than a synchronous exception.
		const output = newAssistantOutput(model, "", "error", errorMessage(err));
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error: output });
			markStreamComplete(stream);
			stream.end();
		});
		diagDump("prompt_capture_unresolved", {
			promptChars: context.systemPrompt?.length ?? 0,
			knownKeys: promptCaptures.size,
			reentrantUserQuery: isReentrantUserQuery,
			error: errorMessage(err),
		});
		return stream;
	}

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
	// A held event belongs to the query that received it, not to this request.
	queryCtx.heldRateLimit = undefined;
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;
	// The served pi session, for rewrite attribution on delivery (issue #101
	// follow-up) and on SessionState. A fresh instance of this module inside a
	// worktree-spawned subagent has its own contexts; each records its own.
	queryCtx.piSessionId = options?.sessionId ?? null;
	// A discarded query's replacement reuses this context; without the reset its
	// first tool result would sit on armed staleness again (the mark is consumed
	// from the set, not from here) and re-discard a healthy query.
	queryCtx.historyStale = false;
	queryCtx.missedSteer = false;
	queryCtx.turnContextLength = context.messages.length;
	queryCtx.endLiveTurn = null;
	queryCtx.steeredSincePrompt = false;

	const cwd = sessionCwdFor(options?.sessionId);
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	// Which pi session this query serves — the attribution key for history
	// rewrites (session_compact / session_tree) and for SessionState above.
	const piSessionId = options?.sessionId ?? null;
	// Read before the consume below: with no query parked (an overflow retried
	// after compaction), the session's mark is the only sign of the rewrite.
	const historyRewritten = rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId));
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId);
	// This query starts from the history pi has now: consume this session's
	// armed rewrite — a sibling pi session's stays armed for its own queries.
	if (piSessionId) historyRewrittenBySession.delete(piSessionId);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// A turn continuing past a rewrite ends at its tool result, not at a
	// prompt, so say what happened rather than falling into the empty-prompt
	// recovery below — that one is for a shape we do not expect, and this is one
	// we do. The rebuilt session already ends with the tool result, placed after
	// the tool call it answers.
	if (historyRewritten && !promptText && !promptBlocks) {
		promptText = CONTINUE_AFTER_REWRITE_PROMPT;
		debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
	}
	if (unparkedToolResult && !promptText && !promptBlocks) {
		promptText = CONTINUE_AFTER_RESUME_PROMPT;
		debug(`provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
	}

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sessionStateFor(piSessionId) ? { sessionId: sessionStateFor(piSessionId)!.sessionId.slice(0, 8), cursor: sessionStateFor(piSessionId)!.cursor } : (sessionStateFor(null) ? { sessionId: sessionStateFor(null)!.sessionId.slice(0, 8), cursor: sessionStateFor(null)!.cursor } : null),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const effort = effortForReasoning(model, options?.reasoning);

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see activation handler). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = buildChildEnv(providerSettings);
	queryCtx.inheritedAnthropicEnvironment = inheritsAnthropicEnvironment(childEnv);
	const queryOptions: NonNullable<Parameters<Query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		settings: {
			...claudeCodeSettings(providerSettings),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
		},
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	let sdkQuery: ReturnType<Query>;
	try {
		sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions });
	} catch (error) {
		// Felan: synchronous SDK failures need the same sign-in guidance and terminal stream as async errors.
		promptStream.fail(error instanceof Error ? error : new Error(String(error)));
		queryCtx.promptStream = null;
		setSessionStateFor(queryCtx.piSessionId, null);
		queryCtx.turnOutput.stopReason = "error";
		queryCtx.turnOutput.errorMessage = describeClaudeCodeFailure(errorMessage(error), queryCtx.inheritedAnthropicEnvironment);
		finalizeCurrentStream(queryCtx, "error");
		return stream;
	}
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	// Felan: a live process serves several turns, each aborted through its own provider call.
	let boundSignal: AbortSignal | undefined;
	const bindTurnAbort = (signal: AbortSignal | undefined) => {
		boundSignal?.removeEventListener("abort", onAbort);
		boundSignal = signal;
		queryCtx.turnSignal = signal;
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	};

	// --- Capture session ID ---
	// This query's own mirror — a reentrant subagent completing does not
	// reassign the parent's conversation to the child's CC file.
	// Felan: a shutdown or reset must not let a late completion recreate or overwrite its mirror.
	const recordCompletedTurn = (capturedSessionId: string | undefined) => {
		if (clearedSessionQueries.has(sdkQuery)) {
			debug("provider: query completed after session clear, leaving its mirror untouched");
		} else if (syncResult.preserveSharedSession) {
			const state = sessionStateFor(queryCtx.piSessionId);
			if (capturedSessionId && capturedSessionId !== state?.sessionId) {
				deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
				debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
			}
			debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
		} else {
			const state = sessionStateFor(queryCtx.piSessionId);
			const sessionId = capturedSessionId ?? state?.sessionId;
			if (sessionId) {
				const cursor = Math.max(queryCtx.turnContextLength, queryCtx.latestCursor, state?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				// A missed steer may precede the first mirror or arrive while this
				// query is still able to complete. Preserve both rebuild signals.
				setSessionStateFor(queryCtx.piSessionId, { ...state, sessionId, cursor, cwd, piSessionId: queryCtx.piSessionId ?? undefined, needsRebuild: queryCtx.missedSteer || state?.needsRebuild });
			}
		}
	};

	// Felan: a live session keeps the process when its turn completes on its own mirror;
	// a clean start beside a preserved mirror, or a query beside a live one, ends with its turn.
	const keepAlive = piSessionId !== null && liveSessionIds.has(piSessionId)
		&& !syncResult.preserveSharedSession && !liveQueries.has(piSessionId);
	let markExited = () => {};
	const live: LiveQuery | null = keepAlive ? {
		ctx: queryCtx,
		sdkQuery,
		config: liveQueryConfig(model, mcpTools, systemPromptAppend, options),
		idle: false,
		bindTurnAbort,
		end: () => promptStream.end(),
		kill: onAbort,
		exited: new Promise<void>((resolve) => { markExited = resolve; }),
		replay: null,
	} : null;
	// The process is gone: no later prompt may be written to it.
	const forgetLive = () => {
		if (live && liveQueries.get(piSessionId) === live) liveQueries.delete(piSessionId);
	};
	// Felan: a prompt written to a process that exited without a word for it reruns on a
	// fresh one; pi has seen nothing of the turn. Runs once this process is fully gone.
	let replayAfterExit: (() => void) | null = null;
	const replayUnansweredTurn = (): boolean => {
		if (!live?.replay || queryCtx.turnSdkMessages > 0) return false;
		debug("provider: Claude Code process exited before answering its prompt, rerunning the turn on a fresh process");
		replayAfterExit = live.replay;
		live.replay = null;
		queryCtx.currentPiStream = null;
		if (!isReentrant && queryCtx.activeQuery === sdkQuery) queryCtx.activeQuery = null;
		return true;
	};
	const endLiveTurn = live ? (capturedSessionId: string | undefined) => {
		// Released mid-turn, or steered: Claude Code answers a steer it did not drain
		// as a turn of its own, which only a turn ending on process exit still carries.
		if (liveQueries.get(piSessionId) !== live || queryCtx.steeredSincePrompt) {
			forgetLive();
			promptStream.end();
			return;
		}
		recordCompletedTurn(capturedSessionId);
		live.idle = true;
		live.replay = null;
		bindTurnAbort(undefined);
		queryCtx.turnToolCallIds = [];
		activeQueryContexts.delete(queryCtx);
		debug("provider: turn done, keeping its Claude Code process for the next prompt");
		finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		// pi keeps the delivered message; a later failure of the idle process must not rewrite it.
		queryCtx.turnOutput = null;
		// A steer that never reached Claude Code leaves the process behind pi's history.
		if (sessionStateFor(piSessionId)?.needsRebuild) void retireLiveQuery(piSessionId, "the session needs a rebuild");
	} : null;
	queryCtx.endLiveTurn = endLiveTurn;
	if (live) liveQueries.set(piSessionId, live);
	bindTurnAbort(options?.signal);

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);
			forgetLive();

			// Discarded out from under: the query continuing the turn owns the context,
			// the session and the stream. Capturing this one's session id here would put
			// Claude Code back on the conversation it was discarded for.
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query completed, leaving session and stream to its replacement");
				return;
			}

			// --- Abort detection in normal completion path ---
			if (wasAborted || queryCtx.turnSignal?.aborted) {
				// The killed subprocess may flush a late record into this session's
				// JSONL — its own mirror's next sync must rebuild and rotate.
				// Felan: a late abort must not mark a reopened session's replacement mirror.
				const state = clearedSessionQueries.has(sdkQuery) ? null : sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				queryCtx.heldRateLimit = undefined;
				return;
			}

			if (replayUnansweredTurn()) return;
			// Felan: a live process exiting between turns already recorded and ended its last turn.
			if (live?.idle) debug("provider: live Claude Code process exited between turns");
			else recordCompletedTurn(capturedSessionId);

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(queryCtx.turnSignal?.aborted)}, error=`, error);
			forgetLive();
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query ended in error, leaving session and stream to its replacement");
				return;
			}
			if ((wasAborted || queryCtx.turnSignal?.aborted)) {
				// Felan: a late abort must not mark a reopened session's replacement mirror.
				const state = clearedSessionQueries.has(sdkQuery) ? null : sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
				queryCtx.heldRateLimit = undefined;
			} else if (!clearedSessionQueries.has(sdkQuery)) {
				// Felan: a late failure must not delete a reopened session's replacement mirror.
				// Drop this session's mirror: its conversation is in an unknown
				// state after the error. Other sessions' mirrors stay — one
				// session's failure says nothing about another's conversation.
				setSessionStateFor(queryCtx.piSessionId, null);
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (!wasAborted && !queryCtx.turnSignal?.aborted && replayUnansweredTurn()) return;
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = queryCtx.turnSignal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= describeClaudeCodeFailure(errorMessage(error), queryCtx.inheritedAnthropicEnvironment);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			boundSignal?.removeEventListener("abort", onAbort);
			forgetLive();
			if (endLiveTurn && queryCtx.endLiveTurn === endLiveTurn) queryCtx.endLiveTurn = null;
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			try { sdkQuery.close(); } finally {
				markExited();
				replayAfterExit?.();
			}
		});

	return stream;
}

// --- Extension registration ---

// Felan: accept the host extension API without requiring unrelated CLI flag APIs.
export function activateClaudeCodeBridge(pi: Pick<ExtensionAPI, "on" | "registerProvider">, options: { settings: ClaudeCodeSettings; agentDir: string }): void {
	setBridgeAgentDir(options.agentDir);
	providerSettings = options.settings;
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);
	if (registeredModels.length === 0) {
		console.error("claude-code: no models available from the Anthropic catalog — update @felan-ai/agent-core");
	}

	// Felan: daemon sessions (including children) have independent lifecycles.
	const clearSession = (event: string, piSessionId: string) => {
		debug(`${event}: clearing session ${piSessionId}`);
		setSessionStateFor(piSessionId, null);
		void retireLiveQuery(piSessionId, event);
		liveSessionIds.delete(piSessionId);
		historyRewrittenBySession.delete(piSessionId);
		forgetSessionCwd(piSessionId);
		sessionUIs.delete(piSessionId);
	};
	pi.on("session_start", (event, ctx) => {
		const piSessionId = ctx.sessionManager.getSessionId();
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`, piSessionId);
		}
		// Felan: synthetic Models IDs never own a session, even if supplied to a lifecycle hook.
		if (piSessionId && !piSessionId.startsWith("felan-models:")) liveSessionIds.add(piSessionId);
		sessionUIs.set(piSessionId, ctx.ui);
		rememberSessionCwd(piSessionId, ctx.cwd);
	});
	pi.on("session_before_compact", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	pi.on("session_before_tree", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/sections) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(source: string, systemPrompt: string | undefined, options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		contextFiles?: { path: string; content: string }[];
		skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
		sections?: Record<string, string>;
		selectedTools?: string[];
	} | undefined) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
			sections: options?.sections,
		}, source);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing.
	// Felan: live child sessions fail closed rather than forwarding the harness
	// verbatim; recording it here restores the match before the query.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const piSessionId = ctx.sessionManager.getSessionId();
		reportLeaks("session_shutdown", piSessionId);
		clearSession("session_shutdown", piSessionId);
		// Felan: daemon eviction shuts the session down; its Claude Code process exits with it.
		await retiringQueries.get(piSessionId);
	});
	// Felan: release the process as soon as the session moves to another model, not at its next prompt.
	pi.on("model_select", (event, ctx) => {
		const piSessionId = ctx.sessionManager.getSessionId();
		const live = liveQueries.get(piSessionId);
		if (live && (event.model.provider !== PROVIDER_ID || event.model.id !== live.config.model)) {
			void retireLiveQuery(piSessionId, `model changed to ${event.model.provider}/${event.model.id}`);
		}
	});

	// Pi and summary extensions own compaction and branch summaries; native calls use the
	// isolated provider path. Observe the completed rewrite below, not its owner.

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), `session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", (_event, ctx) => sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"));

	// Felan: every session has its own registry, but all use this shared stream function.
	const providerConfig = {
		baseUrl: "claude-code",
		apiKey: "not-used",
		api: "claude-code",
		models: registeredModels,
		// Cast: the Provider interface passes a TranscriptContext; the bridge takes plain
		// Context models (toBridgeContext normalizes at the stream entry points).
		streamSimple: streamClaudeAgentSdk as any,
	};
	pi.registerProvider(PROVIDER_ID, providerConfig);
}
