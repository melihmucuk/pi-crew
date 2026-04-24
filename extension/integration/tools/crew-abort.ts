import { Type } from "typebox";
import {
	renderCrewCall,
	renderCrewResult,
	toolError,
	toolSuccess,
} from "../tool-presentation.js";
import type { CrewToolDeps } from "./tool-deps.js";

function formatAbortToolMessage(result: {
	abortedIds: string[];
	missingIds: string[];
	foreignIds: string[];
}): string {
	const parts: string[] = [];

	if (result.abortedIds.length > 0) {
		parts.push(`Aborted ${result.abortedIds.length} subagent(s): ${result.abortedIds.join(", ")}`);
	}
	if (result.missingIds.length > 0) {
		parts.push(`Not found or already finished: ${result.missingIds.join(", ")}`);
	}
	if (result.foreignIds.length > 0) {
		parts.push(`Belong to a different session: ${result.foreignIds.join(", ")}`);
	}

	return parts.join("\n");
}

export function registerCrewAbortTool({ pi, crew }: CrewToolDeps): void {
	pi.registerTool({
		name: "crew_abort",
		label: "Abort Crew",
		description:
			"Abort one, many, or all active subagents owned by the current session.",
		parameters: Type.Object({
			subagent_id: Type.Optional(
				Type.String({ description: "Single subagent ID to abort" }),
			),
			subagent_ids: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					description: "Multiple subagent IDs to abort",
				}),
			),
			all: Type.Optional(
				Type.Boolean({
					description: "Abort all active subagents owned by the current session",
				}),
			),
		}),
		promptSnippet: "Abort one, many, or all active subagents from this session.",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const callerSessionId = ctx.sessionManager.getSessionId();
			const modeCount = Number(Boolean(params.subagent_id))
				+ Number(Boolean(params.subagent_ids?.length))
				+ Number(params.all === true);

			if (modeCount !== 1) {
				return toolError(
					"Provide exactly one of: subagent_id, subagent_ids, or all=true.",
				);
			}

			if (params.all) {
				const abortedIds = crew.abortAllOwned(callerSessionId, {
					reason: "Aborted by tool request",
				});
				if (abortedIds.length === 0) {
					return toolError("No active subagents in the current session.");
				}

				return toolSuccess(
					`Aborted ${abortedIds.length} subagent(s): ${abortedIds.join(", ")}`,
					{ ids: abortedIds },
					{ terminate: true },
				);
			}

			const ids = params.subagent_id
				? [params.subagent_id]
				: (params.subagent_ids ?? []);
			const result = crew.abortOwned(ids, callerSessionId, {
				reason: "Aborted by tool request",
			});
			const message = formatAbortToolMessage(result);

			if (result.abortedIds.length === 0) {
				return toolError(message || "No subagents were aborted.");
			}

			return toolSuccess(
				message,
				{
					ids: result.abortedIds,
					missing_ids: result.missingIds,
					foreign_ids: result.foreignIds,
				},
				{ terminate: true },
			);
		},

		renderCall(args, theme, _context) {
			if (args.all) {
				return renderCrewCall(theme, "crew_abort", "all");
			}

			if (args.subagent_id) {
				return renderCrewCall(theme, "crew_abort", args.subagent_id);
			}

			const count = Array.isArray(args.subagent_ids) ? args.subagent_ids.length : 0;
			return renderCrewCall(theme, "crew_abort", `${count} ids`);
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});
}
