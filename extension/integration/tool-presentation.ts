import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

export type ToolTheme = Parameters<Exclude<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"], undefined>>[1];
export type ToolResult = AgentToolResult<unknown>;

export function toolError(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: { error: true },
	};
}

export function toolSuccess(
	text: string,
	details: Record<string, unknown> = {},
	options: { terminate?: boolean } = {},
) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(options.terminate ? { terminate: true } : {}),
	};
}

export function renderCrewCall(
	theme: ToolTheme,
	name: string,
	id: string,
	preview?: string,
): Box {
	const box = new Box(1, 1);
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", id), 0, 0));
	if (preview) {
		box.addChild(new Text(theme.fg("dim", preview), 0, 0));
	}
	return box;
}

export function renderCrewResult(
	result: ToolResult,
	theme: ToolTheme,
): Text {
	const text = result.content[0];
	const details = result.details as { error?: boolean } | undefined;
	const content = text?.type === "text" && text.text ? text.text : "(no output)";
	return new Text(details?.error ? theme.fg("error", content) : theme.fg("success", content), 0, 0);
}
