import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";

export function registerCrewMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("crew-result", (message, { expanded }, theme) => {
		const details = message.details as
			| { agentId: string; agentName: string; error?: boolean }
			| undefined;

		const isError = details?.error ?? false;
		const agentLabel = details
			? `${details.agentName} (${details.agentId})`
			: "agent";

		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(agentLabel))}`;

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));

		if (message.content) {
			const content = String(message.content);
			if (expanded) {
				box.addChild(new Text("", 0, 0));
				box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
			} else {
				const lines = content.split("\n");
				const preview = lines.slice(0, 5).join("\n");
				box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				if (lines.length > 5) {
					box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
				}
			}
		}

		return box;
	});

	pi.registerMessageRenderer("crew-remaining", (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("warning", String(message.content ?? "")), 0, 0));
		return box;
	});
}
