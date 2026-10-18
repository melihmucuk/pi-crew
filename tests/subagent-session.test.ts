import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	createFauxCore,
	fauxAssistantMessage,
	getCurrentTools,
	fauxToolCall,
	type Api,
	type Context,
	type FauxResponseStep,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../extension/catalog.js";
import type { SubagentState } from "../extension/crew.js";
import { createCrewReportTool, CREW_REPORT_REMINDER, CREW_REPORT_TOOL_NAME } from "../extension/subagent-result.js";
import type { SubagentSettlement } from "../extension/subagent-status.js";
import {
	createSubagentSettingsManager,
	SubagentSessionRunner,
	type SubagentRunnerCallbacks,
	type SubagentUsage,
} from "../extension/subagent-session.js";
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

function createState(id: string, agentConfig: AgentConfig, overrides: Partial<SubagentState> = {}): SubagentState {
	return {
		id,
		agentConfig,
		task: task("Run the bootstrap test"),
		toolFailureCount: 0,
		activeToolCallIds: new Set(),
		workedMs: 0,
		runningSince: undefined,
		brief: "SDK bootstrap",
		lifecycle: { status: "running" },
		ownerSessionId: "owner-test",
		sessionFile: undefined,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		model: undefined,
		modelName: undefined,
		thinking: undefined,
		toolCallCount: 0,
		toolActivities: [],
		...overrides,
	};
}

/** Mirrors how `CrewRuntime` applies runner callbacks onto the owned state. */
function stateCallbacks(opts: {
	onToolStart?: SubagentRunnerCallbacks["onToolStart"];
	onToolEnd?: SubagentRunnerCallbacks["onToolEnd"];
	onUsage?: (state: SubagentState, usage: SubagentUsage) => void;
	onSettled: SubagentRunnerCallbacks["onSettled"];
}): SubagentRunnerCallbacks {
	return {
		onSessionAttached: (state, info) => {
			state.sessionFile = info.sessionFile;
			state.model = info.model;
			state.modelName = info.modelName;
			state.thinking = info.thinking;
		},
		onUsage: (state, usage) => {
			state.inputTokens = usage.inputTokens;
			state.outputTokens = usage.outputTokens;
			state.cost = usage.cost;
			if (usage.model !== undefined) state.model = usage.model;
			opts.onUsage?.(state, usage);
		},
		onToolStart: opts.onToolStart ?? (() => {}),
		onToolEnd: opts.onToolEnd ?? (() => {}),
		onSettled: opts.onSettled,
	};
}

type Settlement = SubagentSettlement;

type SdkFixture = Awaited<ReturnType<typeof createSdkFixture>>;

/**
 * Temp root with `repo`/`agent` dirs plus an offline owner runtime and registry.
 * Registered cleanups run before the root is removed.
 */
async function createSdkFixture(t: TestContext, prefix: string) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const ownerRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const ownerRegistry = new ModelRegistry(ownerRuntime);
	const cleanups: Array<() => void> = [];
	t.after(async () => {
		for (const cleanup of cleanups) cleanup();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	return { root, cwd, agentDir, ownerRuntime, ownerRegistry, cleanups };
}

/** Starts a fresh runner for one state and resolves with its single settlement. */
function runToSettlement(
	fixture: SdkFixture,
	state: SubagentState,
	opts: {
		model?: Model<Api>;
		projectTrusted?: boolean;
		onWarning?: (warning: string) => void;
		onToolStart?: SubagentRunnerCallbacks["onToolStart"];
		onToolEnd?: SubagentRunnerCallbacks["onToolEnd"];
		onUsage?: (state: SubagentState, usage: SubagentUsage) => void;
	} = {},
): Promise<Settlement> {
	let settle!: (value: Settlement) => void;
	const settled = new Promise<Settlement>((resolve) => {
		settle = resolve;
	});
	const runner = new SubagentSessionRunner(stateCallbacks({
		onToolStart: opts.onToolStart,
		onToolEnd: opts.onToolEnd,
		onUsage: opts.onUsage,
		onSettled: (_state, settlement) => settle(settlement),
	}));
	fixture.cleanups.push(() => runner.dispose(state));

	runner.start(state, {
		cwd: fixture.cwd,
		ctx: {
			model: opts.model,
			modelRegistry: fixture.ownerRegistry,
			agentDir: fixture.agentDir,
			projectTrusted: opts.projectTrusted ?? true,
		},
		extensionResolvedPath: join(fixture.root, "pi-crew", "extension"),
		onWarning: opts.onWarning,
	});

	let timeout: NodeJS.Timeout | undefined;
	return Promise.race([
		settled,
		new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error(`subagent "${state.id}" prompt timed out`)), 5_000);
		}),
	]).finally(() => clearTimeout(timeout));
}

