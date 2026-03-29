import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export type ToolTheme = Parameters<Exclude<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"], undefined>>[1];
export type ToolResult = { content: { type: string; text?: string }[]; details: unknown };

export function toolError(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: { error: true },
	};
}

export function toolSuccess(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function truncatePreview(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function renderCrewCall(
	theme: ToolTheme,
	name: string,
	id: string,
	preview?: string,
): Text {
	let text = theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", id);
	if (preview) text += theme.fg("dim", ` "${preview}"`);
	return new Text(text, 0, 0);
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
