import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	getMarkdownTheme,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ActiveAgentSummary, CrewRuntime } from "./crew.js";
import { sanitizeInline } from "./tool-activity.js";

export type SendMessageFn = ExtensionAPI["sendMessage"];
type Message = Parameters<SendMessageFn>[0];

type ToolTheme = Parameters<Exclude<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"], undefined>>[1];
export type ToolResult = AgentToolResult<unknown>;

export type SubagentStatus = "running" | "waiting" | "done" | "error" | "aborted";

export const STATUS_ICON: Record<SubagentStatus, string> = {
	running: "⏳",
	waiting: "⏳",
	done: "✅",
	error: "❌",
	aborted: "⏹️",
};

export const STATUS_LABEL: Record<SubagentStatus, string> = {
	running: "running",
	waiting: "waiting for response",
	done: "done",
	error: "failed",
	aborted: "aborted",
};

export interface SteeringPayload {
	id: string;
	agentName: string;
	sessionFile?: string;
	status: SubagentStatus;
	result?: string;
	error?: string;
}

export interface CrewResultMessageDetails {
	agentId: string;
	agentName: string;
	sessionFile?: string;
	status: SubagentStatus;
	body?: string;
}

export function getCrewResultTitle(details: {
	agentId: string;
	agentName: string;
	status: SubagentStatus;
}): string {
	return `Subagent '${details.agentName}' (${details.agentId}) ${STATUS_LABEL[details.status]}`;
}

function sendWithDeliveryPolicy(
	message: Message,
	sendMessage: SendMessageFn,
	opts: { isIdle: boolean; triggerTurn: boolean },
): void {
	sendMessage(
		message,
		opts.isIdle
			? { triggerTurn: opts.triggerTurn }
			: { deliverAs: "steer", triggerTurn: opts.triggerTurn },
	);
}

function getSteeringBody(payload: SteeringPayload): string | undefined {
	return (payload.status === "error" || payload.status === "aborted")
		? (payload.error ?? payload.result)
		: (payload.result ?? payload.error);
}

export function sendSteeringMessage(
	payload: SteeringPayload,
	sendMessage: SendMessageFn,
	opts: { isIdle: boolean; triggerTurn: boolean },
): void {
	const body = getSteeringBody(payload);
	const title = getCrewResultTitle({ agentId: payload.id, agentName: payload.agentName, status: payload.status });
	const content = body
		? `**${STATUS_ICON[payload.status]} ${title}**\n\n${body}`
		: `**${STATUS_ICON[payload.status]} ${title}**`;

	sendWithDeliveryPolicy(
		{
			customType: "crew-result",
			content,
			display: true,
			details: {
				agentId: payload.id,
				agentName: payload.agentName,
				sessionFile: payload.sessionFile,
				status: payload.status,
				body,
			} satisfies CrewResultMessageDetails,
		},
		sendMessage,
		opts,
	);
}

export function sendCrewListActiveWarning(
	sendMessage: SendMessageFn,
	opts: { isIdle: boolean; triggerTurn: boolean },
): void {
	sendWithDeliveryPolicy(
		{
			customType: "crew-list-warning",
			content: "⚠ Active subagents detected. Do not poll crew_list; results arrive automatically.",
			display: true,
		},
		sendMessage,
		opts,
	);
}

function getStatusColor(status: CrewResultMessageDetails["status"]): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "done":
			return "success";
		case "error":
		case "aborted":
			return "error";
		case "running":
		case "waiting":
			return "warning";
		default:
			return "muted";
	}
}

type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
type MessageRendererTheme = Parameters<MessageRenderer>[2];

function renderWarningMessage(content: unknown, theme: MessageRendererTheme, outputPad: number): Box {
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("warning", String(content ?? "")), 0, 0));
	return box;
}

function linkFilePath(filePath: string): string {
	const url = pathToFileURL(filePath).href;
	return `\x1b]8;;${url}\x07${filePath}\x1b]8;;\x07`;
}

