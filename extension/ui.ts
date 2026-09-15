import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	getMarkdownTheme,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ActiveAgentSummary, CrewRuntime } from "./crew.js";
import type { CrewAbortEntryData, StoredCrewResultMessageDetails } from "./delivery.js";
import { formatCost, formatDuration, formatModelLabel, formatTokens } from "./format.js";
import { SUBAGENT_OUTCOME } from "./subagent-result.js";
import {
	SUBAGENT_STATUS,
	SUBAGENT_TOOL_STATUS,
	isSubagentStatusPhase,
	type SubagentStatus,
	type SubagentToolStatus,
} from "./subagent-status.js";
import { sanitizeInline } from "./tool-activity.js";
import { formatAbortResult, toolErrorText, type CrewActionResult } from "./tool-output.js";

type ToolTheme = Parameters<Exclude<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"], undefined>>[1];
export type ToolResult = AgentToolResult<unknown>;

export type SubagentStatusPresentation = {
	icon: string;
	label: string;
	color: "success" | "warning" | "error" | "muted";
};

const SUBAGENT_STATUS_PRESENTATION = {
	[SUBAGENT_STATUS.running]: { icon: "⏳", label: "running", color: "warning" },
	[SUBAGENT_STATUS.completed]: { icon: "✅", label: "completed", color: "success" },
	[SUBAGENT_STATUS.needsInput]: { icon: "⏳", label: "needs input", color: "warning" },
	[SUBAGENT_STATUS.error]: { icon: "❌", label: "failed", color: "error" },
	[SUBAGENT_STATUS.aborted]: { icon: "⏹", label: "aborted", color: "error" },
} as const satisfies Record<SubagentStatus, SubagentStatusPresentation>;

/** Stored messages from older sessions can carry a status that no longer exists. */
export function getSubagentStatusPresentation(status: string): SubagentStatusPresentation {
	return SUBAGENT_STATUS_PRESENTATION[status as SubagentStatus]
		?? { icon: "❓", label: status || "unknown", color: "muted" };
}

type SubagentToolStatusPresentation = {
	color: "success" | "error" | "muted";
	showsResult: boolean;
};

const SUBAGENT_TOOL_STATUS_PRESENTATION = {
	[SUBAGENT_TOOL_STATUS.running]: { color: "muted", showsResult: false },
	[SUBAGENT_TOOL_STATUS.done]: { color: "success", showsResult: true },
	[SUBAGENT_TOOL_STATUS.error]: { color: "error", showsResult: false },
} as const satisfies Record<SubagentToolStatus, SubagentToolStatusPresentation>;

export function getCrewResultTitle(details: {
	agentId: string;
	brief?: string;
}): string {
	const brief = sanitizeInline(details.brief ?? "");
	return brief ? `${details.agentId} · ${brief}` : details.agentId;
}

function linkFilePath(filePath: string): string {
	const url = pathToFileURL(filePath).href;
	return `\x1b]8;;${url}\x07${filePath}\x1b]8;;\x07`;
}

function getResultMarkdown(details: StoredCrewResultMessageDetails): string | undefined {
	if (details.result?.outcome === SUBAGENT_OUTCOME.needsInput) {
		return `## Needs\n\n${details.result.needs}\n\n${details.result.report}`;
	}
	return details.result?.report ?? details.error ?? details.body;
}

