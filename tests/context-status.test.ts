import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewRuntime } from "../extension/crew.js";
import { createCrewContextStatus } from "../extension/context-status.js";
import type { SubagentStatus } from "../extension/subagent-status.js";

function setup() {
	const active = new Map<string, Array<{ id: string; status: SubagentStatus }>>();
	const controller = createCrewContextStatus({
		getActiveSummariesForOwner: (id: string) => active.get(id) ?? [],
	} as CrewRuntime);
	function owner(id: string) {
		const messages: AgentMessage[] = [];
		const ctx = { sessionManager: {
			getSessionId: () => id,
			buildSessionProjection: () => ({ messages }),
		} } as unknown as ExtensionContext;
		function append(message: ReturnType<typeof controller.end>) {
			if (message) messages.push({ ...message, role: "custom", timestamp: messages.length } as AgentMessage);
			return message;
		}
		return {
			messages, ctx,
			start: () => append(controller.beforeStart(ctx)),
			call: () => {
				controller.observe(ctx);
				messages.push({ role: "user", content: "next", timestamp: messages.length });
				return append(controller.end(ctx));
			},
		};
	}
	return { active, owner };
}

it("appends owner-only snapshots at safe boundaries, coalesces changes, and clears once", () => {
	const { active, owner } = setup();
	const a = owner("a");
	const b = owner("b");
	assert.equal(a.start(), undefined);
	active.set("a", [{ id: "worker", status: "running" }]);
	assert.equal(b.start(), undefined);
	assert.equal(JSON.parse(a.start()!.content as string).agents[0].status, "running");
	const prefix = JSON.stringify(a.messages);
	assert.equal(a.call(), undefined);
	assert.equal(JSON.stringify(a.messages.slice(0, 1)), prefix);
	active.set("a", [{ id: "worker", status: "completed" }, { id: "scout", status: "needs_input" }]);
	const snapshot = a.call()!;
	assert.equal(snapshot.customType, "crew-status");
	assert.deepEqual(JSON.parse(snapshot.content as string).agents, [
		{ id: "scout", status: "needs_input" }, { id: "worker", status: "completed" },
	]);
	active.set("a", []);
	assert.deepEqual(JSON.parse(a.call()!.content as string).agents, []);
	assert.equal(a.call(), undefined);
	assert.equal(a.start(), undefined);
});

it("reminds every ten model calls only for awaiting-owner sessions and resets on snapshots", () => {
	const { active, owner } = setup();
	const a = owner("a");
	active.set("a", [{ id: "worker", status: "completed" }, { id: "runner", status: "running" }]);
	a.start();
	for (let round = 0; round < 2; round++) {
		for (let i = 0; i < 9; i++) assert.equal(a.call(), undefined);
		const reminder = a.call()!;
		assert.equal(reminder.customType, "crew-reminder");
		assert.deepEqual(JSON.parse(reminder.content as string).agents, [{ id: "worker", status: "completed" }]);
	}
	for (let i = 0; i < 9; i++) a.call();
	active.set("a", [{ id: "worker", status: "needs_input" }]);
	assert.equal(a.call()!.customType, "crew-status");
	for (let i = 0; i < 9; i++) assert.equal(a.call(), undefined);
	assert.equal(a.call()!.customType, "crew-reminder");
	active.set("a", [{ id: "worker", status: "running" }]);
	a.call();
	for (let i = 0; i < 20; i++) assert.equal(a.call(), undefined);
});

it("honors context edits without restoring omitted messages or deduplicating against old content", () => {
	const sessionManager = SessionManager.inMemory();
	const running = JSON.stringify({ type: "crew_status", agents: [{ id: "worker", status: "running" }] });
	const completed = JSON.stringify({ type: "crew_status", agents: [{ id: "worker", status: "completed" }] });
	const snapshotId = sessionManager.appendCustomMessageEntry("crew-status", running, false, { crewContextId: "snapshot" });
	const reminderId = sessionManager.appendCustomMessageEntry("crew-reminder", "old reminder", false, { crewContextId: "reminder" });
	sessionManager.appendContextEdit(snapshotId, { content: completed });
	sessionManager.appendContextEdit(reminderId, null);
	const controller = createCrewContextStatus({
		getActiveSummariesForOwner: () => [{ id: "worker", status: "completed" }],
	} as unknown as CrewRuntime);
	const ctx = { sessionManager } as unknown as ExtensionContext;
	const messages = sessionManager.buildSessionProjection().messages;
	controller.observe(ctx);
	assert.equal(messages.length, 1);
	assert.ok(messages[0].role === "custom");
	assert.equal(messages[0].content, completed);
	assert.equal(controller.beforeStart(ctx), undefined, "deduplication uses the edited snapshot");

	sessionManager.appendContextEdit(snapshotId, null);
	const omitted = sessionManager.buildSessionProjection().messages;
	controller.observe(ctx);
	assert.deepEqual(omitted, []);
	assert.equal(controller.beforeStart(ctx)?.content, completed, "open work receives a fresh snapshot, not the omitted one");
});

it("restores a lost snapshot after compaction without rewriting retained context", () => {
	const { active, owner } = setup();
	const a = owner("a");
	active.set("a", [{ id: "worker", status: "completed" }]);
	a.start();
	a.messages.splice(0);
	a.messages.push({ role: "user", content: "compacted context", timestamp: 1 });
	const prefix = JSON.stringify(a.messages);
	assert.equal(a.call()!.customType, "crew-status");
	assert.equal(JSON.stringify(a.messages.slice(0, 1)), prefix);
	assert.equal(a.start(), undefined);
	a.messages.splice(0);
	assert.equal(a.start()!.customType, "crew-status");
});
