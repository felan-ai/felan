#!/usr/bin/env node

/**
 * Felan gives every session its own registry, including subagent children.
 * Each activation registers immediately; session events never re-register it.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

const PROVIDER_ID = "claude-code";

const { activateClaudeCodeBridge: activate } = await import("../../src/bridge/index.ts");

function activateWithMockPi() {
	const handlers = new Map();
	const registered = [];
	activate({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => registered.push({ name, config }),
		registerTool: () => {},
	}, { settings: {}, agentDir: process.env.PI_CODING_AGENT_DIR });
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	return { handlers, registered, emit };
}

const sessionCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "test-session" } };

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

describe("provider registration across session activations", () => {
	it("first session registers at activation", () => {
		const { registered } = activateWithMockPi();
		assert.equal(registered.length, 1, "exactly one activation-time registration");
		assert.equal(registered[0].name, PROVIDER_ID);
	});

	it("later session registers at activation when its registry lacks the provider", () => {
		const first = activateWithMockPi();
		const { registered, emit } = activateWithMockPi();
		assert.equal(registered.length, 1, "later activations also register immediately");

		emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith("other-provider") });
		assert.equal(registered.length, 1, "session_start does not re-register");
		assert.equal(registered[0].name, PROVIDER_ID);
		assert.equal(registered[0].config.streamSimple, first.registered[0].config.streamSimple, "sessions share the module's stream fn");
	});

	it("later session registers immediately even when the registry already has the provider", () => {
		activateWithMockPi();
		const { registered, emit } = activateWithMockPi();

		// Host passed the parent's registry down: the provider is already there.
		emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 1, "activation registers into its own registry");

		// Repeated session starts stay idempotent.
		emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 1, "still no registration on a later session_start");
	});
});
