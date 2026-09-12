import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import type { AssistantMessage, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const SUBAGENT_OUTCOME = {
	completed: "completed",
	needsInput: "needs_input",
} as const;

export type SubagentResult =
	| { outcome: typeof SUBAGENT_OUTCOME.completed; report: string }
	| { outcome: typeof SUBAGENT_OUTCOME.needsInput; report: string; needs: string };

export const CREW_REPORT_TOOL_NAME = "crew_report";
export const CREW_REPORT_REMINDER =
	"Finalize this task now. Put your complete role-specific final answer directly in a single crew_report call. Preserve its Markdown and do not create a separate summary. Your final batch must contain only that one crew_report call.";

export const CREW_REPORT_CONTRACT_ERROR =
	"Subagent result contract violated: no valid final crew_report call was produced after one reminder";

const crewReportSchema = Type.Object({
	outcome: StringEnum([SUBAGENT_OUTCOME.completed, SUBAGENT_OUTCOME.needsInput] as const),
	report: Type.String({ minLength: 1 }),
	needs: Type.Optional(Type.String()),
}, { additionalProperties: false });

type CrewReportArgs = Static<typeof crewReportSchema>;

function validateReportArgs(params: CrewReportArgs): SubagentResult {
	if (params.report.trim().length === 0) {
		throw new Error("crew_report report must be non-blank");
	}
	if (params.outcome === SUBAGENT_OUTCOME.needsInput) {
		if (params.needs === undefined || params.needs.trim().length === 0) {
			throw new Error("crew_report needs must be non-blank when outcome is needs_input");
		}
		return { outcome: params.outcome, report: params.report, needs: params.needs };
	}
	if (params.needs !== undefined) {
		throw new Error("crew_report needs is not allowed when outcome is completed");
	}
	return { outcome: params.outcome, report: params.report };
}

export function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

export function createCrewReportTool(): ReturnType<typeof defineTool> {
	return defineTool({
		name: CREW_REPORT_TOOL_NAME,
		label: "Crew Report",
		description:
			"Submit the final subagent result. The report is your complete role-specific final answer, not an additional summary. Write it directly in the tool argument and preserve its Markdown. Use outcome completed when the task is finished, or needs_input when owner input is required.",
		promptSnippet: "Submit the complete role-specific final answer as the terminating result",
		promptGuidelines: [
			"Use task tools in earlier batches as needed, then make the final batch contain exactly one crew_report call and no other tool calls.",
			"Write the complete role-specific final answer directly in crew_report.report, preserve its Markdown, and do not emit an additional summary.",
		],
		parameters: crewReportSchema,
		async execute(_toolCallId, params) {
			const result = validateReportArgs(params);
			return {
				content: [{ type: "text" as const, text: "Final subagent report recorded." }],
				details: result,
				terminate: true,
			};
		},
	});
}

/** Mirrors the SDK argument normalization the tool executor applies before `execute`. */
const crewReportValidationTool: Tool = {
	name: CREW_REPORT_TOOL_NAME,
	description: "",
	parameters: crewReportSchema,
};

/**
 * Returns the result of the cycle's terminating `crew_report` call, or undefined when the
 * cycle did not end in exactly one successful `crew_report` call.
 */
export function findAcceptedReport(cycleMessages: AgentMessage[]): SubagentResult | undefined {
	const lastAssistant = getLastAssistantMessage(cycleMessages);
	if (!lastAssistant) return undefined;

	const toolCalls = lastAssistant.content.filter((part): part is ToolCall => part.type === "toolCall");
	if (toolCalls.length !== 1) return undefined;
	const toolCall = toolCalls[0];
	if (toolCall.name !== CREW_REPORT_TOOL_NAME) return undefined;

	const toolResult = cycleMessages.find((message): message is ToolResultMessage =>
		message.role === "toolResult" && message.toolCallId === toolCall.id
	);
	if (!toolResult || toolResult.isError || toolResult.toolName !== CREW_REPORT_TOOL_NAME) return undefined;

	try {
		return validateReportArgs(validateToolArguments(crewReportValidationTool, toolCall));
	} catch {
		return undefined;
	}
}
