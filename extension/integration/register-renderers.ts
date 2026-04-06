import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";
import {
	type CrewResultMessageDetails,
	STATUS_ICON,
	getCrewResultTitle,
} from "../subagent-messages.js";

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

export function registerCrewMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("crew-result", (message, { expanded }, theme) => {
		const details = message.details as CrewResultMessageDetails | undefined;
		const title = details ? getCrewResultTitle(details) : "Subagent update";
		const icon = details
			? theme.fg(getStatusColor(details.status), STATUS_ICON[details.status])
			: theme.fg("muted", "ℹ");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(title))}`;
		const body = details?.body ?? (!details && message.content ? String(message.content) : undefined);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));

		if (details?.sessionFile) {
			box.addChild(new Text(theme.fg("muted", `📁 ${details.sessionFile}`), 0, 0));
		}

		if (body) {
			if (expanded) {
				box.addChild(new Text("", 0, 0));
				box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
			} else {
				const lines = body.split("\n");
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
