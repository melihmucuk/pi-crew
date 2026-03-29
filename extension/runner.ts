import { randomBytes } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { type AgentConfig, parseModel } from "./agents.js";

// Re-export for widget.ts
export type { AgentConfig };

export interface SubagentState {
	id: string;
	agentConfig: AgentConfig;
	task: string;
	status: "running" | "done" | "error";
	session: AgentSession | null;
	turns: number;
	contextTokens: number;
	model: string | undefined;
	aborted: boolean;
	error?: string;
	result?: string;
}

type ToolFactory = (
	cwd: string,
) => ReturnType<
	typeof createReadTool |
		typeof createBashTool |
		typeof createEditTool |
		typeof createWriteTool |
		typeof createGrepTool |
		typeof createFindTool |
		typeof createLsTool
>;

type AgentResultStatus = "completed" | "failed" | "aborted";

const TOOL_FACTORIES: Record<string, ToolFactory> = {
	read: (cwd) => createReadTool(cwd),
	bash: (cwd) => createBashTool(cwd),
	edit: (cwd) => createEditTool(cwd),
	write: (cwd) => createWriteTool(cwd),
	grep: (cwd) => createGrepTool(cwd),
	find: (cwd) => createFindTool(cwd),
	ls: (cwd) => createLsTool(cwd),
};

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

function generateId(name: string): string {
	return `${name}-${randomBytes(2).toString("hex")}`;
}

function extractLastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const texts: string[] = [];
			for (const part of assistantMsg.content) {
				if (part.type === "text") {
					texts.push(part.text);
				}
			}
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return undefined;
}

function resolveThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	return VALID_THINKING_LEVELS.includes(value as ThinkingLevel)
		? (value as ThinkingLevel)
		: undefined;
}

function isSupportedTool(name: string): name is keyof typeof TOOL_FACTORIES {
	return name in TOOL_FACTORIES;
}

function resolveTools(toolNames: string[] | undefined, cwd: string) {
	const names = toolNames ?? Object.keys(TOOL_FACTORIES);
	return names
		.filter(isSupportedTool)
		.map((name) => TOOL_FACTORIES[name](cwd));
}

export class CrewManager {
	private activeAgents = new Map<string, SubagentState>();
	private extensionResolvedPath: string;

	onWidgetUpdate: (() => void) | undefined;

	constructor(extensionResolvedPath: string) {
		this.extensionResolvedPath = extensionResolvedPath;
	}

	spawn(
		agentConfig: AgentConfig,
		task: string,
		cwd: string,
		parentSessionFile: string | undefined,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	): string {
		const id = generateId(agentConfig.name);
		const state = this.createState(id, agentConfig, task);

		this.activeAgents.set(id, state);
		this.onWidgetUpdate?.();
		void this.spawnSession(state, cwd, parentSessionFile, ctx, pi);

		return id;
	}

	private createState(
		id: string,
		agentConfig: AgentConfig,
		task: string,
	): SubagentState {
		return {
			id,
			agentConfig,
			task,
			status: "running",
			session: null,
			turns: 0,
			contextTokens: 0,
			model: undefined,
			aborted: false,
		};
	}

	private resolveModel(agentConfig: AgentConfig, ctx: ExtensionContext, modelRegistry: ModelRegistry) {
		let model = ctx.model;
		if (!agentConfig.model) {
			return model;
		}

		const parsed = parseModel(agentConfig.model);
		if (!parsed) {
			return model;
		}

		const found = modelRegistry.find(parsed.provider, parsed.modelId);
		if (found) {
			return found;
		}

		console.warn(
			`[pi-crew] Agent "${agentConfig.name}": model "${agentConfig.model}" not found in registry, using default`,
		);
		return model;
	}

