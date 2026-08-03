import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";

const NonBlankStringSchema = Type.String({ minLength: 1, pattern: "\\S" });

export const CrewTaskSchema = Type.Object(
	{
		goal: Type.String({
			...NonBlankStringSchema,
			description: "The required end result. Describe what success looks like, not the steps or background.",
		}),
		context: Type.Array(NonBlankStringSchema, {
			description: "Task-relevant owner-session facts unavailable to the isolated subagent. Include user intent, decisions, constraints, and prior findings that must carry forward. Exclude actions and repo-discoverable facts unless they are prior findings being handed off. Use an empty array when none is needed.",
		}),
		instructions: Type.Array(NonBlankStringSchema, {
			minItems: 1,
			description: "Concrete task-specific actions to achieve the goal, ordered when needed. Include approved plans verbatim or reference their source file. Do not repeat context or the subagent's generic rules.",
		}),
	},
	{
		additionalProperties: false,
		description: "A complete, self-contained assignment for an isolated subagent.",
	},
);

export type CrewTask = Static<typeof CrewTaskSchema>;

export function validateCrewTask(task: unknown): asserts task is CrewTask {
	const [error] = Errors(CrewTaskSchema, task);
	if (!error) return;

	const field = error.instancePath.split("/")[1];
	if (field === "goal") throw new Error("task.goal is required and must not be empty.");
	if (field === "context") throw new Error("task.context must be an array of non-empty strings.");
	if (field === "instructions") throw new Error("task.instructions must contain at least one non-empty string.");
	throw new Error("task is required and must be a structured assignment.");
}

function formatContext(items: string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

function formatInstructions(items: string[]): string {
	return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function formatCrewTask(task: CrewTask): string {
	return [
		"## Goal",
		"",
		task.goal,
		"",
		"## Context",
		"",
		task.context.length > 0 ? formatContext(task.context) : "None.",
		"",
		"## Instructions",
		"",
		formatInstructions(task.instructions),
	].join("\n");
}