export function registerCrewMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("crew-result", (message, { expanded, outputPad }, theme) => {
		const details = message.details as CrewResultMessageDetails | undefined;
		const title = details ? getCrewResultTitle(details) : "Subagent update";
		const icon = details
			? theme.fg(getStatusColor(details.status), STATUS_ICON[details.status])
			: theme.fg("muted", "ℹ");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(title))}`;
		const body = details?.body ?? (!details && message.content ? String(message.content) : undefined);

		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));

		if (details?.sessionFile) {
			box.addChild(new Text(theme.fg("muted", `📁 ${linkFilePath(details.sessionFile)}`), 0, 0));
		}

		if (body) {
			if (expanded) {
				box.addChild(new Text("", 0, 0));
				box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
			} else {
				const lines = body.split("\n");
				const preview = lines.slice(0, 5).join("\n");
				box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				if (lines.length > 5) box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			}
		}

		return box;
	});

	pi.registerMessageRenderer("crew-list-warning", (message, { outputPad }, theme) => renderWarningMessage(message.content, theme, outputPad));
}

export function renderCrewCall(
	theme: ToolTheme,
	name: string,
	id: string,
	preview?: string,
	expandedMarkdown?: string,
): Box {
	const box = new Box(1, 1);
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", id), 0, 0));
	if (expandedMarkdown) {
		box.addChild(new Markdown(expandedMarkdown, 0, 0, getMarkdownTheme()));
	} else if (preview) {
		box.addChild(new Text(theme.fg("dim", preview), 0, 0));
	}
	return box;
}

export function renderCrewResult(result: ToolResult, theme: ToolTheme, isError: boolean): Text {
	const text = result.content[0];
	const content = text?.type === "text" && text.text ? text.text : "(no output)";
	return new Text(theme.fg(isError ? "error" : "success", content), 0, 0);
}

export const CREW_WIDGET_TOGGLE_SHORTCUT = "ctrl+shift+e";
const COMPACT_TOOL_CALL_LIMIT = 3;
const EXPANDED_TOOL_CALL_LIMIT = 10;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function formatCost(cost: number): string {
	if (cost === 0 || cost >= 0.01) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(4)}`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function toolCallLabel(count: number): string {
	return `${count} tool call${count === 1 ? "" : "s"}`;
}

function failureLabel(count: number): string | undefined {
	return count > 0 ? `${count} failure${count === 1 ? "" : "s"}` : undefined;
}

export class CrewWidgetComponent implements Component {
	private agents: ActiveAgentSummary[] = [];
	private expanded = false;
	private frame = "";

	constructor(
		private readonly theme: Theme,
		private readonly formatKeyHint: (key: string, description: string) => string = rawKeyHint,
	) {}

