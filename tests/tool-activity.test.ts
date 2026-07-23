import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeInline, summarizeToolTarget } from "../extension/tool-activity.js";

describe("subagent tool activity summaries", () => {
	it("prefers useful path-like arguments and removes control sequences", () => {
		assert.equal(summarizeToolTarget("read", { path: "\u001b[31msrc/index.ts\u001b[0m\nignored" }), "src/index.ts ignored");
		assert.equal(summarizeToolTarget("web_search", { query: "pi widget API" }), "pi widget API");
	});

	it("summarizes compound bash commands and redacts sensitive assignments", () => {
		assert.equal(
			summarizeToolTarget("bash", { command: "API_TOKEN=secret npm test && npm run typecheck" }),
			"npm test · 2 steps",
		);
		assert.equal(summarizeToolTarget("bash", { command: "printf 'a && b'" }), "printf");
	});

	it("does not expose sensitive fallback, flag, header, or URL values", () => {
		assert.equal(summarizeToolTarget("custom", { apiKey: "secret" }), "");
		assert.equal(summarizeToolTarget("bash", { command: "deploy --api-key topsecret" }), "deploy");
		assert.equal(
			summarizeToolTarget("bash", { command: 'curl -H "Authorization: Bearer topsecret" "https://user:pass@example.com/hook?token=secret"' }),
			"curl https://example.com/hook",
		);
		assert.equal(summarizeToolTarget("bash", { command: "echo topsecret" }), "echo");
		assert.equal(summarizeToolTarget("web_extract", { url: "https://example.com/file?signature=secret" }), "https://example.com/file");
		assert.equal(sanitizeInline("hello\u0000\nworld"), "hello world");
	});
});
