import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, type Api, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../extension/catalog.js";
import type { SubagentState } from "../extension/crew.js";
import { SubagentSessionRunner } from "../extension/subagent-session.js";

const DYNAMIC_PROVIDER = "pi-crew-dynamic-test";
const DYNAMIC_MODEL = "offline-model";
const RUNTIME_KEY = "runtime-test-key";

describe("SubagentSessionRunner SDK bootstrap", () => {
	it("runs a child prompt with a dynamic extension provider and runtime credential", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-crew-sdk-"));
		const cwd = join(root, "repo");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		const faux = createFauxCore({ provider: DYNAMIC_PROVIDER, models: [{ id: DYNAMIC_MODEL }] });
		faux.setResponses([fauxAssistantMessage("child prompt succeeded")]);
		const receivedKeys: Array<string | undefined> = [];
		let networkRequested = false;
		let refreshCalls = 0;

		const ownerRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		ownerRuntime.registerProvider(DYNAMIC_PROVIDER, {
			baseUrl: "https://offline.invalid",
			api: faux.api as Api,
			streamSimple: (model, context, options?: SimpleStreamOptions) => {
				receivedKeys.push(options?.apiKey);
				return faux.streamSimple(model as never, context, options);
			},
			refreshModels: async ({ allowNetwork }) => {
				refreshCalls++;
				networkRequested ||= allowNetwork;
				return [{
					id: DYNAMIC_MODEL,
					name: "Offline dynamic model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16_000,
					maxTokens: 1_000,
				}];
			},
		});
		await ownerRuntime.setRuntimeApiKey(DYNAMIC_PROVIDER, RUNTIME_KEY);
		await ownerRuntime.refresh({ allowNetwork: false });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const ownerRefreshCalls = refreshCalls;

		const agentConfig: AgentConfig = {
			name: "sdk-test",
			description: "SDK bootstrap test",
			systemPrompt: "Reply using the configured provider.",
			filePath: join(agentDir, "agents", "sdk-test.md"),
			model: `${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL}`,
			parsedModel: { provider: DYNAMIC_PROVIDER, modelId: DYNAMIC_MODEL },
			tools: [],
			compaction: false,
		};
		const state: SubagentState = {
			id: "sdk-test-1",
			agentConfig,
			task: "Run the test response",
			brief: "SDK bootstrap",
			status: "running",
			ownerSessionId: "owner-test",
			session: null,
			turns: 0,
			contextTokens: 0,
			model: undefined,
		};

		let settle!: (value: { status: string; result?: string; error?: string }) => void;
		const settled = new Promise<{ status: string; result?: string; error?: string }>((resolve) => {
			settle = resolve;
		});
		const ownerRegistry = new ModelRegistry(ownerRuntime);
		const runner = new SubagentSessionRunner({
			isCurrent: (candidate) => candidate === state,
			onProgress: () => {},
			onSettled: (_state, status, outcome) => settle({ status, ...outcome }),
		});
		t.after(async () => {
			state.session?.dispose();
			await rm(root, { recursive: true, force: true });
		});

		runner.start(state, {
			cwd,
			ctx: {
				model: undefined,
				modelRegistry: ownerRegistry,
				agentDir,
			},
			extensionResolvedPath: join(root, "pi-crew", "extension"),
		});

		let timeout: NodeJS.Timeout | undefined;
		const outcome = await Promise.race([
			settled,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("subagent prompt timed out")), 5_000);
			}),
		]).finally(() => clearTimeout(timeout));

		assert.deepEqual(outcome, { status: "done", result: "child prompt succeeded" });
		assert.deepEqual(receivedKeys, [RUNTIME_KEY]);
		assert.equal(networkRequested, false);
		assert.equal(refreshCalls, ownerRefreshCalls);
		assert.equal(state.model, DYNAMIC_MODEL);
		assert.ok(state.session?.sessionFile?.startsWith(join(agentDir, "sessions")));
	});
});
