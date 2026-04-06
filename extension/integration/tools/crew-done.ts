import { Type } from "@sinclair/typebox";
import {
	renderCrewCall,
	renderCrewResult,
	toolError,
	toolSuccess,
} from "../tool-presentation.js";
import type { CrewToolDeps } from "./tool-deps.js";

export function registerCrewDoneTool({ pi, crew }: CrewToolDeps): void {
	pi.registerTool({
		name: "crew_done",
		label: "Done with Crew",
		description:
			"Close an interactive subagent session. Use when you no longer need to interact with the subagent.",
		parameters: Type.Object({
			subagent_id: Type.String({ description: "ID of the subagent to close" }),
		}),
		promptSnippet: "Close an interactive subagent session when done.",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const callerSessionId = ctx.sessionManager.getSessionId();
			const { error } = crew.done(params.subagent_id, callerSessionId);
			if (error) return toolError(error);

			return toolSuccess(`Subagent ${params.subagent_id} closed.`, {
				id: params.subagent_id,
			});
		},

		renderCall(args, theme, _context) {
			return renderCrewCall(theme, "crew_done", args.subagent_id || "...");
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});
}
