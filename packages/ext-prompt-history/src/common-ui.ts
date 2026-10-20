import { PROMPT_HISTORY_HINT } from './data.js';
import {
	uuidv7, type ExtensionUi, type UiActionContext, type UiActionRequest,
	type UiDocument, type UiElementHandle, type UiView,
} from "@felan-ai/agent-core";
import { parseUiPresentation, validateUiAction } from "@felan-ai/session-protocol";
import { PROMPT_HISTORY_SCOPES, type PromptHistoryScope, type PromptHistorySearch, type PromptHistorySearchState } from "./contracts.js";
import { MAX_PROMPT_HISTORY_RESULTS } from "./history.js";
import { splitPromptHistoryText } from "./text.js";


export function createCommonPromptHistory(ui: ExtensionUi) {
	let active: HistoryView | undefined;
	let opening: Promise<void> | undefined;
	let disposed = false;
	return {
		async show(search: PromptHistorySearch, signal: AbortSignal): Promise<void> {
			if (disposed) throw new Error("Prompt history presentation is disposed.");
			if (opening || active && !active.closed) throw new Error("Prompt history is already open.");
			opening = (async () => {
				await active?.dispose();
				if (disposed) throw new Error("Prompt history presentation is disposed.");
				active = new HistoryView(ui, search, signal);
				await active.open();
			})();
			try { await opening; } finally { opening = undefined; }
		},
		async dispose(): Promise<void> {
			disposed = true;
			const cleanup = active?.dispose();
			await Promise.allSettled([opening, cleanup]);
			await cleanup;
		},
	};
}

class HistoryView {
	closed = false;
	private readonly id = `prompt-history-${uuidv7()}`;
	private readonly textId = `${this.id}-text`;
	private scope: PromptHistoryScope = "session";
	private query = "";
	private generation = 0;
	private revision = 0;
	private state: PromptHistorySearchState = { items: [], loading: true, scanned: 0, complete: false };
	private chunks: string[] = [];
	private bytes = 0;
	private page = 0;
	private selectedItemId = "";
	private view: UiView | undefined;
	private document: UiDocument | undefined;
	private viewHandle: UiElementHandle | undefined;
	private textHandle: UiElementHandle | undefined;
	private opening: Promise<void> = Promise.resolve();
	private queue: Promise<void> = Promise.resolve();
	private readonly workers = new Set<Promise<void>>();
	private readonly failures: unknown[] = [];
	private cleanup: Promise<void> | undefined;
	private readonly abort = () => this.close();

	constructor(private readonly ui: ExtensionUi, private readonly search: PromptHistorySearch, private readonly signal: AbortSignal) {
		signal.addEventListener("abort", this.abort, { once: true });
	}

	async open(): Promise<void> {
		this.opening = (async () => {
			await this.publishView();
			this.assertOpen();
			this.startSearch();
		})();
		this.queue = this.opening.catch(() => {});
		try { await this.opening; } catch (error) { await this.dispose(); throw error; }
	}

	private assertOpen(context?: UiActionContext): void {
		if (this.closed) throw new Error("Prompt history is closed.");
		this.signal.throwIfAborted();
		context?.signal.throwIfAborted();
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const task = this.queue.then(operation);
		this.queue = task.catch(() => {});
		return task;
	}

	private close(): void {
		if (!this.closed) { this.closed = true; this.generation++; }
		this.signal.removeEventListener("abort", this.abort);
		void this.dispose().catch(() => {});
	}

	dispose(): Promise<void> {
		if (!this.closed) { this.closed = true; this.generation++; }
		this.signal.removeEventListener("abort", this.abort);
		this.cleanup ??= (async () => {
			await Promise.allSettled([this.opening, ...this.workers]);
			await this.queue;
			const results = await Promise.allSettled([
				Promise.resolve().then(() => this.viewHandle?.close()), Promise.resolve().then(() => this.textHandle?.close()),
			]);
			const errors = [...this.failures, ...results.filter(result => result.status === "rejected").map(result => result.reason)];
			if (errors.length) throw new AggregateError(errors, "Prompt history cleanup failed.");
		})();
		return this.cleanup;
	}

	private fail(error: unknown): void {
		if (this.closed) return;
		this.failures.push(error);
		this.close();
	}

	private startSearch(): void {
		const generation = ++this.generation;
		const current = () => !this.closed && !this.signal.aborted && this.generation === generation;
		const publish = (state: PromptHistorySearchState) => this.enqueue(async () => {
			if (!current()) return;
			this.state = state;
			await this.publishView();
		});
		const scope = this.scope;
		const query = this.query;
		const worker = Promise.resolve().then(async () => {
			if (!current()) return;
			let latest: PromptHistorySearchState | undefined;
			const result = await this.search(scope, query, state => {
				latest = state;
				void publish(state).catch(error => this.fail(error));
			}, current);
			if (result !== latest) await publish(result);
		}).catch(error => this.fail(error));
		this.workers.add(worker);
		void worker.then(() => this.workers.delete(worker));
	}