/** Agent definition with the fields these SDK tests never vary. */
function agentConfigFor(agentDir: string, name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} test`,
		systemPrompt: "Reply using the configured provider.",
		filePath: join(agentDir, "agents", `${name}.md`),
		tools: [],
		compaction: false,
		...overrides,
	};
}

/** Extension-registered provider backed by a faux core, authenticated by a plain API key. */
function nativeFauxProvider(
	providerId: string,
	faux: ReturnType<typeof createFauxCore>,
	overrides: Partial<Provider>,
): Provider {
	return {
		id: providerId,
		name: `${providerId} provider`,
		auth: {
			apiKey: {
				name: `${providerId} API key`,
				resolve: async ({ credential }) => credential?.key
					? { auth: { apiKey: credential.key } }
					: undefined,
			},
		},
		getModels: () => faux.models,
		stream: (model, context) => faux.stream(model, context),
		streamSimple: faux.streamSimple,
		...overrides,
	};
}

/** Starts a runner whose bootstrap is stubbed, so no path or registry is ever touched. */
function startWithStubBootstrap(runner: SubagentSessionRunner, state: SubagentState): void {
	runner.start(state, {
		cwd: "/repo",
		ctx: { model: undefined, modelRegistry: {} as never, agentDir: "/agent", projectTrusted: true },
		extensionResolvedPath: "/pkg/extension",
	});
}

let protocolHarnessId = 0;

async function createProtocolHarness(
	t: TestContext,
	responses: FauxResponseStep[],
	opts: { tools?: string[]; queueAfterFirstReport?: boolean } = {},
) {
	const { root, cwd, agentDir, ownerRuntime, ownerRegistry, cleanups } = await createSdkFixture(t, "pi-crew-result-protocol-");
	await writeFile(join(cwd, "fixture.txt"), "fixture contents\n");
	if (opts.queueAfterFirstReport) {
		const extensionsDir = join(agentDir, "extensions");
		await mkdir(extensionsDir);
		await writeFile(join(extensionsDir, "queue-after-report.ts"), `
export default function (pi) {
	let queued = false;
	pi.on("agent_end", (event) => {
		const finalMessage = event.messages.at(-1);
		if (queued || finalMessage?.role !== "toolResult" || finalMessage.toolName !== "${CREW_REPORT_TOOL_NAME}") return;
		queued = true;
		pi.sendMessage({
			customType: "queue-after-report",
			content: "Run one more continuation after the report.",
			display: false,
		}, { deliverAs: "followUp", triggerTurn: true });
	});
}
`);
	}

	const id = ++protocolHarnessId;
	const providerId = `pi-crew-result-protocol-${id}`;
	const modelId = "protocol-model";
	const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
	faux.setResponses(responses);
	const contexts: Context[] = [];
	ownerRuntime.registerProvider(providerId, {
		baseUrl: "https://offline.invalid",
		api: faux.api as Api,
		models: faux.models,
		streamSimple: (model, context, options?: SimpleStreamOptions) => {
			contexts.push(context);
			return faux.streamSimple(model as never, context, options);
		},
	});
	await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
	const agentConfig = agentConfigFor(agentDir, `result-protocol-${id}`, {
		model: `${providerId}/${modelId}`,
		parsedModel: { provider: providerId, modelId },
		tools: opts.tools ?? [],
	});
	const state = createState(`result-protocol-${id}`, agentConfig);
	const settlements: Settlement[] = [];
	const settlementWaiters: Array<(settlement: Settlement) => void> = [];
	const runner = new SubagentSessionRunner(stateCallbacks({
		onSettled: (_state, settlement) => {
			state.lifecycle = settlement;
			settlements.push(settlement);
			settlementWaiters.shift()?.(settlement);
		},
	}));
	const nextSettlement = () => new Promise<Settlement>((resolve) => settlementWaiters.push(resolve));
	const start = () => {
		const settled = nextSettlement();
		runner.start(state, {
			cwd,
			ctx: { model: undefined, modelRegistry: ownerRegistry, agentDir, projectTrusted: true },
			extensionResolvedPath: join(root, "pi-crew", "extension"),
		});
		return settled;
	};
	const respond = (message: string) => {
		state.lifecycle = { status: "running" };
		const settled = nextSettlement();
		runner.respond(state, message);
		return settled;
	};

	cleanups.push(() => runner.dispose(state));
	return { cwd, faux, state, contexts, settlements, runner, start, respond };
}

/** Reminders observed by the child model; every sent reminder appears in each later request context. */
function reminderCount(contexts: Context[]): number {
	let highest = 0;
	for (const context of contexts) {
		const count = context.messages.filter((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === CREW_REPORT_REMINDER;
			return message.content.some((part) => part.type === "text" && part.text === CREW_REPORT_REMINDER);
		}).length;
		if (count > highest) highest = count;
	}
	return highest;
}

function completedReport(report: string, id: string) {
	return fauxAssistantMessage(fauxToolCall(CREW_REPORT_TOOL_NAME, { outcome: "completed", report }, { id }));
}

describe("SubagentSessionRunner SDK bootstrap", () => {
	it("runs a child prompt with a dynamic extension provider, runtime credential, and custom tool", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-sdk-");
		const { agentDir, ownerRuntime } = fixture;
		const extensionsDir = join(agentDir, "extensions");
		await mkdir(extensionsDir);
		await writeFile(join(extensionsDir, "custom-tools.ts"), `
import { Type } from ${JSON.stringify(TYPEBOX_MODULE_URL)};

