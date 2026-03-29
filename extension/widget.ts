import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { CrewManager, SubagentState } from "./runner.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function buildLine(agent: SubagentState, frame: string): string {
	const model = agent.model ?? "…";
	return `${frame} ${agent.id} (${model}) · turn ${agent.turns} · ${formatTokens(agent.contextTokens)} ctx`;
}

interface WidgetState {
	ctx: ExtensionContext;
	text: Text;
	// biome-ignore lint: TUI type from factory param
	tui: any;
	timer: ReturnType<typeof setInterval>;
	frameIndex: number;
}

let widget: WidgetState | undefined;

function disposeWidget(state: WidgetState): void {
	clearInterval(state.timer);
	if (widget === state) {
		widget = undefined;
	}
}

function clearWidget(): void {
	const current = widget;
	if (!current) return;
	disposeWidget(current);
	current.ctx.ui.setWidget("crew-status", undefined);
}

function syncWidgetText(state: WidgetState, agents: SubagentState[]): void {
	const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
	const lines = agents.map((agent) => buildLine(agent, frame));
	state.text.setText(lines.join("\n"));
	state.tui.requestRender();
}

export function updateWidget(ctx: ExtensionContext, crewManager: CrewManager): void {
	if (!ctx.hasUI) {
		clearWidget();
		return;
	}

	const running = crewManager.getRunning();
	if (running.length === 0) {
		clearWidget();
		return;
	}

	if (widget && widget.ctx !== ctx) {
		clearWidget();
	}

	if (widget) {
		syncWidgetText(widget, running);
		return;
	}

	ctx.ui.setWidget("crew-status", (tui, _theme) => {
		const text = new Text("", 1, 0);
		const state: WidgetState = {
			ctx,
			text,
			tui,
			frameIndex: 0,
			timer: setInterval(() => {
				state.frameIndex++;
				const agents = crewManager.getRunning();
				if (agents.length === 0) {
					clearWidget();
					return;
				}
				syncWidgetText(state, agents);
			}, SPINNER_INTERVAL_MS),
		};

		widget = state;
		syncWidgetText(state, running);

		return Object.assign(text, {
			dispose() {
				disposeWidget(state);
			},
		});
	});
}
