import {
	createExtensionServiceAccess, createFelanServiceRegistry, createUnavailableExtensionUi,
	SESSIONS_HISTORY_SERVICE, type SessionsHistory,
	type ExtensionContext, type ExtensionUi, type FelanExtensionAPI, type SessionEntry,
	type UiActionRequest, type UiDocument, type UiElementHandle, type UiInteractiveElement,
	type UiPresentOptions, type UiValues, type UiView,
} from "@felan-ai/agent-core";
import { parseUiPresentation } from "@felan-ai/session-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/extension.js";
import type { PromptHistoryHost, PromptHistorySession } from "../src/contracts.js";
import { splitPromptHistoryText } from "../src/text.js";

const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	const errors: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try { await cleanup(); } catch (error) { errors.push(error); }
	}
	if (errors.length) throw new AggregateError(errors, "History fixture cleanup failed.");
});

function deferred<T>(fallback: T) {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	releases.push(() => resolve(fallback));
	return { promise, resolve };
}

function entry(id: string, content: unknown, day = 1): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
		message: { role: "user", content } } as unknown as SessionEntry;
}

function fixture(entries: SessionEntry[] = [entry("live", "live prompt")]) {
	let currentEntries = entries;
	const listSessions = vi.fn<PromptHistoryHost["listSessions"]>(async () => []);
	const readSession = vi.fn<PromptHistoryHost["readSession"]>(async () => undefined);
	const registry = createFelanServiceRegistry();
	const directories = new Map<string, string>();
	const references = new Map<string, Awaited<ReturnType<PromptHistoryHost["listSessions"]>>[number]>();
	registry.set(SESSIONS_HISTORY_SERVICE, {
		current: { id: "current", root: "current" },
		list: async () => ({ items: (await listSessions("/sessions")).map(reference => {
			references.set(reference.id, reference);
			return { id: reference.id, root: reference.id, title: reference.label, cwd: directories.get(reference.id) ?? "/project", updatedAt: reference.timestamp, state: "open" as const };
		}) }),
		checkpoint: async (id: string) => ({ sessionId: id, revision: `revision-${id}`, branch: null, leafId: null, byteLength: 1024 * 1024, transcriptDigest: "digest" }),
		history: async (id: string) => ({ sessionId: id, revision: `revision-${id}`, branch: null, entries: (await readSession(references.get(id)!))?.entries ?? [] }),
	} satisfies SessionsHistory);
	const legacyShow = vi.fn(async () => { throw new Error("Legacy presenter must not be used."); });
	const history: UiInteractiveElement[] = [];
	const rows = new Map<string, { element: UiInteractiveElement; options: UiPresentOptions; lifetime: AbortController; handle: UiElementHandle; closed: boolean }>();
	const present = vi.fn<ExtensionUi["present"]>(async (element, options = {}) => {
		parseUiPresentation(element);
		expect(rows.get(element.id)?.closed ?? true).toBe(true);
		const row = {
			element, options, lifetime: new AbortController(), closed: false,
			handle: {
				update: vi.fn<UiElementHandle["update"]>(async update => {
					expect(row.closed).toBe(false);
					expect(update.id).toBe(row.element.id);
					expect(update.kind).toBe(row.element.kind);
					expect(update.revision).toBeGreaterThan(row.element.revision);
					parseUiPresentation(update);
					row.element = structuredClone(update); history.push(row.element);
				}),
				close: vi.fn<UiElementHandle["close"]>(async () => { row.closed = true; row.lifetime.abort(); }),
			},
		};
		rows.set(element.id, row); history.push(structuredClone(element));
		return row.handle;
	});
	const handlers = new Map<string, () => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sendUserMessage = vi.fn();
	const pi = {
		config: { displayMode: "overlay" }, ui: { ...createUnavailableExtensionUi(), present },
		services: createExtensionServiceAccess(registry, extension.serviceRequirements!), sendUserMessage,
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		registerShortcut: vi.fn(), on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
	} as unknown as FelanExtensionAPI;
	extension(pi);
	const context = {
		cwd: "/project", get mode() { throw new Error("No mode gating."); }, get hasUI() { throw new Error("No hasUI gating."); },
		get ui() { throw new Error("No native editor or dialog access."); },
		sessionManager: {
			getSessionDir: () => "/sessions", getSessionFile: () => "/sessions/current.jsonl", getSessionId: () => "current",
			getCwd: () => "/project", getSessionName: () => "Live", getEntries: () => currentEntries,
		},
	} as unknown as ExtensionContext;
	const shutdown = () => handlers.get("session_shutdown")!();
	cleanups.push(shutdown);
	function view(): UiView {
		const result = [...rows.values()].find(row => row.element.kind === "view")?.element;
		if (!result || result.kind !== "view") throw new Error("Missing history view.");
		return result;
	}
	function document(): UiDocument {
		const result = [...rows.values()].find(row => row.element.kind === "document" && !row.closed)?.element;
		if (!result || result.kind !== "document") throw new Error("Missing prompt document.");
		return result;
	}
	function invoke(element: UiInteractiveElement, actionId: string, extra: Partial<UiActionRequest> = {}) {
		const row = rows.get(element.id)!;
		const action = element.actions.find(action => action.id === actionId);
		return row.options.onAction!({ elementId: element.id, revision: element.revision, actionId,
			outcome: action?.outcome ?? "submit", values: {}, ...extra }, {
			requestId: "action", signal: AbortSignal.any([row.lifetime.signal, ...(row.options.signal ? [row.options.signal] : [])]),
		});
	}
	const search = (scope: string, query = "") => invoke(view(), "search", { values: { scope, query } });
	const settled = () => vi.waitFor(() => expect(view().actions.some(action => action.id === "cancel-search")).toBe(false));
	return { rows, history, present, listSessions, readSession, directories, legacyShow, sendUserMessage, view, document, invoke, search, settled, shutdown,
		open: () => commands.get("prompt-history")!.handler("", context), setEntries: (value: SessionEntry[]) => { currentEntries = value; } };
}

