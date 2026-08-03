import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCrewTask, validateCrewTask } from "../extension/task.js";

describe("structured crew tasks", () => {
	it("formats goal, isolated context, and ordered instructions without rewriting their content", () => {
		const approvedPlan = "Implement the approved plan exactly:\n\n# Plan\n\n1. Update `src/auth.ts`.";
		const prompt = formatCrewTask({
			goal: "The approved authentication change is implemented.",
			context: ["The user approved refresh-token rotation."],
			instructions: [approvedPlan, "Run the relevant tests."],
		});

		assert.equal(prompt, [
			"## Goal",
			"",
			"The approved authentication change is implemented.",
			"",
			"## Context",
			"",
			"- The user approved refresh-token rotation.",
			"",
			"## Instructions",
			"",
			`1. ${approvedPlan}`,
			"2. Run the relevant tests.",
		].join("\n"));
	});

	it("renders an explicit empty context and rejects blank task fields", () => {
		const task = {
			goal: "Inspect the requested area.",
			context: [],
			instructions: ["Inspect the relevant code."],
		};
		assert.match(formatCrewTask(task), /## Context\n\nNone\./);
		assert.doesNotThrow(() => validateCrewTask(task));
		assert.throws(
			() => validateCrewTask({ ...task, context: [" "] }),
			/task\.context must be an array of non-empty strings/,
		);
	});
});
