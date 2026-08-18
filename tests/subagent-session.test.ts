import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import type { CrewTask } from "../extension/task.js";

const DYNAMIC_PROVIDER = "pi-crew-dynamic-test";
const DYNAMIC_MODEL = "offline-model";
const RUNTIME_KEY = "runtime-test-key";
const TYPEBOX_MODULE_URL = pathToFileURL(createRequire(import.meta.url).resolve("typebox")).href;

function task(instruction: string): CrewTask {
	return {
		goal: "Complete the SDK bootstrap test.",
		context: [],
		instructions: [instruction],
	};
}

function createState(id: string, agentConfig: AgentConfig): SubagentState {
	return {
		id,
		agentConfig,
		task: task("Run the bootstrap test"),
		toolFailureCount: 0,
		activeToolCallIds: new Set(),
		startedAt: 0,
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
}

describe("SubagentSessionRunner SDK bootstrap", () => {
	it("runs a child prompt with a dynamic extension provider, runtime credential, and custom tool", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-crew-sdk-"));
		const cwd = join(root, "repo");
		const agentDir = join(root, "agent");
		const extensionsDir = join(agentDir, "extensions");
		await Promise.all([mkdir(cwd), mkdir(extensionsDir, { recursive: true })]);
		await writeFile(join(extensionsDir, "custom-tools.ts"), `
import { Type } from ${JSON.stringify(TYPEBOX_MODULE_URL)};

export default function (pi) {
	pi.registerTool({
		name: "custom_echo",
		label: "Custom Echo",
		description: "Echo a message from the child session",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: \`[child] \${params.message}\` }], details: {} };
		},
	});
}
`);

		const faux = createFauxCore({ provider: DYNAMIC_PROVIDER, models: [{ id: DYNAMIC_MODEL }] });
		let receivedPrompt = "";
		let receivedToolResult = "";
		faux.setResponses([
			(context) => {
				const message = context.messages.at(-1);
				if (message?.role === "user") {
					receivedPrompt = typeof message.content === "string"
						? message.content
						: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				}
				return fauxAssistantMessage(fauxToolCall("custom_echo", { message: "from child" }, { id: "tool-1" }));
			},
			(context) => {
				const message = context.messages.at(-1);
				if (message?.role === "toolResult") {
					receivedToolResult = message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
				}
				return fauxAssistantMessage("child prompt succeeded");
			},
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
			tools: ["custom_echo"],
			compaction: false,
		};
		const state: SubagentState = {
			id: "sdk-test-1",
			toolFailureCount: 0,
			activeToolCallIds: new Set(),
			startedAt: 0,
			agentConfig,
			task: task("Run the test response"),
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
		assert.match(receivedPrompt, /## Goal\n\nComplete the SDK bootstrap test\./);
		assert.match(receivedPrompt, /## Context\n\nNone\./);
		assert.match(receivedPrompt, /## Instructions\n\n1\. Run the test response/);
		assert.equal(receivedToolResult, "[child] from child");
		assert.deepEqual(receivedKeys, [RUNTIME_KEY, RUNTIME_KEY]);
		assert.deepEqual(toolEvents, ["start:tool-1:custom_echo:from child", "end:tool-1:false"]);
		assert.equal(networkRequested, false);
		assert.equal(refreshCalls, ownerRefreshCalls);
		assert.equal(state.model, `${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL}`);
		assert.equal(state.thinking, "off");
		const stats = state.session?.getSessionStats();
		assert.equal(state.inputTokens, stats?.tokens.input);
		assert.equal(state.outputTokens, stats?.tokens.output);
		assert.equal(state.cost, stats?.cost);
		assert.ok(state.session?.sessionFile?.startsWith(join(agentDir, "sessions")));
	});

	it("fails before prompting when an explicit model is unavailable and inherits only when omitted", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-crew-strict-model-"));
		const cwd = join(root, "repo");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		const providerId = "pi-crew-strict-model-test";
		const ownerModelId = "owner-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: ownerModelId }] });
		const ownerRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		ownerRuntime.registerProvider(providerId, {
			baseUrl: "https://offline.invalid",
			api: faux.api as Api,
			models: faux.models,
			streamSimple: faux.streamSimple,
		});
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
		const ownerRegistry = new ModelRegistry(ownerRuntime);
		const ownerModel = ownerRegistry.find(providerId, ownerModelId);
		assert.ok(ownerModel);

		const states: SubagentState[] = [];
		t.after(async () => {
			for (const state of states) state.session?.dispose();
			await rm(root, { recursive: true, force: true });
		});

		const makeState = (id: string, agentConfig: AgentConfig): SubagentState => {
			const state: SubagentState = {
				id,
				agentConfig,
				task: task("Run the strict model test"),
				brief: "Strict model selection",
				status: "running",
				ownerSessionId: "owner-strict-model",
				toolFailureCount: 0,
				activeToolCallIds: new Set(),
				startedAt: 0,
				session: null,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				model: undefined,
				thinking: undefined,
				toolCallCount: 0,
				toolActivities: [],
			};
			states.push(state);
			return state;
		};

		const run = async (state: SubagentState) => {
			const warnings: string[] = [];
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
			runner.start(state, {
				cwd,
				ctx: { model: ownerModel, modelRegistry: ownerRegistry, agentDir },
				extensionResolvedPath: join(root, "pi-crew", "extension"),
				onWarning: (warning) => warnings.push(warning),
			});

			let timeout: NodeJS.Timeout | undefined;
			const outcome = await Promise.race([
				settled,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("strict model test timed out")), 5_000);
				}),
			]).finally(() => clearTimeout(timeout));
			return { outcome, warnings };
		};

		const unavailableState = makeState("strict-model-missing", {
			name: "strict-model",
			description: "Strict model selection test",
			systemPrompt: "Use only the configured model.",
			filePath: join(agentDir, "agents", "strict-model.md"),
			model: `${providerId}/missing-model`,
			parsedModel: { provider: providerId, modelId: "missing-model" },
			tools: [],
			compaction: false,
		});
		const unavailable = await run(unavailableState);

		assert.deepEqual(unavailable.outcome, {
			status: "error",
			error: `Configured model "${providerId}/missing-model" is not available; subagent was not started`,
		});
		assert.deepEqual(unavailable.warnings, []);
		assert.equal(faux.state.callCount, 0);
		assert.equal(unavailableState.session, null);

		faux.setResponses([fauxAssistantMessage("owner model inherited")]);
		const inheritedState = makeState("strict-model-inherited", {
			name: "inherited-model",
			description: "Owner model inheritance test",
			systemPrompt: "Use the owner model.",
			filePath: join(agentDir, "agents", "inherited-model.md"),
			tools: [],
			compaction: false,
		});
		const inherited = await run(inheritedState);

		assert.deepEqual(inherited.outcome, { status: "done", result: "owner model inherited" });
		assert.equal(faux.state.callCount, 1);
		assert.equal(inheritedState.model, `${providerId}/${ownerModelId}`);
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
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
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
			toolFailureCount: 0,
			activeToolCallIds: new Set(),
			startedAt: 0,
			agentConfig,
			task: task("Run the native test response"),
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
		assert.equal(state.model, `${providerId}/${modelId}`);
		assert.equal(state.thinking, "off");
	});

	it("surfaces child credential synchronization failures without retrying the mutation", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-crew-credential-sync-"));
		const cwd = join(root, "repo");
		const agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		const providerId = "pi-crew-sync-failure-test";
		const modelId = "sync-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
		let failRefresh = false;
		let failedRefreshes = 0;
		const provider: Provider = {
			id: providerId,
			name: "Credential sync failure provider",
			auth: {
				apiKey: {
					name: "Credential sync test API key",
					resolve: async ({ credential }) => credential?.key
						? { auth: { apiKey: credential.key } }
						: undefined,
				},
			},
			getModels: () => faux.models,
			refreshModels: async () => {
				if (!failRefresh) return;
				failedRefreshes++;
				throw new Error("native catalog unavailable");
			},
			stream: faux.stream,
			streamSimple: faux.streamSimple,
		};

		const ownerRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const ownerRegistry = new ModelRegistry(ownerRuntime);
		ownerRegistry.registerProvider(provider);
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
		await new Promise<void>((resolve) => setImmediate(resolve));
		failRefresh = true;

		const agentConfig: AgentConfig = {
			name: "sync-failure-test",
			description: "Credential synchronization failure test",
			systemPrompt: "Do not run when credential synchronization fails.",
			filePath: join(agentDir, "agents", "sync-failure-test.md"),
			model: `${providerId}/${modelId}`,
			parsedModel: { provider: providerId, modelId },
			tools: [],
			compaction: false,
		};
		const state = createState("sync-failure-test-1", agentConfig);
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
		const outcome = await settled;

		assert.deepEqual(outcome, {
			status: "error",
			error: `Authentication transfer for provider "${providerId}" was committed, but child runtime synchronization failed: native catalog unavailable`,
		});
		assert.ok(failedRefreshes > 0);
		assert.equal(faux.state.callCount, 0);
		assert.equal(state.session, null);
	});

	it("aborts credential and model bootstrap work before a child session exists", async () => {
		const agentConfig: AgentConfig = {
			name: "bootstrap-abort-test",
			description: "Bootstrap cancellation test",
			systemPrompt: "Do not prompt after cancellation.",
			filePath: "/agents/bootstrap-abort-test.md",
			tools: [],
			compaction: false,
		};
		const state = createState("bootstrap-abort-test-1", agentConfig);
		const settled: string[] = [];
		let bootstrapSignal: AbortSignal | undefined;
		let markBootstrapStarted!: () => void;
		const bootstrapStarted = new Promise<void>((resolve) => {
			markBootstrapStarted = resolve;
		});
		const runner = new SubagentSessionRunner(
			{
				isCurrent: (candidate) => candidate === state,
				onProgress: () => {},
				onToolStart: () => {},
				onToolEnd: () => {},
				onSettled: (_state, status) => settled.push(status),
			},
			{
				bootstrap: async ({ signal }) => {
					bootstrapSignal = signal;
					markBootstrapStarted();
					return await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			},
		);

		runner.start(state, {
			cwd: "/repo",
			ctx: { model: undefined, modelRegistry: {} as never, agentDir: "/agent" },
			extensionResolvedPath: "/pkg/extension",
		});
		await bootstrapStarted;
		runner.abort(state);
		state.status = "aborted";
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(bootstrapSignal?.aborted, true);
		assert.equal(state.session, null);
		assert.deepEqual(settled, []);
	});
});