describe("generic prompt history", () => {
	it("uses live session text, newest-first deduplication, and explicit controls without native UI", async () => {
		const f = fixture([entry("old", "same"), entry("new", "same", 2), entry("parts", [
			{ type: "text", text: "hello " }, { type: "image", data: "ignored" }, { type: "text", text: "world" },
		], 3)]);
		await f.open(); await f.settled();
		expect(f.view().items.map(item => item.values.preview)).toEqual(["hello world", "same"]);
		expect(f.view().query).toEqual({ actionId: "search", values: { query: "", scope: "session" } });
		expect(f.view().actions.map(action => action.id)).toEqual(["search", "detail", "close"]);
		expect(f.view().hint).toEqual({ id: "felan.prompt-history", version: "1" });
		expect(f.listSessions).not.toHaveBeenCalled();
		expect(f.legacyShow).not.toHaveBeenCalled();
		f.setEntries([entry("fresh", "fresh prompt", 4)]);
		await f.search("session"); await f.settled();
		expect(f.view().items[0]?.values.preview).toBe("fresh prompt");
		expect(f.sendUserMessage).not.toHaveBeenCalled();
	});

	it("preserves project/all scope filtering and fuzzy search through the data service", async () => {
		const f = fixture();
		const references = [3, 2, 1].map(timestamp => ({ id: `opaque-${timestamp}`, label: `session-${timestamp}`, timestamp }));
		f.directories.set("opaque-2", "/other");
		f.listSessions.mockResolvedValue(references);
		f.readSession.mockImplementation(async reference => ({ cwd: reference.timestamp === 2 ? "/other" : "/project",
			entries: [entry(reference.id, reference.timestamp === 2 ? "needle other" : "needle same", reference.timestamp)] }));
		await f.open(); await f.settled();
		await f.search("project"); await f.settled();
		expect(f.view().items.map(item => item.values.preview)).toEqual(["needle same"]);
		expect(f.view().items[0]?.values.session).toBe("session-3");
		await f.search("all"); await f.settled();
		expect(f.view().items.map(item => item.values.preview)).toEqual(["needle same", "needle other"]);
		await f.search("all", "ndl oth"); await f.settled();
		expect(f.view().items.map(item => item.values.preview)).toEqual(["needle other"]);
		expect(f.listSessions).toHaveBeenCalledWith("/sessions");
		expect(f.readSession).toHaveBeenCalledWith(references[0]);
	});

	it("publishes four-session scan progress and stops at the existing 50-result bound", async () => {
		const f = fixture();
		const references = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, label: `s${index}`, timestamp: 9 - index }));
		const firstBatch = deferred<PromptHistorySession | undefined>({ cwd: "/project", entries: [] });
		f.listSessions.mockResolvedValue(references);
		f.readSession.mockImplementation(reference => Number(reference.id.slice(1)) < 4 ? firstBatch.promise
			: Promise.resolve({ cwd: "/project", entries: [entry(reference.id, reference.id)] }));
		await f.open(); await f.settled(); await f.search("all");
		await vi.waitFor(() => expect(f.readSession).toHaveBeenCalledTimes(4));
		expect(f.view().title).toContain("searching");
		firstBatch.resolve({ cwd: "/project", entries: [] });
		await f.settled();
		expect(f.history.some(value => value.kind === "view" && value.title.includes("searching 4/9"))).toBe(true);
		expect(f.history.some(value => value.kind === "view" && value.title.includes("searching 8/9"))).toBe(true);
		expect(f.readSession).toHaveBeenCalledTimes(9);
		f.readSession.mockClear();
		f.readSession.mockImplementation(async reference => ({ cwd: "/project", entries: Array.from({ length: 20 }, (_, index) => entry(`${reference.id}-${index}`, `${reference.id} prompt ${index}`)) }));
		await f.search("all"); await f.settled();
		expect(f.view().items).toHaveLength(50);
		expect(f.view().title).toContain("partial (4/9");
		expect(f.readSession).toHaveBeenCalledTimes(4);
	});

	it("cancels a scan after its in-flight batch and fences results from superseded queries", async () => {
		const f = fixture();
		f.listSessions.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, label: "saved", timestamp: index })));
		const old = deferred<PromptHistorySession | undefined>({ cwd: "/project", entries: [entry("old", "stale result")] });
		f.readSession.mockImplementation(() => old.promise);
		await f.open(); await f.settled(); await f.search("all");
		await vi.waitFor(() => expect(f.readSession).toHaveBeenCalledTimes(4));
		await f.invoke(f.view(), "cancel-search");
		expect(f.view().title).toContain("partial");
		await f.search("session"); await f.settled();
		old.resolve({ cwd: "/project", entries: [entry("old", "stale result")] });
		await f.shutdown();
		expect(f.view().items.map(item => item.values.preview)).toEqual(["live prompt"]);
		expect(f.readSession).toHaveBeenCalledTimes(4);
	});

	it("shows every full-prompt page without inserting or submitting it", async () => {
		const text = `first\n${"Z".repeat(60_000)}\n<script>[unsafe](file:///x)</script>\nlast`;
		const f = fixture([entry("long", text)]);
		await f.open(); await f.settled();
		expect(f.view().items[0]?.values.clipped).toBe(true);
		await f.invoke(f.view(), "detail", { itemId: f.view().items[0]!.id });
		const pages = splitPromptHistoryText(text).chunks.length;
		const documentId = f.document().id;
		let output = f.document().markdown;
		for (let index = 1; index < pages; index++) {
			const previous = f.document();
			await f.invoke(previous, "next");
			expect(f.document().id).toBe(documentId);
			expect(f.document().revision).toBeGreaterThan(previous.revision);
			output += f.document().markdown;
		}
		expect(output.match(/Z/gu)).toHaveLength(60_000);
		expect(output).toContain("first"); expect(output).toContain("last");
		expect(output).toContain("&lt;script&gt;\\[unsafe\\]\\(file:///x\\)&lt;/script&gt;");
		expect(f.document().actions.some(action => action.id === "next")).toBe(false);
		expect(f.view().items[0]!.id).toContain(f.view().id);
		expect(f.document().data).toEqual({ itemId: f.view().items[0]!.id, pageIndex: pages - 1, pageCount: pages });
		expect(f.document().actions.some(action => action.id === "use")).toBe(false);
		await f.invoke(f.document(), "previous");
		await f.invoke(f.document(), "back");
		expect(f.rows.get(documentId)?.closed).toBe(true);
		await f.search("session"); await f.settled();
		expect(f.sendUserMessage).not.toHaveBeenCalled();
		expect(f.history.every(element => !element.actions.some(action => ["insert", "submit", "run"].includes(action.id)))).toBe(true);
	});

	it("rejects stale, foreign, malformed, and undeclared actions before searching", async () => {
		const f = fixture();
		await f.open(); await f.settled();
		const old = f.view();
		await f.search("session"); await f.settled();
		const badValues: UiValues[] = [{}, { query: 5, scope: "all" }, { query: "", scope: "unknown" }, { query: "🙂".repeat(1025), scope: "all" }, { query: "", scope: "all", extra: true }];
		for (const values of badValues) await expect(f.invoke(f.view(), "search", { values })).rejects.toThrow();
		await expect(f.invoke(old, "search", { values: { query: "", scope: "all" } })).rejects.toThrow();
		await expect(f.invoke(f.view(), "detail", { itemId: "foreign" })).rejects.toThrow();
		await expect(f.invoke(f.view(), "detail", { itemId: f.view().items[0]!.id, elementId: "foreign" })).rejects.toThrow();
		await expect(f.invoke(f.view(), "insert")).rejects.toThrow();
		expect(f.listSessions).not.toHaveBeenCalled();
		const current = f.view();
		await f.invoke(current, "close");
		await expect(f.invoke(current, "detail", { itemId: f.view().items[0]!.id })).rejects.toThrow("closed");
		await f.shutdown();
		expect(f.rows.get(current.id)?.handle.close).toHaveBeenCalledOnce();
	});

	it("rechecks a queued action against the revision produced by the preceding query", async () => {
		const f = fixture();
		await f.open(); await f.settled();
		const old = f.view();
		const update = vi.mocked(f.rows.get(old.id)!.handle.update);
		const original = update.getMockImplementation()!;
		const waiting = deferred<void>(undefined);
		update.mockClear();
		update.mockImplementationOnce(async value => { await waiting.promise; await original(value); });
		const first = f.invoke(old, "search", { values: { scope: "session", query: "live" } });
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
		const second = f.invoke(old, "search", { values: { scope: "all", query: "" } });
		const rejected = expect(second).rejects.toThrow();
		waiting.resolve();
		await first; await rejected; await f.settled();
		expect(f.listSessions).not.toHaveBeenCalled();
	});

	it("joins shutdown scans before closing handles, without publishing late progress", async () => {
		const f = fixture();
		f.listSessions.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, label: "saved", timestamp: index })));
		const read = deferred<PromptHistorySession | undefined>(undefined);
		f.readSession.mockImplementation(() => read.promise);
		await f.open(); await f.settled(); await f.search("all");
		await vi.waitFor(() => expect(f.readSession).toHaveBeenCalledTimes(4));
		const count = f.history.length;
		let done = false;
		const shutdown = f.shutdown().then(() => { done = true; });
		await Promise.resolve();
		expect(done).toBe(false);
		expect(f.rows.get(f.view().id)?.handle.close).not.toHaveBeenCalled();
		read.resolve({ cwd: "/project", entries: [entry("late", "late result")] });
		await shutdown;
		expect(f.history).toHaveLength(count);
		expect(f.readSession).toHaveBeenCalledTimes(4);
		expect(f.rows.get(f.view().id)?.handle.close).toHaveBeenCalledOnce();
	});

	it("joins a late initial handle and retains cleanup failures", async () => {
		const f = fixture();
		const implementation = f.present.getMockImplementation()!;
		const waiting = deferred<void>(undefined);
		f.present.mockImplementationOnce(async (...args) => { await waiting.promise; return implementation(...args); });
		const opening = f.open();
		const rejected = expect(opening).rejects.toThrow();
		await vi.waitFor(() => expect(f.present).toHaveBeenCalledOnce());
		const shutdown = f.shutdown();
		waiting.resolve();
		await rejected; await shutdown;
		expect(f.rows.get(f.view().id)?.handle.close).toHaveBeenCalledOnce();

		const failing = fixture();
		await failing.open(); await failing.settled();
		vi.mocked(failing.rows.get(failing.view().id)!.handle.close).mockRejectedValue(new Error("close failed"));
		await expect(failing.shutdown()).rejects.toThrow("Prompt history cleanup failed");
		await expect(failing.shutdown()).rejects.toThrow("Prompt history cleanup failed");
		cleanups.pop();
	});
});
