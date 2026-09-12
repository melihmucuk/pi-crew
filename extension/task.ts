import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";

const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const CrewTaskSchema = Type.Object(
	{
		goal: Type.String({
			...NonEmptyStringSchema,
			description: "The finished state in one or two sentences, including how completion is recognized. No steps, no background.",
		}),
		context: Type.Array(NonEmptyStringSchema, {
			description: "Facts the subagent cannot find in the repository: user decisions, approved scope, prior findings. User decisions and approved scope are binding. Put actions and execution constraints in instructions. Empty array when none.",
		}),
		instructions: Type.Array(NonEmptyStringSchema, {
			minItems: 1,
			description: "One action or one constraint per item, ordered. Prohibitions as explicit \"Do not ...\" items. Last item states when to stop and report. Approved plan steps verbatim, or by path when they live in a file.",
		}),
	},
	{
		additionalProperties: false,
		description: "A self-contained assignment. The subagent sees only this, the repository, and its own definition.",
	},
);

export type CrewTask = Static<typeof CrewTaskSchema>;

function throwCrewTaskValidationError(field?: string): never {
	if (field === "goal") throw new Error("task.goal is required and must not be empty.");
	if (field === "context") throw new Error("task.context must be an array of non-empty strings.");
	if (field === "instructions") throw new Error("task.instructions must contain at least one non-empty string.");
	throw new Error("task is required and must be a structured assignment.");
}

export function validateCrewTask(task: unknown): asserts task is CrewTask {
	const [error] = Errors(CrewTaskSchema, task);
	if (error) throwCrewTaskValidationError(error.instancePath.split("/")[1]);

	const candidate = task as CrewTask;
	if (!/\S/u.test(candidate.goal)) throwCrewTaskValidationError("goal");
	if (candidate.context.some((item) => !/\S/u.test(item))) {
		throwCrewTaskValidationError("context");
	}
	if (candidate.instructions.some((item) => !/\S/u.test(item))) {
		throwCrewTaskValidationError("instructions");
	}
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