export function registerCrewMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("crew-result", (message, { expanded, outputPad }, theme) => {
		const details = message.details as StoredCrewResultMessageDetails | undefined;
		const presentation = details ? getSubagentStatusPresentation(details.status) : undefined;
		const title = details ? getCrewResultTitle(details) : "Subagent update";
		const icon = presentation ? theme.fg(presentation.color, presentation.icon) : theme.fg("muted", "ℹ");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(title))}`;
		const body = details ? getResultMarkdown(details) : undefined;

		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));

		if (body) {
			box.addChild(new Spacer());
			if (expanded) {
				box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
			} else {
				const lines = body.split("\n");
				const preview = lines.slice(0, 5).join("\n");
				box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				if (lines.length > 5) box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			}
		}

		if (expanded && details?.sessionFile) {
			box.addChild(new Spacer());
			box.addChild(new Text(theme.fg("muted", `📁 ${linkFilePath(details.sessionFile)}`), 0, 0));
		}

		return box;
	});

	// Aborts never reach model context, so they only exist as TUI entries.
	pi.registerEntryRenderer<CrewAbortEntryData>("crew-abort", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const presentation = getSubagentStatusPresentation(SUBAGENT_STATUS.aborted);
		const title = getCrewResultTitle(data);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(
			`${theme.fg(presentation.color, presentation.icon)} ${theme.fg("toolTitle", theme.bold(title))}`,
			0,
			0,
		));
		if (data.error) box.addChild(new Text(theme.fg("dim", data.error), 0, 0));
		return box;
	});
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

function actionResultText(result: CrewActionResult): string {
	switch (result.action) {
		case "spawn": return `Subagent '${result.name}' spawned as ${result.subagent_id}.`;
		case "respond": return `Message sent to subagent ${result.subagent_id}. Response will be delivered asynchronously.`;
		case "done": return `Subagent ${result.subagent_id} closed.`;
		case "abort": return formatAbortResult(result);
	}
}

export function renderCrewResult(result: ToolResult, theme: ToolTheme, isError: boolean): Text {
	const text = result.content[0];
	const content = text?.type === "text" && text.text ? text.text : "(no output)";
	const details = result.details as CrewActionResult | undefined;
	const display = isError ? toolErrorText(content) : details?.action ? actionResultText(details) : content;
	return new Text(theme.fg(isError ? "error" : "success", display), 0, 0);
}

export const CREW_WIDGET_TOGGLE_SHORTCUT = "ctrl+shift+e";
const COMPACT_TOOL_CALL_LIMIT = 3;
const EXPANDED_TOOL_CALL_LIMIT = 10;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

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
	private showToolCalls = true;

	constructor(
		private readonly theme: Theme,
		private readonly formatKeyHint: (key: string, description: string) => string = rawKeyHint,
	) {}

	setState(agents: ActiveAgentSummary[], frame: string, expanded: boolean, showToolCalls = true): void {
		this.agents = agents;
		this.frame = frame;
		this.expanded = expanded;
		this.showToolCalls = showToolCalls;
	}

	setFrame(frame: string): void {
		this.frame = frame;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines: string[] = [];
		for (const [index, agent] of this.agents.entries()) {
			if (index > 0) lines.push("");
			const model = sanitizeInline(formatModelLabel(agent.model, agent.modelName) ?? "…");
			const agentId = sanitizeInline(agent.id);
			const brief = sanitizeInline(agent.brief ?? "") || sanitizeInline(agent.agentName);
			const inFlight = isSubagentStatusPhase(agent.status, "in-flight");
			const icon = inFlight ? this.frame : getSubagentStatusPresentation(agent.status).icon;
			const limit = this.expanded ? EXPANDED_TOOL_CALL_LIMIT : COMPACT_TOOL_CALL_LIMIT;
			const visibleActivities = agent.toolActivities.slice(-limit);
			const failures = failureLabel(agent.toolFailureCount);
			const header = this.theme.fg("warning", icon) + " "
				+ this.theme.fg("toolTitle", this.theme.bold(agentId))
				+ this.theme.fg("muted", ` - ${brief}`);
			const usage = `  ${model} · ${agent.thinking ?? "…"} | ↑ ${formatTokens(agent.inputTokens)} · ↓ ${formatTokens(agent.outputTokens)} · ${formatCost(agent.cost)}`;
			const progress = `  ${formatDuration(agent.workedMs)} · ${toolCallLabel(agent.toolCallCount)}${failures ? ` · ${failures}` : ""}`;
			lines.push(truncateToWidth(header, width, "…"));
			lines.push(truncateToWidth(this.theme.fg("muted", usage), width, "…"));
			lines.push(truncateToWidth(this.theme.fg("muted", progress), width, "…"));
			if (this.showToolCalls) {
				for (const tool of visibleActivities) {
					const presentation = SUBAGENT_TOOL_STATUS_PRESENTATION[tool.status];
					const target = sanitizeInline(tool.target);
					const name = sanitizeInline(tool.name) === "bash" ? "$" : sanitizeInline(tool.name);
					const result = presentation.showsResult && tool.resultSummary ? ` · ${sanitizeInline(tool.resultSummary)}` : "";
					const action = "    " + this.theme.fg(presentation.color, name)
						+ (target ? this.theme.fg("muted", `  ${target}`) : "")
						+ (result ? this.theme.fg("accent", result) : "");
					lines.push(truncateToWidth(action, width, "…"));
				}
			}
		}
		if (this.agents.length > 0 && this.showToolCalls) {
			lines.push("");
			lines.push(truncateToWidth(
				this.theme.fg(
					"dim",
					`  ${this.formatKeyHint(CREW_WIDGET_TOGGLE_SHORTCUT, `to ${this.expanded ? "collapse" : "details"}`)}`,
				),
				width,
				"…",
			));
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
	showToolCalls: boolean;
	agents: ActiveAgentSummary[];
}

function hasRunningAgent(agents: ActiveAgentSummary[]): boolean {
	return agents.some((agent) => isSubagentStatusPhase(agent.status, "in-flight"));
}

function currentFrame(state: WidgetState): string {
	return SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
}

export interface CrewWidgetController {
	update(ctx: ExtensionContext, crew: CrewRuntime, expanded?: boolean, showToolCalls?: boolean): void;
}

export function createCrewWidgetController(): CrewWidgetController {
	let widget: WidgetState | undefined;

	const disposeWidget = (state: WidgetState): void => {
		clearInterval(state.timer);
		if (widget === state) widget = undefined;
	};

	const clearWidget = (): void => {
		const current = widget;
		if (!current) return;
		disposeWidget(current);
		current.ctx.ui.setWidget("crew-status", undefined);
	};

	const pushAgents = (
		state: WidgetState,
		agents: ActiveAgentSummary[],
		expanded: boolean,
		showToolCalls: boolean,
	): void => {
		state.agents = agents;
		state.expanded = expanded;
		state.showToolCalls = showToolCalls;
		state.component.setState(agents, currentFrame(state), expanded, showToolCalls);
		state.tui.requestRender();
	};

	return {
		update(ctx: ExtensionContext, crew: CrewRuntime, expanded = false, showToolCalls = true): void {
			if (ctx.mode !== "tui") {
				clearWidget();
				return;
			}

			const active = crew.getActiveSummariesForOwner(ctx.sessionManager.getSessionId());
			if (active.length === 0) {
				clearWidget();
				return;
			}

			if (widget && widget.ctx !== ctx) clearWidget();
			if (widget) {
				pushAgents(widget, active, expanded, showToolCalls);
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
					showToolCalls,
					agents: active,
					// The spinner timer also re-fetches agent data so durations count up between tool events.
					timer: setInterval(() => {
						if (!hasRunningAgent(state.agents)) return;
						state.frameIndex++;
						const active = crew.getActiveSummariesForOwner(ctx.sessionManager.getSessionId());
						if (active.length > 0) {
							pushAgents(state, active, state.expanded, state.showToolCalls);
						} else {
							// Settling clears the widget through update(); keep animating until that arrives.
							state.component.setFrame(currentFrame(state));
							state.tui.requestRender();
						}
					}, SPINNER_INTERVAL_MS),
				};
				state.timer.unref();

				widget = state;
				pushAgents(state, active, expanded, showToolCalls);

				return Object.assign(component, {
					dispose() {
						disposeWidget(state);
					},
				});
			});
		},
	};
}
