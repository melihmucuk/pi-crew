import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPiCrewExtension } from "../extension/index.js";
import type { ActiveRuntimeBinding } from "../extension/crew.js";

interface RegisteredHandlers {
	session_start?: (event: unknown, ctx: ExtensionContextStub) => void;
	session_shutdown?: (event: { reason: string }, ctx: ExtensionContextStub) => void;
}

interface ExtensionContextStub {
	cwd: string;
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	isIdle: () => boolean;
	model: undefined;
	modelRegistry: unknown;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => string | undefined;
	};
	ui: { notify: () => void; setWidget: () => void };
}

class FakeCrew {
	activated: ActiveRuntimeBinding[] = [];
	deactivated: string[] = [];
	abortCount = 0;

	activateSession(binding: ActiveRuntimeBinding): void {
		this.activated.push(binding);
	}

	deactivateSession(sessionId: string): void {
		this.deactivated.push(sessionId);
	}

	abortAll(): void {
		this.abortCount++;
	}

	getActiveSummariesForOwner(): [] {
		return [];
	}
}

class FakeProcessHooks {
	sigintHandlers: Array<() => void> = [];
	beforeExitHandlers: Array<() => void> = [];
	exitCodes: number[] = [];

	once(event: "SIGINT", listener: () => void): void {
		assert.equal(event, "SIGINT");
		this.sigintHandlers.push(listener);
	}

	on(event: "beforeExit", listener: () => void): void {
		assert.equal(event, "beforeExit");
		this.beforeExitHandlers.push(listener);
	}

	exit(code?: number): never {
		this.exitCodes.push(code ?? 0);
		throw new Error("process exit");
	}
}

function setup(setupKey = Symbol("pi-crew-test-hooks")) {
	const handlers: RegisteredHandlers = {};
	const shortcuts: Array<{ key: string; description: string }> = [];
	const crew = new FakeCrew();
	const processHooks = new FakeProcessHooks();
	const pi = {
		on(name: keyof RegisteredHandlers, handler: RegisteredHandlers[typeof name]) {
			handlers[name] = handler as never;
		},
		registerTool() {},
		registerMessageRenderer() {},
		registerShortcut(key: string, options: { description: string }) {
			shortcuts.push({ key, description: options.description });
		},
		sendMessage() {},
	};

	registerPiCrewExtension(pi as never, {
		crew: crew as never,
		processHooks,
		processHooksSetupKey: setupKey,
		extensionDir: "/pkg/extension",
	});

	return { crew, handlers, pi, processHooks, shortcuts };
}

function context(sessionId = "owner-1", sessionFile?: string): ExtensionContextStub {
	return {
		cwd: "/repo",
		hasUI: false,
		mode: "json",
		isIdle: () => true,
		model: undefined,
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		ui: { notify() {}, setWidget() {} },
	};
}

describe("extension lifecycle wiring", () => {
	it("registers an unused Pi shortcut for expanding widget tool calls", () => {
		const { shortcuts } = setup();

		assert.deepEqual(shortcuts, [{
			key: "ctrl+shift+e",
			description: "Toggle latest three or ten subagent tool calls",
		}]);
	});

	it("activates sessions with getSessionId ownership", () => {
		const { crew, handlers } = setup();

		handlers.session_start?.({}, context("owner-1", undefined));

		assert.equal(crew.activated.length, 1);
		assert.equal(crew.activated[0]?.sessionId, "owner-1");
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

	it("registers process cleanup hooks once per setup key", () => {
		const setupKey = Symbol("shared-test-hooks");
		const first = setup(setupKey);
		const second = setup(setupKey);

		assert.equal(first.processHooks.sigintHandlers.length, 1);
		assert.equal(first.processHooks.beforeExitHandlers.length, 1);
		assert.equal(second.processHooks.sigintHandlers.length, 0);
		assert.equal(second.processHooks.beforeExitHandlers.length, 0);
	});

	it("process cleanup aborts subagents on beforeExit and SIGINT", () => {
		const { crew, processHooks } = setup();

		processHooks.beforeExitHandlers[0]?.();
		assert.equal(crew.abortCount, 1);

		assert.throws(() => processHooks.sigintHandlers[0]?.(), /process exit/);
		assert.equal(crew.abortCount, 2);
		assert.deepEqual(processHooks.exitCodes, [130]);
	});
});
