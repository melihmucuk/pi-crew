import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type Api,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }, { id: "tool-1" })),
			fauxAssistantMessage("child prompt succeeded"),
		]);
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
		await ownerRuntime.setRuntimeApiKey(DYNAMIC_PROVIDER, RUNTIME_KEY, { allowNetwork: false });
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
			tools: ["ls"],
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
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: undefined,
			thinking: undefined,
			toolCallCount: 0,
			toolActivities: [],
		};

		let settle!: (value: { status: string; result?: string; error?: string }) => void;
		const settled = new Promise<{ status: string; result?: string; error?: string }>((resolve) => {
			settle = resolve;
		});
		const ownerRegistry = new ModelRegistry(ownerRuntime);
		const toolEvents: string[] = [];
		const runner = new SubagentSessionRunner({
			isCurrent: (candidate) => candidate === state,
			onProgress: () => {},
			onToolStart: (_state, tool) => toolEvents.push(`start:${tool.id}:${tool.name}:${tool.target}`),
			onToolEnd: (_state, toolCallId, isError) => toolEvents.push(`end:${toolCallId}:${String(isError)}`),
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
		assert.deepEqual(receivedKeys, [RUNTIME_KEY, RUNTIME_KEY]);
		assert.deepEqual(toolEvents, ["start:tool-1:ls:.", "end:tool-1:false"]);
		assert.equal(networkRequested, false);
		assert.equal(refreshCalls, ownerRefreshCalls);
		assert.equal(state.model, DYNAMIC_MODEL);
		assert.equal(state.thinking, "off");
		const stats = state.session?.getSessionStats();
		assert.equal(state.inputTokens, stats?.tokens.input);
		assert.equal(state.outputTokens, stats?.tokens.output);
		assert.equal(state.cost, stats?.cost);
		assert.ok(state.session?.sessionFile?.startsWith(join(agentDir, "sessions")));
	});

	it("runs a child prompt with a native extension provider", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-crew-native-sdk-"));
		const cwd = join(root, "repo");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		const providerId = "pi-crew-native-test";
		const modelId = "native-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
		faux.setResponses([fauxAssistantMessage("native child prompt succeeded")]);
		const refreshNetworkValues: boolean[] = [];
		const receivedKeys: Array<string | undefined> = [];
		const provider: Provider = {
			id: providerId,
			name: "Native test provider",
			auth: {
				apiKey: {
					name: "Native test API key",
					resolve: async ({ credential }) => credential?.key
						? { auth: { apiKey: credential.key } }
						: undefined,
				},
			},
			getModels: () => faux.models,
			refreshModels: async ({ allowNetwork }) => {
				refreshNetworkValues.push(allowNetwork);
			},
			stream: faux.stream,
			streamSimple: (model, context, options) => {
				receivedKeys.push(options?.apiKey);
				return faux.streamSimple(model, context, options);
			},
		};

		const ownerRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const ownerRegistry = new ModelRegistry(ownerRuntime);
		ownerRegistry.registerProvider(provider);
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY, { allowNetwork: false });
		await new Promise<void>((resolve) => setImmediate(resolve));
		refreshNetworkValues.length = 0;

		const agentConfig: AgentConfig = {
			name: "native-sdk-test",
			description: "Native SDK bootstrap test",
			systemPrompt: "Reply using the native provider.",
			filePath: join(agentDir, "agents", "native-sdk-test.md"),
			model: `${providerId}/${modelId}`,
			parsedModel: { provider: providerId, modelId },
			tools: [],
			compaction: false,
		};
		const state: SubagentState = {
			id: "native-sdk-test-1",
			agentConfig,
			task: "Run the native test response",
			brief: "Native SDK bootstrap",
			status: "running",
			ownerSessionId: "owner-native-test",
			session: null,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: undefined,
			thinking: undefined,
			toolCallCount: 0,
			toolActivities: [],
		};

		let settle!: (value: { status: string; result?: string; error?: string }) => void;
		const settled = new Promise<{ status: string; result?: string; error?: string }>((resolve) => {
			settle = resolve;
		});
		const runner = new SubagentSessionRunner({
			isCurrent: (candidate) => candidate === state,
			onProgress: () => {},
			onToolStart: () => {},
			onToolEnd: () => {},
			onSettled: (_state, status, outcome) => settle({ status, ...outcome }),
		});
		t.after(async () => {
			state.session?.dispose();
			await rm(root, { recursive: true, force: true });
		});

		runner.start(state, {
			cwd,
			ctx: { model: undefined, modelRegistry: ownerRegistry, agentDir },
			extensionResolvedPath: join(root, "pi-crew", "extension"),
		});

		let timeout: NodeJS.Timeout | undefined;
		const outcome = await Promise.race([
			settled,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("native subagent prompt timed out")), 5_000);
			}),
		]).finally(() => clearTimeout(timeout));

		assert.deepEqual(outcome, { status: "done", result: "native child prompt succeeded" });
		assert.equal(faux.state.callCount, 1);
		assert.deepEqual(receivedKeys, [RUNTIME_KEY]);
		assert.ok(refreshNetworkValues.length > 0);
		assert.ok(refreshNetworkValues.every((allowNetwork) => !allowNetwork));
		assert.equal(state.model, modelId);
		assert.equal(state.thinking, "off");
	});
});
