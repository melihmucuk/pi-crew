export type CrewActionResult =
	| { action: "spawn"; subagent_id: string; name: string }
	| { action: "respond" | "done"; subagent_id: string }
	| { action: "abort"; aborted_ids: string[]; missing_ids: string[]; foreign_ids: string[] };

export function formatAbortResult(result: Omit<Extract<CrewActionResult, { action: "abort" }>, "action">): string {
	return [
		...(result.aborted_ids.length ? [`Aborted ${result.aborted_ids.length} subagent(s): ${result.aborted_ids.join(", ")}`] : []),
		...(result.missing_ids.length ? [`Not found or already finished: ${result.missing_ids.join(", ")}`] : []),
		...(result.foreign_ids.length ? [`Belong to a different session: ${result.foreign_ids.join(", ")}`] : []),
	].join("\n");
}

/** SDK-generated failures may remain plain text; only unwrap our JSON errors. */
export function toolErrorText(content: string): string {
	try {
		const result = JSON.parse(content);
		if (typeof result?.error === "string") return result.error;
	} catch {
		// Pi's own validation and execution errors are outside our output contract.
	}
	return content;
}

/** Throw serialized errors so Pi retains isError while the model receives JSON. */
export function jsonToolError(error: unknown): Error {
	return new Error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