export default function (pi) {
	let started = false;
	pi.on("session_start", () => { started = true; });
	pi.registerTool({
		name: "custom_echo",
		label: "Custom Echo",
		description: "Echo a message from the child session",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: \`[child] \${started ? params.message : "session_start missing"}\` }], details: {} };
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
				return completedReport("child prompt succeeded", "report-1");
			},
		]);
		const receivedKeys: Array<string | undefined> = [];
		let networkRequested = false;
		let refreshCalls = 0;

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

		const agentConfig = agentConfigFor(agentDir, "sdk-test", {
			model: `${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL}`,
			parsedModel: { provider: DYNAMIC_PROVIDER, modelId: DYNAMIC_MODEL },
			tools: ["custom_echo"],
		});
		const state = createState("sdk-test-1", agentConfig, { task: task("Run the test response") });

		const toolEvents: string[] = [];
		const usages: SubagentUsage[] = [];
		const outcome = await runToSettlement(fixture, state, {
			onToolStart: (_state, tool) => toolEvents.push(`start:${tool.id}:${tool.name}:${tool.target}`),
			onToolEnd: (_state, toolCallId, isError) => toolEvents.push(`end:${toolCallId}:${String(isError)}`),
			onUsage: (_state, usage) => usages.push(usage),
		});

		assert.deepEqual(outcome, {
			status: "completed",
			result: { outcome: "completed", report: "child prompt succeeded" },
		});
		assert.match(receivedPrompt, /## Goal\n\nComplete the SDK bootstrap test\./);
		assert.match(receivedPrompt, /## Context\n\nNone\./);
		assert.match(receivedPrompt, /## Instructions\n\n1\. Run the test response/);
		assert.equal(receivedToolResult, "[child] from child");
		assert.deepEqual(receivedKeys, [RUNTIME_KEY, RUNTIME_KEY]);
		assert.deepEqual(toolEvents, [
			"start:tool-1:custom_echo:from child",
			"end:tool-1:false",
			"start:report-1:crew_report:completed",
			"end:report-1:false",
		]);
		assert.equal(networkRequested, false);
		assert.equal(refreshCalls, ownerRefreshCalls);
		assert.equal(state.model, `${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL}`);
		assert.equal(state.thinking, "off");
		const lastUsage = usages.at(-1);
		assert.ok(lastUsage && lastUsage.inputTokens > 0 && lastUsage.outputTokens > 0);
		assert.equal(state.inputTokens, lastUsage.inputTokens);
		assert.equal(state.outputTokens, lastUsage.outputTokens);
		assert.equal(state.cost, lastUsage.cost);
		assert.ok(state.sessionFile?.startsWith(join(agentDir, "sessions")));
	});

	it("fails before prompting when an explicit model is unavailable and inherits only when omitted", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-strict-model-");
		const { agentDir, ownerRuntime, ownerRegistry } = fixture;

		const providerId = "pi-crew-strict-model-test";
		const ownerModelId = "owner-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: ownerModelId }] });
		ownerRuntime.registerProvider(providerId, {
			baseUrl: "https://offline.invalid",
			api: faux.api as Api,
			models: faux.models,
			streamSimple: faux.streamSimple,
		});
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
		const ownerModel = ownerRegistry.find(providerId, ownerModelId);
		assert.ok(ownerModel);

		const makeState = (id: string, agentConfig: AgentConfig): SubagentState => createState(id, agentConfig, {
			task: task("Run the strict model test"),
			brief: "Strict model selection",
			ownerSessionId: "owner-strict-model",
		});

		const run = async (state: SubagentState) => {
			const warnings: string[] = [];
			const outcome = await runToSettlement(fixture, state, {
				model: ownerModel,
				onWarning: (warning) => warnings.push(warning),
			});
			return { outcome, warnings };
		};

		const unavailableState = makeState("strict-model-missing", agentConfigFor(agentDir, "strict-model", {
			model: `${providerId}/missing-model`,
			parsedModel: { provider: providerId, modelId: "missing-model" },
		}));
		const unavailable = await run(unavailableState);

		assert.deepEqual(unavailable.outcome, {
			status: "error",
			error: `Configured model "${providerId}/missing-model" is not available; subagent was not started`,
		});
		assert.deepEqual(unavailable.warnings, []);
		assert.equal(faux.state.callCount, 0);
		assert.equal(unavailableState.sessionFile, undefined);

		const invalidState = makeState("strict-model-invalid", agentConfigFor(agentDir, "invalid-model", {
			model: "invalid-model-format",
		}));
		const invalid = await run(invalidState);
		assert.deepEqual(invalid.outcome, {
			status: "error",
			error: 'Configured model "invalid-model-format" is invalid; expected "provider/model-id"',
		});
		assert.equal(faux.state.callCount, 0, "invalid configuration must not fall back to the owner model");
		assert.equal(invalidState.sessionFile, undefined);

		faux.setResponses([completedReport("owner model inherited", "inherited-report")]);
		const inheritedState = makeState("strict-model-inherited", agentConfigFor(agentDir, "inherited-model"));
		const inherited = await run(inheritedState);

		assert.deepEqual(inherited.outcome, {
			status: "completed",
			result: { outcome: "completed", report: "owner model inherited" },
		});
		assert.equal(faux.state.callCount, 1);
		assert.equal(inheritedState.model, `${providerId}/${ownerModelId}`);
	});

	it("runs a child prompt with a native extension provider", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-native-sdk-");
		const { agentDir, ownerRuntime, ownerRegistry } = fixture;

		const providerId = "pi-crew-native-test";
		const modelId = "native-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
		faux.setResponses([(context) => {
			assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name).sort(), [
				"bash", CREW_REPORT_TOOL_NAME, "edit", "find", "grep", "ls", "powershell", "read", "write",
			].sort());
			return completedReport("native child prompt succeeded", "native-report");
		}]);
		const refreshNetworkValues: boolean[] = [];
		const receivedKeys: Array<string | undefined> = [];
		const provider = nativeFauxProvider(providerId, faux, {
			refreshModels: async ({ allowNetwork }) => {
				refreshNetworkValues.push(allowNetwork);
			},
			streamSimple: (model, context, options) => {
				receivedKeys.push(options?.apiKey);
				return faux.streamSimple(model, context, options);
			},
		});

		ownerRegistry.registerProvider(provider);
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
		await new Promise<void>((resolve) => setImmediate(resolve));
		refreshNetworkValues.length = 0;

		const agentConfig = agentConfigFor(agentDir, "native-sdk-test", {
			model: `${providerId}/${modelId}`,
			parsedModel: { provider: providerId, modelId },
			tools: undefined,
		});
		const state = createState("native-sdk-test-1", agentConfig, {
			task: task("Run the native test response"),
			brief: "Native SDK bootstrap",
			ownerSessionId: "owner-native-test",
		});

		const outcome = await runToSettlement(fixture, state);

		assert.deepEqual(outcome, {
			status: "completed",
			result: { outcome: "completed", report: "native child prompt succeeded" },
		});
		assert.equal(faux.state.callCount, 1);
		assert.deepEqual(receivedKeys, [RUNTIME_KEY]);
		assert.ok(refreshNetworkValues.length > 0);
		assert.ok(refreshNetworkValues.every((allowNetwork) => !allowNetwork));
		assert.equal(state.model, `${providerId}/${modelId}`);
		assert.equal(state.thinking, "off");
	});

	it("inherits codemode settings and connects trusted MCP tools without loading untrusted project resources", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-capabilities-");
		const { root, cwd, agentDir, ownerRuntime } = fixture;
		const loaded = join(root, "extension-loaded");
		const started = join(root, "extension-started");
		const stopped = join(root, "extension-stopped");
		const serverStarted = join(root, "server-started");
		const serverStopped = join(root, "server-stopped");
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".pi", "extensions", "lifecycle.ts"), `
import { writeFileSync } from "node:fs";
export default function (pi) {
	writeFileSync(${JSON.stringify(loaded)}, "loaded");
	pi.on("session_start", () => writeFileSync(${JSON.stringify(started)}, "started"));
	pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(stopped)}, "stopped"));
}
`);
		const serverPath = join(root, "mcp-server.mjs");
		await writeFile(serverPath, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(serverStarted)}, "started");
process.stdin.on("end", () => writeFileSync(${JSON.stringify(serverStopped)}, "stopped"));
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result;
	if (request.method === "initialize") result = {
		protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
		serverInfo: { name: "crew-fixture", version: "1" },
	};
	else if (request.method === "tools/list") result = { tools: [{
		name: "echo", description: "Return the input value",
		inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
		outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
	}] };
	else if (request.method === "tools/call") result = {
		content: [{ type: "text", text: String(request.params.arguments.value) }],
		structuredContent: { value: request.params.arguments.value },
	};
	else result = {};
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({
			defaultTools: ["+codemode"], codemode: { mode: "only", inlineBudget: 100 },
		}));
		await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
			fixture: { command: process.execPath, args: [serverPath], exposure: "deferred" },
		} }));
		const faux = createFauxCore({ provider: "crew-capabilities", models: [{ id: "offline" }] });
		ownerRuntime.registerProvider("crew-capabilities", {
			baseUrl: "https://offline.invalid", api: faux.api as Api, models: faux.models, streamSimple: faux.streamSimple,
		});
		await ownerRuntime.setRuntimeApiKey("crew-capabilities", RUNTIME_KEY);
		const config = agentConfigFor(agentDir, "capabilities", { tools: undefined });
		faux.setResponses([(context) => {
			assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "codemode"));
			assert.ok(!JSON.stringify(context.messages).includes("mcp__fixture__echo"));
			return completedReport("untrusted", "untrusted-report");
		}]);
		const untrusted = await runToSettlement(fixture, createState("untrusted", config), {
			model: faux.models[0], projectTrusted: false,
		});
		assert.equal(untrusted.status, "completed");
		assert.equal(existsSync(loaded), false);
		assert.equal(existsSync(serverStarted), false);

		let nestedResult = "";
		faux.setResponses([
			(context) => {
				const names = getCurrentTools(context.messages).map((tool) => tool.name);
				assert.ok(names.includes("codemode"));
				assert.ok(names.includes("tool_search"));
				assert.ok(names.includes(CREW_REPORT_TOOL_NAME), "model-only report stays declared in codemode-only mode");
				assert.ok(!names.includes("read"), "the owner's codemode-only setting is inherited");
				return fauxAssistantMessage(fauxToolCall("codemode", {
					code: "const result = await tools.mcp__fixture__echo({ value: 42 }); text(result.structuredContent.value);",
				}, { id: "codemode-mcp" }));
			},
			(context) => {
				const result = context.messages.at(-1);
				if (result?.role === "toolResult") nestedResult = JSON.stringify(result.content);
				return completedReport("trusted MCP succeeded", "trusted-report");
			},
		]);
		const events: string[] = [];
		const trusted = await runToSettlement(fixture, createState("trusted", config), {
			model: faux.models[0], projectTrusted: true,
			onToolStart: (_state, tool) => events.push(tool.name),
		});
		assert.deepEqual(trusted, { status: "completed", result: { outcome: "completed", report: "trusted MCP succeeded" } });
		assert.match(nestedResult, /Script completed.*42/);
		assert.ok(events.includes("mcp__fixture__echo"));
		assert.equal(existsSync(loaded), true);
		assert.equal(existsSync(started), true);
		fixture.cleanups.pop()!();
		for (let attempt = 0; attempt < 100 && !existsSync(serverStopped); attempt++) await delay(20);
		assert.equal(existsSync(stopped), true, "child extensions receive shutdown before disposal");
		assert.equal(existsSync(serverStopped), true, "closing the child closes its MCP server");
	});

	it("blocks nested crew_report calls while accepting the direct final report", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-nested-report-");
		await mkdir(join(fixture.agentDir, "extensions"));
		await writeFile(join(fixture.agentDir, "extensions", "nested-report.ts"), `
