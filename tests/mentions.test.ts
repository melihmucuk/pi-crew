import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../extension/catalog.js";
import {
	createCrewMentionProvider,
	expandCrewMentions,
	expandCrewMentionsInMessages,
} from "../extension/mentions.js";

function agent(name: string, description: string): AgentConfig {
	return {
		name,
		description,
		systemPrompt: `${name} prompt`,
		filePath: `/agents/${name}.md`,
	};
}

function currentProvider(options: {
	items?: AutocompleteItem[];
	prefix?: string;
	triggerCharacters?: string[];
} = {}): AutocompleteProvider & {
	appliedPrefixes: string[];
	applyCalls: number;
	suggestionCalls: number;
} {
	return {
		appliedPrefixes: [],
		applyCalls: 0,
		suggestionCalls: 0,
		triggerCharacters: options.triggerCharacters,
		async getSuggestions() {
			this.suggestionCalls++;
			return options.items
				? { items: options.items, prefix: options.prefix ?? "@" }
				: null;
		},
		applyCompletion(lines, cursorLine, cursorCol, _item, prefix) {
			this.applyCalls++;
			this.appliedPrefixes.push(prefix);
			return { lines: [...lines, "delegated"], cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion() {
			return false;
		},
	};
}

const signal = new AbortController().signal;

describe("crew mentions", () => {
	it("mixes subagents with native @ file suggestions and inserts a mention mid-sentence", async () => {
		const nativeItem = { value: "@src/api.ts", label: "api.ts", description: "src/api.ts" };
		const current = currentProvider({ items: [nativeItem], prefix: "native-prefix" });
		const provider = createCrewMentionProvider(current, () => [
			agent("scout", "Inspect relevant code"),
			agent("worker", "Implement a scoped change"),
			agent("code_reviewer", "Unsupported inline name"),
			agent("scout.v2", "Unsupported inline name"),
			agent("scöut", "Unsupported inline name"),
		]);
		const lines = ["Ask @ to inspect this"];
		const cursorCol = "Ask @".length;

		const suggestions = await provider.getSuggestions(lines, 0, cursorCol, { signal });

		assert.equal(suggestions?.prefix, "@");
		assert.equal(suggestions?.items[0]?.value, "@crew:scout");
		assert.ok(suggestions?.items.some((item) => item.value === "@src/api.ts"));
		assert.ok(!suggestions?.items.some((item) => item.value === "@crew:code_reviewer"));
		assert.ok(!suggestions?.items.some((item) => item.value === "@crew:scout.v2"));
		assert.ok(!suggestions?.items.some((item) => item.value === "@crew:scöut"));
		assert.equal(suggestions?.items[0]?.description, "Inspect relevant code");

		const completed = provider.applyCompletion(lines, 0, cursorCol, suggestions!.items[0]!, suggestions!.prefix);
		assert.deepEqual(completed.lines, ["Ask @crew:scout to inspect this"]);
		assert.equal(completed.cursorCol, "Ask @crew:scout".length);

		const nativeCompleted = provider.applyCompletion(lines, 0, cursorCol, nativeItem, suggestions!.prefix);
		assert.deepEqual(nativeCompleted.lines, [...lines, "delegated"]);
		assert.equal(current.applyCalls, 1);
		assert.deepEqual(current.appliedPrefixes, ["native-prefix"]);
	});

	it("matches only subagent names while preserving descriptions and native file suggestions", async () => {
		const nativeItem = { value: "@extension/catalog.ts", label: "catalog.ts" };
		const current = currentProvider({ items: [nativeItem], prefix: "@catalog" });
		const provider = createCrewMentionProvider(current, () => [
			agent("scout", "Inspect the catalog"),
			agent("worker", "Implement catalog changes"),
		]);

		const files = await provider.getSuggestions(["@catalog"], 0, 8, { signal });
		assert.deepEqual(files, { items: [nativeItem], prefix: "@catalog" });

		for (const query of ["@scout", "@crew:scout"]) {
			const suggestions = await provider.getSuggestions([query], 0, query.length, { signal });
			assert.deepEqual(suggestions?.items, [
				{ value: "@crew:scout", label: "@crew:scout", description: "Inspect the catalog" },
				nativeItem,
			]);
		}
	});

	it("preserves other providers' triggers, delegation, and file-completion policy", async () => {
		const current = currentProvider({ triggerCharacters: ["$", "#"] });
		const provider = createCrewMentionProvider(current, () => [agent("scout", "Inspect code")]);

		assert.deepEqual(provider.triggerCharacters, ["$", "#", "@"]);
		assert.equal(await provider.getSuggestions(["Use $fal"], 0, 8, { signal }), null);
		assert.equal(current.suggestionCalls, 1);
		assert.equal(provider.shouldTriggerFileCompletion?.([""], 0, 0), false);
	});

	it("suggests subagents discovered after the provider was created", async () => {
		let agents = [agent("scout", "Inspect relevant code")];
		let supplierCalls = 0;
		const provider = createCrewMentionProvider(currentProvider(), () => {
			supplierCalls++;
			return agents;
		});

		assert.equal(await provider.getSuggestions(["Use $fal"], 0, 8, { signal }), null);
		assert.equal(supplierCalls, 0);

		const before = await provider.getSuggestions(["Ask @"], 0, 5, { signal });
		assert.deepEqual(before?.items.map((item) => item.value), ["@crew:scout"]);

		agents = [...agents, agent("auditor", "Added after session start")];
		const after = await provider.getSuggestions(["Ask @"], 0, 5, { signal });
		assert.deepEqual(after?.items.map((item) => item.value), ["@crew:scout", "@crew:auditor"]);
	});

	it("expands mentions at quote and Markdown backtick boundaries without consulting a catalog", () => {
		assert.equal(
			expandCrewMentions('Ask "@crew:missing", then `@crew:scout`.'),
			'Ask "<pi-crew subagent="missing" />", then `<pi-crew subagent="scout" />`.',
		);
	});

	it("does not partially expand unsupported explicit names", () => {
		assert.equal(expandCrewMentions("Ask @crew:code_reviewer to inspect"), undefined);
		assert.equal(expandCrewMentions("Ask @crew:scout.v2 to inspect"), undefined);
		assert.equal(expandCrewMentions("Ask @crew:scöut to inspect"), undefined);
		assert.equal(
			expandCrewMentions('Ask "@crew:scout.v2" or `@crew:code_reviewer`.'),
			undefined,
		);
		assert.equal(
			expandCrewMentions("Ask @crew:scout, not @crew:scout.v2."),
			'Ask <pi-crew subagent="scout" />, not @crew:scout.v2.',
		);
	});

	it("changes only model-bound user text while leaving stored input and images unchanged", () => {
		const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
		const storedMessages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Have @crew:oracle assess this image" },
					image,
					{ type: "text", text: "and @crew:worker implement the result" },
				],
				timestamp: 1,
			},
		];
		const original = structuredClone(storedMessages);

		const transformed = expandCrewMentionsInMessages(storedMessages);

		assert.deepEqual(storedMessages, original);
		assert.notEqual(transformed?.messages, storedMessages);
		const content = transformed?.messages[0]?.role === "user"
			? transformed.messages[0].content
			: undefined;
		assert.ok(Array.isArray(content));
		assert.equal(content[0]?.type === "text" ? content[0].text : undefined, 'Have <pi-crew subagent="oracle" /> assess this image');
		assert.equal(content[1], image);
		assert.equal(content[2]?.type === "text" ? content[2].text : undefined, 'and <pi-crew subagent="worker" /> implement the result');
	});
});
