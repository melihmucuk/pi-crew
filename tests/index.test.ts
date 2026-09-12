import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { registerPiCrewExtension } from "../extension/index.js";
import type { ActiveAgentSummary, ActiveRuntimeBinding } from "../extension/crew.js";

interface RegisteredHandlers {
	context?: (event: { messages: AgentMessage[] }, ctx: ExtensionContextStub) => unknown;
	session_start?: (event: unknown, ctx: ExtensionContextStub) => void;
	session_shutdown?: (event: { reason: string }, ctx: ExtensionContextStub) => void;
}

interface ExtensionContextStub {
	cwd: string;
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	model: undefined;
	modelRegistry: unknown;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => string | undefined;
	};
	isProjectTrusted: () => boolean;
	ui: {
		addAutocompleteProvider: (factory: unknown) => void;
		notify: () => void;
		setWidget: (key?: string, factory?: unknown) => void;
	};
}

class FakeCrew {
	activated: ActiveRuntimeBinding[] = [];
	deactivated: string[] = [];
	adopted: Array<{ previousSessionFile: string; newSessionId: string; activationsBefore: number }> = [];
	abortCount = 0;

	activateSession(binding: ActiveRuntimeBinding, refreshWidget?: () => void): void {
		this.activated.push(binding);
		refreshWidget?.();
	}

	adoptSession(previousSessionFile: string, newSessionId: string): string[] {
		this.adopted.push({ previousSessionFile, newSessionId, activationsBefore: this.activated.length });
		return [];
	}

	deactivateSession(sessionId: string): void {
		this.deactivated.push(sessionId);
	}

	abortAll(): void {
		this.abortCount++;
	}

	summaries: ActiveAgentSummary[] = [];

	getActiveSummariesForOwner(): ActiveAgentSummary[] {
		return this.summaries;
	}
}

class FakeProcessHooks {
	beforeExitHandlers: Array<() => void> = [];
	signalEvents: string[] = [];

	once(event: string): void {
		this.signalEvents.push(event);
	}

	on(event: "beforeExit", listener: () => void): void {
		assert.equal(event, "beforeExit");
		this.beforeExitHandlers.push(listener);
	}
}

function setup(setupKey = Symbol("pi-crew-test-hooks")) {
	const handlers: RegisteredHandlers = {};
	const crew = new FakeCrew();
	const processHooks = new FakeProcessHooks();
	const pi = {
		on(name: keyof RegisteredHandlers, handler: RegisteredHandlers[typeof name]) {
			handlers[name] = handler as never;
		},
		registerTool() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerShortcut() {},
		sendMessage() {},
		appendEntry() {},
	};

	registerPiCrewExtension(pi as never, {
		crew: crew as never,
		processHooks,
		processHooksSetupKey: setupKey,
		extensionDir: "/pkg/extension",
	});

	return { crew, handlers, pi, processHooks };
}

function context(
	sessionId = "owner-1",
	sessionFile?: string,
	mode: ExtensionContextStub["mode"] = "json",
): ExtensionContextStub {
	return {
		cwd: "/repo",
		hasUI: false,
		mode,
		model: undefined,
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		isProjectTrusted: () => true,
		ui: {
			addAutocompleteProvider() {},
			notify() {},
			setWidget() {},
		},
	};
}

const widgetTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function widgetSummary(): ActiveAgentSummary {
	return {
		id: "scout-1234",
		agentName: "scout",
		brief: "inspect widget",
		status: "running",
		inputTokens: 12_400,
		outputTokens: 1_200,
		cost: 0.034,
		model: "model-x",
		modelName: undefined,
		thinking: "medium",
		toolCallCount: 1,
		toolFailureCount: 0,
		toolActivities: [{ id: "tool-1", name: "read", target: "README.md", status: "done", resultSummary: "33 lines" }],
		workedMs: 0,
	};
}

function tuiHostContext(cwd: string, widgets: Array<{ render(width: number): string[] }>): ExtensionContextStub {
	const ctx = context("owner-widget", undefined, "tui");
	ctx.cwd = cwd;
	ctx.ui.setWidget = (_key?: string, factory?: unknown) => {
		if (!factory) return;
		const build = factory as (tui: unknown, theme: Theme) => { render(width: number): string[] };
		widgets.push(build({ requestRender() {} }, widgetTheme));
	};
	return ctx;
}

