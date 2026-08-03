import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerCrewMessageRenderers } from "../extension/ui.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function setupRenderers(): Map<string, any> {
	const renderers = new Map<string, any>();
	registerCrewMessageRenderers({
		registerMessageRenderer(type: string, renderer: any) {
			renderers.set(type, renderer);
		},
	} as never);
	return renderers;
}

function renderedLine(renderer: any, message: unknown, outputPad: number, marker: string): string {
	const component = renderer(message, { expanded: false, outputPad }, theme);
	const line = component.render(120)
		.map(stripVTControlCharacters)
		.find((candidate: string) => candidate.includes(marker));
	assert.ok(line, `expected rendered output to include ${marker}`);
	return line;
}

describe("crew message renderers", () => {
	it("uses outputPad as horizontal padding for result and warning messages", () => {
		const renderers = setupRenderers();
		const result = renderers.get("crew-result");
		const warning = renderers.get("crew-list-warning");
		const resultMarker = "Subagent 'scout' (scout-1234) done";
		const warningMarker = "Active subagents detected";

		const positions = [0, 1].map((outputPad) => {
			const resultLine = renderedLine(result, {
				details: { agentId: "scout-1234", agentName: "scout", status: "done" },
			}, outputPad, resultMarker);
			const warningLine = renderedLine(warning, {
				content: "⚠ Active subagents detected. Do not poll crew_list.",
			}, outputPad, warningMarker);
			return {
				result: resultLine.indexOf(resultMarker),
				warning: warningLine.indexOf(warningMarker),
			};
		});

		assert.equal(positions[1]!.result - positions[0]!.result, 1);
		assert.equal(positions[1]!.warning - positions[0]!.warning, 1);
	});
});
