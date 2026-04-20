import { Type } from "@sinclair/typebox";
import {
	renderCrewCall,
	renderCrewResult,
	toolError,
	toolSuccess,
} from "../tool-presentation.js";
import type { CrewToolDeps } from "./tool-deps.js";

export function registerCrewRespondTool({ pi, crew }: CrewToolDeps): void {
	pi.registerTool({
		name: "crew_respond",
		label: "Respond to Crew",
		description:
			"Send a follow-up message to an interactive subagent that is waiting for a response.",
		parameters: Type.Object({
			subagent_id: Type.String({
				description:
					"ID of the waiting subagent (from crew_list or crew_spawn result)",
			}),
			message: Type.String({ description: "Message to send to the subagent" }),
		}),
		promptSnippet:
			"Send a follow-up message to a waiting interactive subagent.",
		promptGuidelines: [
			"crew_respond: Response is delivered asynchronously as a steering message. Do not poll crew_list.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const callerSessionId = ctx.sessionManager.getSessionId();
			const { error } = crew.respond(
				params.subagent_id,
				params.message,
				callerSessionId,
			);
			if (error) return toolError(error);

			return toolSuccess(
				`Message sent to subagent ${params.subagent_id}. Response will be delivered as a steering message.`,
				{ id: params.subagent_id, message: params.message },
			);
		},

		renderCall(args, theme, _context) {
			return renderCrewCall(
				theme,
				"crew_respond",
				args.subagent_id || "...",
				args.message,
			);
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});
}
