import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveAgentSummary } from "../extension/crew.js";
import type { SubagentToolActivity } from "../extension/subagent-status.js";
import { CrewWidgetComponent, createCrewWidgetController } from "../extension/ui.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function component(): CrewWidgetComponent {
	return new CrewWidgetComponent(theme, (key, description) => `${key} ${description}`);
}

function summary(toolCount: number): Extract<ActiveAgentSummary, { status: "running" }> {
	const retainedCount = Math.min(toolCount, 10);
	const firstRetained = toolCount - retainedCount + 1;
	const toolActivities: SubagentToolActivity[] = Array.from({ length: retainedCount }, (_, index) => {
		const callNumber = firstRetained + index;
		return {
			id: `tool-${callNumber}`,
			name: `call-${callNumber}`,
			target: `target-${callNumber}`,
			status: "done",
			resultSummary: callNumber === toolCount ? "33 lines" : undefined,
		};
	});
	return {
		id: "scout-1234",
		agentName: "scout",
		brief: "inspect widget",
		status: "running",
		inputTokens: 12_400,
		outputTokens: 1_200,
		cost: 0.034,
		model: "model-x",
		thinking: "medium",
		toolCallCount: toolCount,
		toolFailureCount: 0,
		toolActivities,
		workedMs: 0,
		modelName: undefined,
	};
}

describe("CrewWidgetComponent", () => {
	it("shows the latest three tool calls in compact mode", () => {
		const widget = component();
		widget.setState([{ ...summary(12), toolFailureCount: 1 }], "⠋", false);

		const output = widget.render(200).join("\n");
		assert.match(output, /^⠋ scout-1234 - inspect widget$/m);
		assert.match(output, /^  model-x · medium \| ↑ 12\.4k · ↓ 1\.2k · \$0\.03$/m);
		assert.match(output, /^  0s · 12 tool calls · 1 failure$/m);
		assert.match(output, /^    call-10  target-10$/m);
		assert.match(output, /^    call-12  target-12 · 33 lines$/m);
		assert.doesNotMatch(output, /call-9  target-9/);
		assert.doesNotMatch(output, /^\s+---$/m);
		assert.equal(output.split("ctrl+shift+e").length - 1, 1);
	});

	it("caps expanded mode at the latest ten calls and reports hidden history", () => {
		const widget = component();
		widget.setState([summary(12)], "⠋", true);

		const output = widget.render(200).join("\n");
		assert.match(output, /model-x · medium \| ↑ 12\.4k · ↓ 1\.2k · \$0\.03/);
		assert.match(output, /^  0s · 12 tool calls$/m);
		assert.doesNotMatch(output, /older tool calls/);
		assert.doesNotMatch(output, /call-2  target-2/);
		assert.match(output, /call-3  target-3/);
		assert.match(output, /call-12  target-12/);
	});

	it("hides tool rows and the toggle hint when showToolCalls is false", () => {
		const widget = component();
		widget.setState([{ ...summary(12), toolFailureCount: 1 }], "⠋", false, false);

		const output = widget.render(200).join("\n");
		assert.match(output, /^⠋ scout-1234 - inspect widget$/m);
		assert.match(output, /model-x · medium \| ↑ 12\.4k · ↓ 1\.2k · \$0\.03/);
		assert.match(output, /^  0s · 12 tool calls · 1 failure$/m);
		assert.doesNotMatch(output, /call-12/);
		assert.doesNotMatch(output, /ctrl\+shift\+e/);

		widget.setState([summary(12)], "⠋", true, false);
		const expandedOutput = widget.render(200).join("\n");
		assert.doesNotMatch(expandedOutput, /call-12/);
		assert.doesNotMatch(expandedOutput, /ctrl\+shift\+e/);
	});

	it("shows completed and needs-input outcomes as icons beside the working time", () => {
		const widget = component();
		widget.setState([
			{ ...summary(1), status: "completed", result: { outcome: "completed", report: "done" } },
			{ ...summary(1), id: "scout-5678", status: "needs_input", result: { outcome: "needs_input", report: "blocked", needs: "choose" } },
		], "⠋", false);

		const output = widget.render(200).join("\n");
		assert.match(output, /^✅ scout-1234 - inspect widget$/m);
		assert.match(output, /^⏳ scout-5678 - inspect widget$/m);
		assert.equal(output.match(/^  0s · 1 tool call$/gm)?.length, 2);
		assert.equal(output.split("ctrl+shift+e").length - 1, 1);
		assert.doesNotMatch(output, /completed|needs input/);
	});

	it("keeps every expanded widget line within the terminal width", () => {
		const widget = component();
		widget.setState([summary(12)], "⠋", true);

		const lines = widget.render(4);
		assert.ok(lines.every((line) => visibleWidth(line) <= 4));
	});
});

interface WidgetHost {
	ctx: unknown;
	crew: unknown;
	agents: ActiveAgentSummary[];
	fetchCount: number;
	renderCount: number;
	clearCount: number;
	keys: string[];
	widgets: CrewWidgetComponent[];
	render: () => string;
}

