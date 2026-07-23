import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveAgentSummary, SubagentToolActivity } from "../extension/crew.js";
import { CrewWidgetComponent } from "../extension/ui.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function component(): CrewWidgetComponent {
	return new CrewWidgetComponent(theme, (key, description) => `${key} ${description}`);
}

function summary(toolCount: number): ActiveAgentSummary {
	const retainedCount = Math.min(toolCount, 10);
	const firstRetained = toolCount - retainedCount + 1;
	const toolActivities: SubagentToolActivity[] = Array.from({ length: retainedCount }, (_, index) => {
		const callNumber = firstRetained + index;
		return {
			id: `tool-${callNumber}`,
			name: `call-${callNumber}`,
			target: `target-${callNumber}`,
			status: "done",
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
		toolActivities,
	};
}

describe("CrewWidgetComponent", () => {
	it("shows the latest three tool calls in compact mode", () => {
		const widget = component();
		widget.setState([summary(12)], "⠋", false);

		const output = widget.render(200).join("\n");
		assert.match(output, /ctrl\+shift\+e to expand/);
		assert.match(output, /12 tool calls · ↑ 12\.4k · ↓ 1\.2k · \$0\.03/);
		assert.doesNotMatch(output, /ctx/);
		assert.doesNotMatch(output, /older tool calls/);
		assert.doesNotMatch(output, /call-9  target-9/);
		assert.match(output, /call-10  target-10/);
		assert.match(output, /call-12  target-12/);
	});

	it("caps expanded mode at the latest ten calls and reports hidden history", () => {
		const widget = component();
		widget.setState([summary(12)], "⠋", true);

		const output = widget.render(200).join("\n");
		assert.match(output, /… 2 older tool calls/);
		assert.doesNotMatch(output, /call-2  target-2/);
		assert.match(output, /call-3  target-3/);
		assert.match(output, /call-12  target-12/);
	});

	it("keeps every expanded widget line within the terminal width", () => {
		const widget = component();
		widget.setState([summary(12)], "⠋", true);

		const lines = widget.render(4);
		assert.ok(lines.every((line) => visibleWidth(line) <= 4));
	});
});