	setState(agents: ActiveAgentSummary[], frame: string, expanded: boolean): void {
		this.agents = agents;
		this.frame = frame;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines: string[] = [];
		for (const [index, agent] of this.agents.entries()) {
			if (index > 0) lines.push("");
			const model = sanitizeInline(agent.model ?? "…");
			const agentId = sanitizeInline(agent.id);
			const brief = sanitizeInline(agent.brief ?? "") || sanitizeInline(agent.agentName);
			const icon = agent.status === "waiting" ? "⏳" : this.frame;
			const activities = agent.toolActivities;
			const limit = this.expanded ? EXPANDED_TOOL_CALL_LIMIT : COMPACT_TOOL_CALL_LIMIT;
			const visibleActivities = activities.slice(-limit);
			const toggleAction = this.expanded ? "collapse" : "details";
			const duration = formatDuration(Date.now() - agent.startedAt);
			const showing = agent.toolCallCount > limit ? ` · showing latest ${limit}` : "";
			const failures = failureLabel(agent.toolFailureCount);
			const status = agent.status === "waiting" ? "waiting for response" : `${STATUS_LABEL[agent.status]} ${duration}`;
			const header = this.theme.fg("warning", icon) + " "
				+ this.theme.fg("toolTitle", this.theme.bold(agentId))
				+ this.theme.fg("muted", ` - ${brief}`)
				+ this.theme.fg("dim", " | ")
				+ this.formatKeyHint(CREW_WIDGET_TOGGLE_SHORTCUT, `to ${toggleAction}`);
			const usage = `  ${model} · ${agent.thinking ?? "…"} | ↑ ${formatTokens(agent.inputTokens)} · ↓ ${formatTokens(agent.outputTokens)} · ${formatCost(agent.cost)}`;
			const progress = this.theme.fg(
				"muted",
				`  ${status} · ${toolCallLabel(agent.toolCallCount)}${failures ? ` · ${failures}` : ""}${showing}`,
			);
			lines.push(truncateToWidth(header, width, "…"));
			lines.push(truncateToWidth(this.theme.fg("muted", usage), width, "…"));
			lines.push(truncateToWidth(progress, width, "…"));
			if (activities.length > 0) lines.push(truncateToWidth(this.theme.fg("dim", "  ---"), width, "…"));
			for (const tool of visibleActivities) {
				const color = tool.status === "error" ? "error" : tool.status === "done" ? "success" : "muted";
				const target = sanitizeInline(tool.target);
				const name = sanitizeInline(tool.name) === "bash" ? "$" : sanitizeInline(tool.name);
				const result = tool.status === "done" && tool.resultSummary ? ` · ${sanitizeInline(tool.resultSummary)}` : "";
				const action = "  " + this.theme.fg(color, name)
					+ (target ? this.theme.fg("muted", `  ${target}`) : "")
					+ (result ? this.theme.fg("accent", result) : "");
				lines.push(truncateToWidth(action, width, "…"));
			}
		}
		return lines;
	}

	invalidate(): void {}
}

interface WidgetState {
	ctx: ExtensionContext;
	component: CrewWidgetComponent;
	// biome-ignore lint: TUI type from factory param
	tui: any;
	timer: ReturnType<typeof setInterval>;
	frameIndex: number;
	expanded: boolean;
}

let widget: WidgetState | undefined;

function disposeWidget(state: WidgetState): void {
	clearInterval(state.timer);
	if (widget === state) widget = undefined;
}

function clearWidget(): void {
	const current = widget;
	if (!current) return;
	disposeWidget(current);
	current.ctx.ui.setWidget("crew-status", undefined);
}

function hasRunningAgent(agents: ActiveAgentSummary[]): boolean {
	return agents.some((agent) => agent.status === "running");
}

function syncWidgetText(state: WidgetState, agents: ActiveAgentSummary[]): void {
	const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
	state.component.setState(agents, frame, state.expanded);
	state.tui.requestRender();
}

export function updateWidget(ctx: ExtensionContext, crew: CrewRuntime, expanded = false): void {
	if (ctx.mode !== "tui") {
		clearWidget();
		return;
	}

	const ownerSessionId = ctx.sessionManager.getSessionId();
	const running = crew.getActiveSummariesForOwner(ownerSessionId);
	if (running.length === 0) {
		clearWidget();
		return;
	}

	if (widget && widget.ctx !== ctx) clearWidget();
	if (widget) {
		widget.expanded = expanded;
		syncWidgetText(widget, running);
		return;
	}

	ctx.ui.setWidget("crew-status", (tui, theme) => {
		const component = new CrewWidgetComponent(theme);
		const state: WidgetState = {
			ctx,
			component,
			tui,
			frameIndex: 0,
			expanded,
			timer: setInterval(() => {
				const agents = crew.getActiveSummariesForOwner(ownerSessionId);
				if (agents.length === 0) {
					clearWidget();
					return;
				}
				if (!hasRunningAgent(agents)) return;
				state.frameIndex++;
				syncWidgetText(state, agents);
			}, SPINNER_INTERVAL_MS),
		};
		state.timer.unref();

		widget = state;
		syncWidgetText(state, running);

		return Object.assign(component, {
			dispose() {
				disposeWidget(state);
			},
		});
	});
}