function host(sessionId = "owner-1", mode: "tui" | "json" = "tui"): WidgetHost {
	// The controller builds components with the default key-hint formatter.
	initTheme("dark", false);
	const state: WidgetHost = {
		ctx: undefined,
		crew: undefined,
		agents: [],
		fetchCount: 0,
		renderCount: 0,
		clearCount: 0,
		keys: [],
		widgets: [],
		render: () => stripVTControlCharacters(state.widgets[state.widgets.length - 1]?.render(200).join("\n") ?? ""),
	};
	const tui = { requestRender: () => { state.renderCount++; } };
	state.ctx = {
		mode,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			setWidget(key: string, factory?: (tui: unknown, theme: Theme) => CrewWidgetComponent) {
				state.keys.push(key);
				if (!factory) {
					state.clearCount++;
					return;
				}
				state.widgets.push(factory(tui, theme));
			},
		},
	};
	state.crew = {
		getActiveSummariesForOwner: () => {
			state.fetchCount++;
			return state.agents;
		},
	};
	return state;
}

describe("crew widget controller", () => {
	it("pushes the fetched agents and clears the widget once none remain", () => {
		const controller = createCrewWidgetController();
		const h = host();
		h.agents = [summary(1)];

		controller.update(h.ctx as never, h.crew as never);
		assert.deepEqual(h.keys, ["crew-status"]);
		assert.match(h.render(), /scout-1234 - inspect widget/);

		h.agents = [];
		controller.update(h.ctx as never, h.crew as never);
		assert.equal(h.clearCount, 1);
	});

	it("clears the widget in non-TUI mode", () => {
		const controller = createCrewWidgetController();
		const tuiHost = host("owner-1", "tui");
		tuiHost.agents = [summary(1)];
		controller.update(tuiHost.ctx as never, tuiHost.crew as never);

		const printHost = host("owner-1", "json");
		controller.update(printHost.ctx as never, printHost.crew as never);

		assert.equal(tuiHost.clearCount, 1);
		assert.equal(printHost.fetchCount, 0);
	});

	it("advances the spinner from the timer without re-fetching agents", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const controller = createCrewWidgetController();
			const h = host();
			h.agents = [summary(1)];

			controller.update(h.ctx as never, h.crew as never);
			assert.match(h.render(), /^⠋ scout-1234/m);
			const fetchesAfterPush = h.fetchCount;
			const rendersAfterPush = h.renderCount;

			mock.timers.tick(80);

			assert.match(h.render(), /^⠙ scout-1234/m);
			assert.equal(h.fetchCount, fetchesAfterPush);
			assert.equal(h.renderCount, rendersAfterPush + 1);
		} finally {
			mock.timers.reset();
		}
	});

	it("stops the spinner when no pushed agent is in flight", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const controller = createCrewWidgetController();
			const h = host();
			h.agents = [{ ...summary(1), status: "completed", result: { outcome: "completed", report: "done" } }];

			controller.update(h.ctx as never, h.crew as never);
			const rendersAfterPush = h.renderCount;

			mock.timers.tick(800);

			assert.equal(h.renderCount, rendersAfterPush);
			assert.equal(h.clearCount, 0);
		} finally {
			mock.timers.reset();
		}
	});

	it("updates the expanded flag through the push path", () => {
		const controller = createCrewWidgetController();
		const h = host();
		h.agents = [summary(12)];

		controller.update(h.ctx as never, h.crew as never, false);
		assert.match(h.render(), /ctrl\+shift\+e to details/);

		controller.update(h.ctx as never, h.crew as never, true);
		assert.match(h.render(), /ctrl\+shift\+e to collapse/);
		assert.equal(h.widgets.length, 1);
	});

	it("passes showToolCalls through and a toggled expansion cannot reveal hidden rows", () => {
		const controller = createCrewWidgetController();
		const h = host();
		h.agents = [summary(12)];

		controller.update(h.ctx as never, h.crew as never, false, false);
		assert.doesNotMatch(h.render(), /call-12/);
		assert.doesNotMatch(h.render(), /ctrl\+shift\+e/);

		controller.update(h.ctx as never, h.crew as never, true, false);
		assert.doesNotMatch(h.render(), /call-12/);
		assert.doesNotMatch(h.render(), /ctrl\+shift\+e/);

		controller.update(h.ctx as never, h.crew as never, false, true);
		assert.match(h.render(), /call-12/);
		assert.match(h.render(), /ctrl\+shift\+e/);
	});

	it("re-creates the widget when the context changes", () => {
		const controller = createCrewWidgetController();
		const first = host("owner-1");
		first.agents = [summary(1)];
		controller.update(first.ctx as never, first.crew as never);

		const second = host("owner-2");
		second.agents = [summary(1)];
		controller.update(second.ctx as never, second.crew as never);

		assert.equal(first.clearCount, 1);
		assert.equal(second.widgets.length, 1);
	});
});