describe("extension lifecycle wiring", () => {
	it("registers mention autocomplete only for TUI sessions", () => {
		const { handlers } = setup();
		let registrations = 0;
		const tuiContext = context("owner-tui", undefined, "tui");
		tuiContext.ui.addAutocompleteProvider = () => { registrations++; };

		handlers.session_start?.({}, tuiContext);
		handlers.session_start?.({}, context("owner-json"));

		assert.equal(registrations, 1);
	});

	it("expands mentions through the context hook without changing stored messages", () => {
		const { handlers } = setup();
		const messages: AgentMessage[] = [{ role: "user", content: "Ask @crew:scout to inspect", timestamp: 1 }];

		const result = handlers.context?.({ messages }, context()) as { messages: Array<{ content: string }> };

		const stored = messages[0];
		assert.ok(stored?.role === "user");
		assert.equal(stored.content, "Ask @crew:scout to inspect");
		assert.equal(result.messages[0]?.content, 'Ask <pi-crew subagent="scout" /> to inspect');
	});

	it("activates sessions with getSessionId ownership and both delivery bindings", () => {
		const { crew, handlers } = setup();

		handlers.session_start?.({}, context("owner-1", "/sessions/owner-1.jsonl"));

		assert.equal(crew.activated.length, 1);
		assert.equal(crew.activated[0]?.sessionId, "owner-1");
		assert.equal(crew.activated[0]?.sessionFile, "/sessions/owner-1.jsonl");
		assert.equal(typeof crew.activated[0]?.sendMessage, "function");
		assert.equal(typeof crew.activated[0]?.appendEntry, "function");
	});

	it("adopts the previous session's subagents on fork before activating, and only on fork", () => {
		const { crew, handlers } = setup();

		handlers.session_start?.(
			{ reason: "fork", previousSessionFile: "/sessions/owner-1.jsonl" },
			context("owner-2", "/sessions/owner-2.jsonl"),
		);

		assert.deepEqual(crew.adopted, [{
			previousSessionFile: "/sessions/owner-1.jsonl",
			newSessionId: "owner-2",
			activationsBefore: 0,
		}]);
		assert.equal(crew.activated.length, 1);

		handlers.session_start?.(
			{ reason: "resume", previousSessionFile: "/sessions/owner-2.jsonl" },
			context("owner-3", "/sessions/owner-3.jsonl"),
		);

		assert.equal(crew.adopted.length, 1);
		assert.equal(crew.activated.length, 2);
	});

	it("loads widget.showToolCalls from session config into the widget", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-crew-index-widget-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-crew.json"), JSON.stringify({ widget: { showToolCalls: false } }));

		initTheme("dark", false);
		const { crew, handlers } = setup();
		crew.summaries = [widgetSummary()];
		const widgets: Array<{ render(width: number): string[] }> = [];

		handlers.session_start?.({}, tuiHostContext(cwd, widgets));

		assert.equal(widgets.length, 1);
		const output = stripVTControlCharacters(widgets[0]!.render(200).join("\n"));
		assert.match(output, /scout-1234 - inspect widget/);
		assert.doesNotMatch(output, /read/);
		assert.doesNotMatch(output, /ctrl\+shift\+e/);
	});

	it("deactivates sessions for every shutdown reason", () => {
		const reasons = ["reload", "new", "resume", "fork", "quit"];
		const { crew, handlers } = setup();

		for (const reason of reasons) {
			handlers.session_shutdown?.({ reason }, context(`owner-${reason}`));
		}

		assert.deepEqual(crew.deactivated, reasons.map((reason) => `owner-${reason}`));
	});

	it("aborts only on quit shutdown", () => {
		const { crew, handlers } = setup();

		for (const reason of ["reload", "new", "resume", "fork"]) {
			handlers.session_shutdown?.({ reason }, context(`owner-${reason}`));
		}
		assert.equal(crew.abortCount, 0);

		handlers.session_shutdown?.({ reason: "quit" }, context("owner-quit"));
		assert.equal(crew.abortCount, 1);
	});

	it("process cleanup aborts subagents on beforeExit without taking over signals", () => {
		const { crew, processHooks } = setup();

		processHooks.beforeExitHandlers[0]?.();
		assert.equal(crew.abortCount, 1);
		assert.deepEqual(processHooks.signalEvents, []);
	});
});
