import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { appendCrewAbortEntry, sendCrewResultMessage } from "../extension/delivery.js";
import { formatModelLabel } from "../extension/format.js";
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
		registerEntryRenderer(type: string, renderer: any) {
			renderers.set(type, renderer);
		},
	} as never);
	return renderers;
}

function render(renderer: any, message: unknown, expanded = false, outputPad = 0): string {
	if (expanded) initTheme("dark", false);
	return renderer(message, { expanded, outputPad }, theme)
		.render(160)
		.map((line: string) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
}

function renderedLine(renderer: any, message: unknown, outputPad: number, marker: string): string {
	const line = render(renderer, message, false, outputPad)
		.split("\n")
		.find((candidate: string) => candidate.includes(marker));
	assert.ok(line, `expected rendered output to include ${marker}`);
	return line;
}

function resultMessage(details: Record<string, unknown>): unknown {
	return { content: "model-only JSON", details };
}

describe("crew message renderers", () => {
	it("uses outputPad as horizontal padding for result messages", () => {
		const result = setupRenderers().get("crew-result");
		const resultMarker = "✅ scout-1234 · map endpoints";
		const message = resultMessage({
			agentId: "scout-1234",
			agentName: "scout",
			brief: "map endpoints",
			status: "completed",
			result: { outcome: "completed", report: "Report" },
		});

		const positions = [0, 1].map((outputPad) =>
			renderedLine(result, message, outputPad, resultMarker).indexOf(resultMarker));

		assert.equal(positions[1]! - positions[0]!, 1);
	});

	it("records aborts as entries and renders the card with its reason", () => {
		const entries: Array<{ customType: string; data: unknown }> = [];
		appendCrewAbortEntry({
			id: "worker-9999",
			agentName: "worker",
			brief: "test failure",
			settlement: { status: "aborted", error: "Stopped by owner" },
		}, ((customType: string, data: unknown) => entries.push({ customType, data })) as never);

		assert.equal(entries[0]?.customType, "crew-abort");

		const renderer = setupRenderers().get("crew-abort");
		const output = render(renderer, { data: entries[0]?.data });
		assert.match(output, /^ ⏹ worker-9999 · test failure$/m);
		assert.match(output, /Stopped by owner/);
	});

	it("sends exact structured result JSON to model context without duplicating a display body", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const result = {
			outcome: "needs_input" as const,
			report: "Line one\n\n- exact **Markdown**",
			needs: "Choose `A` or `B`.\nDo not paraphrase.",
		};
		sendCrewResultMessage({
			id: "scout-1",
			agentName: "scout",
			brief: "inspect routing",
			settlement: { status: "needs_input", result },
		}, ((message: any, options: any) => sent.push({ message, options })) as never);

		assert.deepEqual(JSON.parse(sent[0]?.message.content), {
			subagent_id: "scout-1",
			brief: "inspect routing",
			result,
		});
		assert.deepEqual(sent[0]?.message.details.result, result);
		assert.equal("body" in sent[0]?.message.details, false);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	});

	it("renders completed and needs-input cards from structured details", () => {
		const renderer = setupRenderers().get("crew-result");
		const completed = render(renderer, resultMessage({
			agentId: "worker-1234",
			agentName: "worker",
			brief: "implement cards",
			sessionFile: "/sessions/worker-1234.jsonl",
			status: "completed",
			result: { outcome: "completed", report: "## Completed\n\nExact **report**\nline 4\nline 5\nline 6" },
		}));
		assert.match(completed, /^✅ worker-1234 · implement cards\n\n/m);
		assert.match(completed, /^## Completed$/m);
		assert.doesNotMatch(completed, /Outcome|Report/);
		assert.doesNotMatch(completed, /worker-1234\.jsonl/);
		assert.match(completed, /Ctrl\+O to expand/);
		assert.match(completed, /line 5/);
		assert.doesNotMatch(completed, /line 6/);

		const needs = render(renderer, resultMessage({
			agentId: "worker-5678",
			agentName: "worker",
			brief: "choose API",
			status: "needs_input",
			result: { outcome: "needs_input", needs: "Pick **A**.", report: "## Completed\n\nResearch so far" },
		}));
		assert.match(needs, /^⏳ worker-5678 · choose API$/m);
		assert.ok(needs.indexOf("## Needs") < needs.indexOf("Pick **A**.") && needs.indexOf("Pick **A**.") < needs.indexOf("## Completed"));
		assert.doesNotMatch(needs, /Outcome|Report|needs_input/);
	});

	it("shows full Markdown and the session link only when expanded", () => {
		const renderer = setupRenderers().get("crew-result");
		const message = resultMessage({
			agentId: "worker-1234",
			agentName: "worker",
			brief: "implement cards",
			sessionFile: "/sessions/worker-1234.jsonl",
			status: "completed",
			result: { outcome: "completed", report: "## Completed\n\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6" },
		});

		const collapsed = render(renderer, message);
		const expanded = render(renderer, message, true);
		assert.doesNotMatch(collapsed, /worker-1234\.jsonl|line 6/);
		assert.match(expanded, /Completed/);
		assert.match(expanded, /line 6/);
		assert.match(expanded, /\n\n📁 \/sessions\/worker-1234\.jsonl$/m);
	});

	it("renders error cards while model context carries status instead of a result", () => {
		const renderer = setupRenderers().get("crew-result");
		const cases = [
			{ status: "error", icon: "❌", error: "Result contract failed" },
		] as const;

		for (const item of cases) {
			const sent: Array<{ message: any }> = [];
			sendCrewResultMessage({
				id: "worker-9999",
				agentName: "worker",
				brief: "test failure",
				settlement: { status: item.status, error: item.error },
			}, ((message: any) => sent.push({ message })) as never);
			assert.deepEqual(JSON.parse(sent[0]?.message.content), {
				subagent_id: "worker-9999",
				brief: "test failure",
				status: item.status,
				error: item.error,
			});
			assert.equal("result" in JSON.parse(sent[0]?.message.content), false);

			const output = render(renderer, sent[0]?.message);
			assert.match(output, new RegExp(`^${item.icon} worker-9999 · test failure$`, "m"));
			assert.match(output, new RegExp(item.error));
		}
	});

	it("keeps rendering aborted result messages stored by older versions", () => {
		const renderer = setupRenderers().get("crew-result");
		const output = render(renderer, resultMessage({
			agentId: "worker-9999",
			agentName: "worker",
			brief: "test failure",
			status: "aborted",
			error: "Stopped by owner",
		}));

		assert.match(output, /^⏹ worker-9999 · test failure$/m);
		assert.match(output, /Stopped by owner/);
	});

	it("renders messages stored before the result protocol", () => {
		const renderer = setupRenderers().get("crew-result");
		const output = render(renderer, resultMessage({
			agentId: "scout-1234",
			agentName: "scout",
			status: "waiting",
			body: "## Report\n\nOld stored body",
		}));

		assert.match(output, /^❓ scout-1234$/m);
		assert.match(output, /Old stored body/);
	});
});

describe("model labels", () => {
	it("keeps the provider and the last segment of a deep model id", () => {
		assert.equal(formatModelLabel("anthropic/claude-haiku-4-5"), "[anthropic] claude-haiku-4-5");
		assert.equal(
			formatModelLabel("fireworks/accounts/fireworks/models/glm-5p3-flash"),
			"[fireworks] glm-5p3-flash",
		);
	});

	it("prefers the catalog name and falls back to the id when it is blank", () => {
		assert.equal(
			formatModelLabel("fireworks/accounts/fireworks/models/glm-5p3-flash", "GLM 5.3 Flash"),
			"[fireworks] GLM 5.3 Flash",
		);
		assert.equal(formatModelLabel("provider/model-id", "  "), "[provider] model-id");
		assert.equal(formatModelLabel("model-x", "Fancy X"), "Fancy X");
	});

	it("passes through labels without a provider and models without an id", () => {
		assert.equal(formatModelLabel("model-x"), "model-x");
		assert.equal(formatModelLabel("provider/"), "provider/");
		assert.equal(formatModelLabel(undefined), undefined);
	});
});