	private dispatch = (request: UiActionRequest, context: UiActionContext): Promise<void> => this.enqueue(async () => {
		this.assertOpen(context);
		const source = request.elementId === this.id ? this.view : request.elementId === this.textId ? this.document : undefined;
		if (!source) throw new Error("Unknown prompt history element.");
		const action = validateUiAction(source, request);
		if (action.actionId === "close") { this.close(); return; }
		if (action.actionId === "search") {
			this.generation++;
			this.scope = action.values.scope as PromptHistoryScope;
			this.query = action.values.query as string;
			this.state = { items: [], loading: true, scanned: 0, complete: false };
			await this.publishView(context);
			this.assertOpen(context);
			await this.closeText();
			this.assertOpen(context);
			this.startSearch();
		} else if (action.actionId === "cancel-search") {
			this.generation++;
			this.state = { ...this.state, loading: false, complete: false };
			await this.publishView(context);
		} else if (action.actionId === "detail") {
			const index = this.view!.items.findIndex(item => item.id === action.itemId);
			const item = this.state.items[index];
			if (!item) throw new Error("Prompt history item is unavailable.");
			const text = splitPromptHistoryText(item.text);
			this.selectedItemId = action.itemId!;
			this.chunks = text.chunks; this.bytes = text.bytes; this.page = 0;
			await this.publishText(context);
		} else if (action.actionId === "back") {
			await this.publishView(context);
			await this.closeText();
		} else {
			this.page += action.actionId === "previous" ? -1 : 1;
			await this.publishText(context);
		}
	});

	private async closeText(): Promise<void> {
		this.document = undefined;
		if (this.textHandle) { await this.textHandle.close(); this.textHandle = undefined; }
	}

	private async publishView(context?: UiActionContext): Promise<void> {
		this.assertOpen(context);
		if (this.state.items.length > MAX_PROMPT_HISTORY_RESULTS) throw new Error("Prompt history exceeds its 50-result bound.");
		const progress = this.state.loading ? `searching ${this.state.scanned}/${this.state.total ?? "?"} sessions`
			: this.state.complete ? "complete" : `partial (${this.state.scanned}/${this.state.total ?? "?"} sessions scanned)`;
		const view: UiView = {
			id: this.id, kind: "view", hint: PROMPT_HISTORY_HINT, revision: ++this.revision,
			title: `Prompt history — ${this.scope} — ${this.state.items.length} results — ${progress}`,
			fallback: `Prompt history: ${this.state.items.length} results. Search or read a prompt; no prompt will be submitted.`,
			fields: [{ id: "preview", label: "Prompt preview", valueKind: "text" }, { id: "clipped", label: "Preview clipped", valueKind: "boolean" },
				{ id: "project", label: "Project", valueKind: "text" }, { id: "session", label: "Session", valueKind: "text" },
				{ id: "timestamp", label: "Time (epoch ms)", valueKind: "number" }],
			items: this.state.items.map((item, index) => {
				const preview = clip(item.text, 512);
				return { id: `${this.id}:item-${index}`, values: { preview: displayText(preview), clipped: preview !== item.text,
					project: displayText(clip(item.cwd, 128)), session: displayText(clip(item.sessionName ?? item.sessionLabel, 128)), timestamp: item.timestamp },
				fallback: `Prompt result ${index + 1}; select to read its full text.` };
			}),
			query: { actionId: "search", values: { query: this.query, scope: this.scope } },
			actions: [{ id: "search", label: "Search history", target: "element", outcome: "submit", input: { fields: [
				{ id: "query", kind: "string", label: "Fuzzy search", required: true, maxLength: 4096 },
				{ id: "scope", kind: "enum", label: "History scope", required: true, options: PROMPT_HISTORY_SCOPES.map(id => ({ id, label: id })) },
			] } }, { id: "detail", label: "Read full prompt", target: "item", outcome: "submit" },
			...(this.state.loading ? [{ id: "cancel-search", label: "Stop search", target: "element" as const, outcome: "cancel" as const }] : []),
			{ id: "close", label: "Close history", target: "element", outcome: "cancel" }],
		};
		parseUiPresentation(view);
		this.view = view;
		try {
			if (this.viewHandle) await this.viewHandle.update(view);
			else this.viewHandle = await this.ui.present(view, { signal: this.signal, onAction: this.dispatch });
			this.assertOpen(context);
		} catch (error) { this.fail(error); throw error; }
	}

	private async publishText(context: UiActionContext): Promise<void> {
		this.assertOpen(context);
		const document: UiDocument = {
			id: this.textId, kind: "document", hint: PROMPT_HISTORY_HINT, revision: ++this.revision,
			title: `Full prompt — page ${this.page + 1} of ${this.chunks.length}`,
			fallback: `Full prompt, ${this.bytes} UTF-8 bytes, page ${this.page + 1} of ${this.chunks.length}. No prompt is submitted.`,
			markdown: markdownText(this.chunks[this.page]!) || "(empty prompt)",
			data: { itemId: this.selectedItemId, pageIndex: this.page, pageCount: this.chunks.length },
			actions: [
				...(this.page > 0 ? [{ id: "previous", label: "Previous text", target: "element" as const, outcome: "submit" as const }] : []),
				...(this.page + 1 < this.chunks.length ? [{ id: "next", label: "Next text", target: "element" as const, outcome: "submit" as const }] : []),
				{ id: "back", label: "Back to results", target: "element", outcome: "submit" },
				{ id: "close", label: "Close history", target: "element", outcome: "cancel" },
			],
		};
		parseUiPresentation(document);
		this.document = document;
		try {
			if (this.textHandle) await this.textHandle.update(document);
			else this.textHandle = await this.ui.present(document, { signal: this.signal, onAction: this.dispatch });
			this.assertOpen(context);
		} catch (error) { this.fail(error); throw error; }
	}
}

function clip(value: string, maximum: number): string {
	let result = ""; let bytes = 0;
	const encoder = new TextEncoder();
	for (const character of value) {
		bytes += encoder.encode(character).length;
		if (bytes > maximum) break;
		result += character;
	}
	return result;
}

function displayText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function markdownText(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => `&#x${character.charCodeAt(0).toString(16)};`)
		.replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, "\\$&");
}

export { PROMPT_HISTORY_HINT } from './data.js';