	private createResourceLoader(cwd: string, agentConfig: AgentConfig): DefaultResourceLoader {
		const extensionPath = this.extensionResolvedPath;
		const configSkills = agentConfig.skills;
		const systemPromptBody = agentConfig.systemPrompt;

		return new DefaultResourceLoader({
			cwd,
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter(
					(ext) => !ext.resolvedPath.startsWith(extensionPath),
				),
			}),
			skillsOverride: configSkills
				? (base) => ({
						skills: base.skills.filter((s) => configSkills.includes(s.name)),
						diagnostics: base.diagnostics,
					})
				: undefined,
			appendSystemPromptOverride: (base) =>
				systemPromptBody.trim() ? [...base, systemPromptBody] : base,
		});
	}

	private attachSessionListeners(state: SubagentState, session: AgentSession): void {
		session.subscribe((event) => {
			if (event.type !== "turn_end") {
				return;
			}

			state.turns++;
			const msg = event.message;
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				state.contextTokens = assistantMsg.usage.totalTokens;
				state.model = assistantMsg.model;
			}
			this.onWidgetUpdate?.();
		});
	}

	private completeAgent(state: SubagentState, session: AgentSession, pi: ExtensionAPI): void {
		state.result = extractLastAssistantText(session.messages) ?? "(no output)";
		state.status = "done";
		this.sendAgentResult(pi, state, "completed");
	}

	private failAgent(state: SubagentState, err: unknown, pi: ExtensionAPI): void {
		state.status = "error";
		state.error = err instanceof Error ? err.message : String(err);
		this.sendAgentResult(pi, state, "failed");
	}

	private sendAgentResult(
		pi: ExtensionAPI,
		state: SubagentState,
		status: AgentResultStatus,
	): void {
		const isError = status !== "completed";
		const details = {
			agentId: state.id,
			agentName: state.agentConfig.name,
			error: isError,
		};

		let content: string;
		if (status === "completed") {
			content = `**✅ Agent '${state.agentConfig.name}' (${state.id}) completed**\n\n${state.result ?? "(no output)"}`;
		} else if (status === "aborted") {
			content = `**⏹️ Agent '${state.agentConfig.name}' (${state.id}) aborted**`;
		} else {
			content = `**❌ Agent '${state.agentConfig.name}' (${state.id}) failed**\n\n${state.error ?? "Unknown error"}`;
		}

		pi.sendMessage(
			{
				customType: "crew-result",
				content,
				display: true,
				details,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	private removeAgent(id: string): void {
		this.activeAgents.delete(id);
		this.onWidgetUpdate?.();
	}

	private async spawnSession(
		state: SubagentState,
		cwd: string,
		parentSessionFile: string | undefined,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	): Promise<void> {
		let sessionResult: CreateAgentSessionResult | undefined;

		try {
			if (state.aborted) {
				return;
			}

			const authStorage = AuthStorage.create();
			const modelRegistry = new ModelRegistry(authStorage);
			const model = this.resolveModel(state.agentConfig, ctx, modelRegistry);
			const thinkingLevel = resolveThinkingLevel(state.agentConfig.thinking);
			const tools = resolveTools(state.agentConfig.tools, cwd);
			const resourceLoader = this.createResourceLoader(cwd, state.agentConfig);
			await resourceLoader.reload();
			if (state.aborted) {
				return;
			}

			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: state.agentConfig.compaction ?? true },
			});

			const sessionManager = SessionManager.create(cwd);
			sessionManager.newSession({
				parentSession: parentSessionFile,
			});

			sessionResult = await createAgentSession({
				cwd,
				model,
				thinkingLevel,
				tools,
				resourceLoader,
				sessionManager,
				settingsManager,
				authStorage,
				modelRegistry,
			});

			const { session } = sessionResult;
			state.session = session;
			if (state.aborted) {
				return;
			}

			this.attachSessionListeners(state, session);
			await session.prompt(state.task);
			if (state.aborted) {
				return;
			}

			this.completeAgent(state, session, pi);
		} catch (err) {
			if (state.aborted) {
				return;
			}

			this.failAgent(state, err, pi);
		} finally {
			this.removeAgent(state.id);
			sessionResult?.session.dispose();
		}
	}

	abort(id: string, pi: ExtensionAPI): boolean {
		const state = this.activeAgents.get(id);
		if (!state) return false;

		if (state.session) {
			state.session.abort().catch(() => {});
			state.session.dispose();
		}

		state.aborted = true;
		state.status = "error";
		state.error = "Aborted by user";
		this.removeAgent(id);
		this.sendAgentResult(pi, state, "aborted");

		return true;
	}

	abortAll(pi: ExtensionAPI): void {
		for (const [id] of this.activeAgents) {
			this.abort(id, pi);
		}
	}

	getRunning(): SubagentState[] {
		return Array.from(this.activeAgents.values()).filter(
			(s) => s.status === "running",
		);
	}

	get(id: string): SubagentState | undefined {
		return this.activeAgents.get(id);
	}
}