import { Type } from ${JSON.stringify(TYPEBOX_MODULE_URL)};
export default function (pi) {
	pi.registerTool({
		name: "nested_report", label: "Nested Report", description: "Try a nested report", parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const result = await ctx.executeTool("crew_report", { outcome: "completed", report: "Nested" });
			return { content: result.result.content, details: { blocked: result.isError } };
		},
	});
}
`);
		const faux = createFauxCore({ provider: "crew-nested", models: [{ id: "offline" }] });
		let nestedResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("nested_report", {}, { id: "nested" })),
			(context) => {
				const result = context.messages.at(-1);
				if (result?.role === "toolResult") nestedResult = JSON.stringify(result.content);
				return completedReport("Direct report", "direct");
			},
		]);
		fixture.ownerRuntime.registerProvider("crew-nested", {
			baseUrl: "https://offline.invalid", api: faux.api as Api, models: faux.models, streamSimple: faux.streamSimple,
		});
		await fixture.ownerRuntime.setRuntimeApiKey("crew-nested", RUNTIME_KEY);
		const events: Array<{ id: string; isError: boolean }> = [];
		const outcome = await runToSettlement(fixture, createState("nested", agentConfigFor(fixture.agentDir, "nested", {
			tools: ["nested_report"],
		})), { model: faux.models[0], onToolEnd: (_state, id, isError) => events.push({ id, isError }) });
		assert.deepEqual(outcome, { status: "completed", result: { outcome: "completed", report: "Direct report" } });
		assert.match(nestedResult, /Tool crew_report not found/);
		assert.deepEqual(events, [
			{ id: "nested/1", isError: true },
			{ id: "nested", isError: false },
			{ id: "direct", isError: false },
		]);
	});

	it("inherits cache warming and trusted compaction settings while preserving agent control", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-settings-");
		const model = { provider: "settings-provider", id: "settings-model" };
		const ordinaryModel = { provider: "settings-provider", id: "ordinary-model" };
		await mkdir(join(fixture.cwd, ".pi"));
		await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({
			cacheWarming: "off",
			compaction: {
				enabled: false,
				reserveTokens: 1_000,
				keepRecentTokens: 2_000,
				modelOverrides: {
					"settings-provider/settings-model": { reserveTokens: 4_000 },
				},
			},
		}));
		await writeFile(join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({
			cacheWarming: "idle",
			compaction: {
				keepRecentTokens: 3_000,
				modelOverrides: {
					"settings-provider/settings-model": { keepRecentTokens: 5_000 },
				},
			},
		}));

		const settingsWarnings: string[] = [];
		const settings = createSubagentSettingsManager(SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true }), false, settingsWarnings);

		assert.deepEqual(settingsWarnings, []);
		assert.equal(settings.getCacheWarmingMode(), "off");
		assert.deepEqual(settings.getCompactionSettings(model), {
			enabled: false,
			reserveTokens: 4_000,
			keepRecentTokens: 5_000,
		});
		assert.deepEqual(settings.getCompactionSettings(ordinaryModel), {
			enabled: false,
			reserveTokens: 1_000,
			keepRecentTokens: 3_000,
		});
		assert.equal(
			createSubagentSettingsManager(SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: true }), true, []).getCompactionSettings(model).enabled,
			true,
		);
		assert.deepEqual(
			createSubagentSettingsManager(SettingsManager.create(fixture.cwd, fixture.agentDir, { projectTrusted: false }), false, []).getCompactionSettings(model),
			{ enabled: false, reserveTokens: 4_000, keepRecentTokens: 2_000 },
		);
	});

	it("warns when owner settings cannot be loaded", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-malformed-settings-");
		const { agentDir, ownerRuntime } = fixture;
		const providerId = "pi-crew-malformed-settings-test";
		const modelId = "malformed-settings-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
		faux.setResponses([completedReport("child prompt succeeded", "malformed-settings-report")]);
		await writeFile(join(agentDir, "settings.json"), "{");
		ownerRuntime.registerProvider(providerId, {
			baseUrl: "https://offline.invalid",
			api: faux.api as Api,
			models: faux.models,
			streamSimple: faux.streamSimple,
		});
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);

		const warnings: string[] = [];
		const outcome = await runToSettlement(fixture, createState("malformed-settings-1", agentConfigFor(agentDir, "malformed-settings", {
			model: `${providerId}/${modelId}`,
			parsedModel: { provider: providerId, modelId },
		})), { onWarning: (warning) => warnings.push(warning) });

		assert.deepEqual(outcome, {
			status: "completed",
			result: { outcome: "completed", report: "child prompt succeeded" },
		});
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0]?.startsWith(`Invalid settings file ${join(agentDir, "settings.json")}:`));
		assert.match(warnings[0] ?? "", /JSON/);
	});

	it("surfaces child credential synchronization failures without retrying the mutation", async (t) => {
		const fixture = await createSdkFixture(t, "pi-crew-credential-sync-");
		const { agentDir, ownerRuntime, ownerRegistry } = fixture;

		const providerId = "pi-crew-sync-failure-test";
		const modelId = "sync-model";
		const faux = createFauxCore({ provider: providerId, models: [{ id: modelId }] });
		let failRefresh = false;
		let failedRefreshes = 0;
		const provider = nativeFauxProvider(providerId, faux, {
			refreshModels: async () => {
				if (!failRefresh) return;
				failedRefreshes++;
				throw new Error("native catalog unavailable");
			},
		});

		ownerRegistry.registerProvider(provider);
		await ownerRuntime.setRuntimeApiKey(providerId, RUNTIME_KEY);
		await new Promise<void>((resolve) => setImmediate(resolve));
		failRefresh = true;

		const agentConfig = agentConfigFor(agentDir, "sync-failure-test", {
			model: `${providerId}/${modelId}`,
			parsedModel: { provider: providerId, modelId },
		});
		const state = createState("sync-failure-test-1", agentConfig);

		const outcome = await runToSettlement(fixture, state);

		assert.deepEqual(outcome, {
			status: "error",
			error: `Authentication transfer for provider "${providerId}" was committed, but child runtime synchronization failed: native catalog unavailable`,
		});
		assert.ok(failedRefreshes > 0);
		assert.equal(faux.state.callCount, 0);
		assert.equal(state.sessionFile, undefined);
	});

	it("aborts credential and model bootstrap work before a child session exists", async () => {
		const agentConfig = agentConfigFor("/", "bootstrap-abort-test");
		const state = createState("bootstrap-abort-test-1", agentConfig);
		const settled: string[] = [];
		let bootstrapSignal: AbortSignal | undefined;
		let markBootstrapStarted!: () => void;
		const bootstrapStarted = new Promise<void>((resolve) => {
			markBootstrapStarted = resolve;
		});
		const runner = new SubagentSessionRunner(
			stateCallbacks({ onSettled: (_state, settlement) => settled.push(settlement.status) }),
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

		startWithStubBootstrap(runner, state);
		await bootstrapStarted;
		runner.abort(state);
		state.lifecycle = { status: "aborted" };
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(bootstrapSignal?.aborted, true);
		assert.equal(state.sessionFile, undefined);
		assert.deepEqual(settled, []);
	});

	it("disposes a session that finishes bootstrapping after the subagent was disposed", async () => {
		const agentConfig = agentConfigFor("/", "stale-bootstrap-test");
		const state = createState("stale-bootstrap-test-1", agentConfig);
		const settled: string[] = [];
		let disposed = false;
		let prompted = false;
		let releaseBootstrap!: () => void;
		const bootstrapReleased = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		let markBootstrapStarted!: () => void;
		const bootstrapStarted = new Promise<void>((resolve) => {
			markBootstrapStarted = resolve;
		});
		const session = {
			extensionRunner: { emit: async () => {} },
			dispose: () => {
				disposed = true;
			},
			prompt: async () => {
				prompted = true;
			},
			subscribe: () => () => {},
			setSessionName: () => {},
			messages: [],
		};
		const runner = new SubagentSessionRunner(
			stateCallbacks({ onSettled: (_state, settlement) => settled.push(settlement.status) }),
			{
				bootstrap: async () => {
					markBootstrapStarted();
					await bootstrapReleased;
					return { session: session as never, warnings: [] };
				},
			},
		);

		startWithStubBootstrap(runner, state);
		await bootstrapStarted;
		runner.dispose(state);
		releaseBootstrap();
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(disposed, true);
		assert.equal(prompted, false);
		assert.equal(state.sessionFile, undefined);
		assert.deepEqual(settled, []);
	});

	it("settles with an error when responding without an attached session", () => {
		const agentConfig = agentConfigFor("/", "no-session-test");
		const state = createState("no-session-test-1", agentConfig);
		const settlements: SubagentSettlement[] = [];
		const runner = new SubagentSessionRunner(
			stateCallbacks({ onSettled: (_state, settlement) => settlements.push(settlement) }),
		);

		runner.respond(state, "follow up");

		assert.deepEqual(settlements, [{ status: "error", error: `Subagent "no-session-test-1" has no active session` }]);
	});

	it("settles a prompt cycle once even when the settlement callback throws", async () => {
		const agentConfig = agentConfigFor("/", "throwing-settle-test");
		const state = createState("throwing-settle-test-1", agentConfig);
		const settlements: SubagentSettlement[] = [];
		const reportCall = {
			type: "toolCall" as const,
			id: "throwing-report",
			name: CREW_REPORT_TOOL_NAME,
			arguments: { outcome: "completed", report: "Reported once" },
		};
		const session = {
			messages: [] as unknown[],
			extensionRunner: { emit: async () => {} },
			dispose: () => {},
			prompt: async function () {
				this.messages.push(
					{ role: "assistant", content: [reportCall], stopReason: "toolUse" },
					{
						role: "toolResult",
						toolCallId: reportCall.id,
						toolName: CREW_REPORT_TOOL_NAME,
						content: [{ type: "text", text: "Final subagent report recorded." }],
						isError: false,
					},
				);
			},
			subscribe: () => () => {},
			setSessionName: () => {},
		};
		const runner = new SubagentSessionRunner(
			stateCallbacks({
				onSettled: (_state, settlement) => {
					settlements.push(settlement);
					throw new Error("delivery failed");
				},
			}),
			{ bootstrap: async () => ({ session: session as never, warnings: [] }) },
		);

		startWithStubBootstrap(runner, state);
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(settlements, [{
			status: "completed",
			result: { outcome: "completed", report: "Reported once" },
		}]);
	});
});

describe("universal subagent result protocol", () => {
	it("accepts a native normalized completed report with needs null without a reminder", async (t) => {
		const harness = await createProtocolHarness(t, [
			fauxAssistantMessage(fauxToolCall(CREW_REPORT_TOOL_NAME, {
				outcome: "completed",
				report: "Normalized report",
				needs: null,
			}, { id: "normalized-null-report" })),
		]);

		assert.deepEqual(await harness.start(), {
			status: "completed",
			result: { outcome: "completed", report: "Normalized report" },
		});
		assert.equal(harness.faux.state.callCount, 1);
		assert.equal(reminderCount(harness.contexts), 0);
	});

	it("sends one reminder before settlement and recovers with a final report", async (t) => {
		let harness!: Awaited<ReturnType<typeof createProtocolHarness>>;
		const responses: FauxResponseStep[] = [
			fauxAssistantMessage("I forgot the report."),
			(context) => {
				assert.equal(harness.settlements.length, 0);
				const reminders = context.messages.filter((message) => {
					if (message.role !== "user") return false;
					if (typeof message.content === "string") return message.content === CREW_REPORT_REMINDER;
					return message.content.some((part) => part.type === "text" && part.text === CREW_REPORT_REMINDER);
				});
				assert.equal(reminders.length, 1);
				return completedReport("Recovered report", "recovery-report");
			},
		];
		harness = await createProtocolHarness(t, responses);

		assert.deepEqual(await harness.start(), {
			status: "completed",
			result: { outcome: "completed", report: "Recovered report" },
		});
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(harness.settlements.length, 1);
		assert.equal(reminderCount(harness.contexts), 1);
	});

	it("invalidates an accepted report when another extension continues the same prompt", async (t) => {
		const getUserTexts = (context: Context) => context.messages.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return message.content.filter((part) => part.type === "text").map((part) => part.text);
		});
		const harness = await createProtocolHarness(t, [
			completedReport("Report before external continuation", "pre-continuation-report"),
			fauxAssistantMessage("The terminating tool batch completed."),
			(context) => {
				assert.ok(getUserTexts(context).includes("Run one more continuation after the report."));
				return fauxAssistantMessage("The external continuation ended without a report.");
			},
			(context) => {
				assert.ok(getUserTexts(context).includes(CREW_REPORT_REMINDER));
				return completedReport("Report after external continuation", "post-continuation-report");
			},
		], { queueAfterFirstReport: true });

		assert.deepEqual(await harness.start(), {
			status: "completed",
			result: { outcome: "completed", report: "Report after external continuation" },
		});
		assert.equal(harness.faux.state.callCount, 4);
	});

	it("returns one contract error after the reminder without making a third model call", async (t) => {
		const harness = await createProtocolHarness(t, [
			fauxAssistantMessage("Missing report one."),
			fauxAssistantMessage("Missing report two."),
			completedReport("Must not run", "third-report"),
		]);

		const outcome = await harness.start();
		assert.equal(outcome.status, "error");
		assert.match(outcome.error ?? "", /contract violated.*after one reminder/);
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(harness.settlements.length, 1);
		assert.equal(reminderCount(harness.contexts), 1);
	});

	it("rejects a non-final report but accepts task tools followed by one final reporter", async (t) => {
		const harness = await createProtocolHarness(t, [
			fauxAssistantMessage([
				fauxToolCall(CREW_REPORT_TOOL_NAME, { outcome: "completed", report: "Too early" }, { id: "early-report" }),
				fauxToolCall("read", { path: "fixture.txt" }, { id: "early-read" }),
			]),
			fauxAssistantMessage("Continued after the mixed batch."),
			completedReport("Final after reminder", "final-after-mixed"),
		], { tools: ["read"] });

		assert.deepEqual(await harness.start(), {
			status: "completed",
			result: { outcome: "completed", report: "Final after reminder" },
		});
		assert.equal(harness.faux.state.callCount, 3);

		const cleanHarness = await createProtocolHarness(t, [
			fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }, { id: "task-read" })),
			completedReport("Task then final", "task-final-report"),
		], { tools: ["read"] });
		assert.deepEqual(await cleanHarness.start(), {
			status: "completed",
			result: { outcome: "completed", report: "Task then final" },
		});
		assert.equal(cleanHarness.faux.state.callCount, 2);
	});

	it("does not remind after technical error or abort", async (t) => {
		for (const stopReason of ["error", "aborted"] as const) {
			const harness = await createProtocolHarness(t, [
				fauxAssistantMessage("technical stop", {
					stopReason,
					errorMessage: stopReason === "error" ? "invalid request" : "cancelled",
				}),
				completedReport("Must not run", `${stopReason}-unexpected-report`),
			]);
			const outcome = await harness.start();
			assert.equal(outcome.status, stopReason);
			assert.equal(outcome.error, stopReason === "error" ? "invalid request" : "cancelled");
			assert.equal(harness.faux.state.callCount, 1);
			assert.equal(reminderCount(harness.contexts), 0);
		}
	});

	it("does not carry an old report into respond cycles and renews the reminder once per respond", async (t) => {
		const harness = await createProtocolHarness(t, [
			completedReport("Initial report", "initial-report"),
			fauxAssistantMessage("First respond forgot."),
			completedReport("First respond recovered", "first-respond-report"),
			fauxAssistantMessage("Second respond forgot."),
			completedReport("Second respond recovered", "second-respond-report"),
		]);

		assert.deepEqual((await harness.start()).result, { outcome: "completed", report: "Initial report" });
		assert.deepEqual((await harness.respond("First follow-up")).result, {
			outcome: "completed",
			report: "First respond recovered",
		});
		assert.deepEqual((await harness.respond("Second follow-up")).result, {
			outcome: "completed",
			report: "Second respond recovered",
		});
		assert.equal(harness.faux.state.callCount, 5);
		assert.equal(reminderCount(harness.contexts), 2);
	});

	it("acknowledges a report as JSON without changing its validated result or termination", async () => {
		const tool = createCrewReportTool();
		const report = { outcome: "completed", report: "## Findings\n\nVerified." };
		const result = await tool.execute("report-json", report, undefined, undefined, {} as never);
		assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {});
		assert.deepEqual(result.details, report);
		assert.equal(result.terminate, true);
		const component = tool.renderResult!(result, { expanded: false, isPartial: false }, {
			fg: (_color: string, text: string) => text,
		} as never, { isError: false } as never);
		assert.match(component.render(100).join("\n"), /Final subagent report recorded\./);
	});

	it("preserves multiline report and needs strings exactly", async (t) => {
		const report = "## Findings\n\n- first\n- second\n";
		const needs = "Choose one:\n\n1. Alpha\n2. Beta\n";
		const harness = await createProtocolHarness(t, [
			fauxAssistantMessage(fauxToolCall(CREW_REPORT_TOOL_NAME, {
				outcome: "needs_input",
				report,
				needs,
			}, { id: "multiline-report" })),
		]);

		assert.deepEqual(await harness.start(), {
			status: "needs_input",
			result: { outcome: "needs_input", report, needs },
		});
	});

	it("rejects unknown and conditionally invalid fields", async (t) => {
		const invalidCalls: JsonObject[] = [
			{ outcome: "completed", report: "  \n" },
			{ outcome: "completed", report: "Has forbidden needs", needs: "not allowed" },
			{ outcome: "needs_input", report: "Missing needs" },
			{ outcome: "needs_input", report: "Blank needs", needs: "  \n" },
			{ outcome: "completed", report: "Unknown field", extra: true },
		];
		for (const [index, args] of invalidCalls.entries()) {
			let invalidWasRejected = false;
			const harness = await createProtocolHarness(t, [
				fauxAssistantMessage(fauxToolCall(CREW_REPORT_TOOL_NAME, args, { id: `invalid-${index}` })),
				(context) => {
					const result = context.messages.at(-1);
					invalidWasRejected = result?.role === "toolResult" && result.isError;
					if (index < 4) {
						assert.equal(result?.role, "toolResult");
						const content = result!.content[0] as { text: string };
						const error = JSON.parse(content.text);
						assert.deepEqual(Object.keys(error), ["error"]);
						assert.match(error.error, /crew_report/);
					}
					return completedReport(`Recovered ${index}`, `valid-${index}`);
				},
			]);
			assert.deepEqual((await harness.start()).result, {
				outcome: "completed",
				report: `Recovered ${index}`,
			});
			assert.equal(invalidWasRejected, true);
			assert.equal(harness.faux.state.callCount, 2);
		}
	});
});
