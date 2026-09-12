import { it } from "node:test";
import assert from "node:assert/strict";
import type { SubagentSettlement } from "../extension/subagent-status.js";

it("binds lifecycle status to the matching result or error shape", () => {
	const completed = {
		status: "completed",
		result: { outcome: "completed", report: "done" },
	} satisfies SubagentSettlement;

	const mismatchedResult: SubagentSettlement = {
		status: "completed",
		// @ts-expect-error completed cannot carry a needs_input result
		result: { outcome: "needs_input", report: "blocked", needs: "choose" },
	};
	// @ts-expect-error successful settlements cannot carry an error
	const successWithError: SubagentSettlement = {
		status: "completed",
		result: { outcome: "completed", report: "done" },
		error: "impossible",
	};
	const errorWithResult: SubagentSettlement = {
		status: "error",
		error: "failed",
		// @ts-expect-error error settlements cannot carry a successful result
		result: { outcome: "completed", report: "done" },
	};

	assert.equal(completed.status, "completed");
	void mismatchedResult;
	void successWithError;
	void errorWithResult;
});
