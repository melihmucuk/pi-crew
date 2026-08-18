import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeInline,
	summarizeToolName,
	summarizeToolRequest,
	summarizeToolResult,
	summarizeToolTarget,
} from "../extension/tool-activity.js";

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

	it("adds tool-specific targets and safe result summaries", () => {
		assert.equal(summarizeToolTarget("read", { path: "/Users/test/project/src/index.ts", offset: 20, limit: 3 }), "/Users/test/project/src/index.ts:20-22");
		assert.equal(summarizeToolTarget("grep", { pattern: "widget", path: "extension", glob: "*.ts" }), "/widget/ in extension (*.ts)");
		assert.equal(summarizeToolName("read", { path: "/tmp/pi-crew/SKILL.md" }), "skill");
		assert.equal(summarizeToolTarget("read", { path: "/tmp/pi-crew/SKILL.md" }), "pi-crew");
		assert.equal(summarizeToolRequest("write", { content: "one\ntwo\n" }), "2 lines written");
		assert.equal(summarizeToolRequest("write", { content: "one\r\ntwo" }), "2 lines written");
		assert.equal(summarizeToolRequest("edit", { edits: [{ oldText: "one\n", newText: "one\ntwo\n" }] }), "+2 −1 lines");
		assert.equal(summarizeToolResult("read", { content: [{ type: "text", text: "one\ntwo\n" }] }), "2 lines");
		assert.equal(summarizeToolResult("grep", { content: [{ type: "text", text: "a:1: first\n\nb:2: second\n" }] }), "2 matches");
		assert.equal(summarizeToolResult("grep", { content: [{ type: "text", text: "file-1- before\nfile:2: match\nfile-3- after\n" }] }), "1 match");
		assert.equal(summarizeToolResult("grep", { content: [{ type: "text", text: "No matches found" }] }), undefined);
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
