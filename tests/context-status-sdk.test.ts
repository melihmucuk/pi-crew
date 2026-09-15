import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type Api, type Message } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerPiCrewExtension } from "../extension/index.js";
import type { CrewRuntime } from "../extension/crew.js";

// SDK persistence can assign a different timestamp; it is not sent in the provider request.
function withoutTimestamps(messages: Message[]) {
	return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

it("delivers persisted status and reminders during a real SDK run without duplicates or prefix changes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "crew-status-sdk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false,
	});
	const faux = createFauxCore({ provider: "crew-status-test", models: [{ id: "offline" }] });
	faux.setResponses([
		...Array.from({ length: 12 }, (_, index) => fauxAssistantMessage(fauxToolCall("step", {}, { id: `step-${index}` }))),
		fauxAssistantMessage("finished"),
		fauxAssistantMessage("next run"),
		fauxAssistantMessage("after compaction"),
	]);
	const requests: Message[][] = [];
	modelRuntime.registerProvider("crew-status-test", {
		baseUrl: "https://offline.invalid", api: faux.api as Api, models: faux.models,
		streamSimple: (model, context, options) => {
			requests.push(structuredClone(context.messages));
			return faux.streamSimple(model as never, context, options);
		},
	});
	await modelRuntime.setRuntimeApiKey("crew-status-test", "offline-test");
	let waiting = false;
	const crew = {
		getActiveSummariesForOwner: () => waiting ? [{ id: "worker", status: "completed" }] : [],
		activateSession() {},
		deactivateSession() {},
		abortAll() {},
	} as unknown as CrewRuntime;
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => registerPiCrewExtension(pi, {
			crew,
			env: {},
			processHooks: { on() {} },
			processHooksSetupKey: Symbol("crew-status-sdk-test"),
		})],
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({
		cwd: root, agentDir: root, resourceLoader: loader, settingsManager, sessionManager, modelRuntime,
		model: faux.models[0], tools: ["step"], customTools: [{
			name: "step", label: "step", description: "Offline step", parameters: Type.Object({}),
			async execute() {
				waiting = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		}],
	});
	t.after(() => session.dispose());
	await session.prompt("Run the offline steps for @crew:worker, then finish.");
	const crewEntries = () => sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("crew-"));
	const count = (request: Message[], type: string) => request.filter((message) => JSON.stringify(message.content).includes(type)).length;
	assert.equal(requests.length, 13, "status delivery must not trigger extra model calls");
	assert.ok(JSON.stringify(requests[0]).includes('<pi-crew subagent=\\"worker\\" />'), "mention expansion shares the production context hook");
	assert.equal(crewEntries().length, 2, "one snapshot and one reminder, not one snapshot per call");
	assert.equal(count(requests[0], "crew_status"), 0);
	assert.equal(count(requests[1], "crew_status"), 1, "turn-end snapshot reaches the next model call");
	assert.equal(count(requests[10], "crew_reminder"), 0);
	assert.equal(count(requests[11], "crew_reminder"), 1, "reminder arrives after ten calls since snapshot");
	for (let index = 1; index < requests.length; index++) {
		assert.deepEqual(withoutTimestamps(requests[index].slice(0, requests[index - 1].length)), withoutTimestamps(requests[index - 1]), "previous request prefix stays intact");
	}
	await session.prompt("Continue without tools.");
	assert.equal(crewEntries().length, 2);
	assert.equal(count(requests[13], "crew_status"), 1, "SDK-provided status is not duplicated on the next run");
	assert.equal(count(requests[13], "crew_reminder"), 1);
	assert.deepEqual(withoutTimestamps(requests[13].slice(0, requests[12].length)), withoutTimestamps(requests[12]));

	const keptId = sessionManager.appendMessage({ role: "user", content: "retained after compaction", timestamp: Date.now() });
	sessionManager.appendCompaction("Earlier work summarized", keptId, 1000);
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
	await session.prompt("Continue after compaction.");
	assert.equal(count(requests[14], "crew_status"), 1, "only a fresh snapshot survives compaction");
	assert.equal(count(requests[14], "crew_reminder"), 0, "compacted reminders are not resurrected");
});
