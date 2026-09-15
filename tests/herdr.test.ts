import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerHerdrMetadata } from "../extension/herdr.js";

const herdrEnv = {
	HERDR_ENV: "1",
	HERDR_PANE_ID: "w1:p2",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	HERDR_BIN_PATH: "/bin/herdr",
};

function setup(env: NodeJS.ProcessEnv = herdrEnv, initialCount = 0) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const calls: Array<{ binary: string; args: string[] }> = [];
	let listener: ((count: number) => void) | undefined;
	let subscriptions = 0;
	let fail = false;
	let gate: Promise<void> | undefined;
	const pi = {
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
		exec: async (binary: string, args: string[]) => {
			calls.push({ binary, args });
			await gate;
			if (fail) throw new Error("Herdr unavailable");
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};
	const crew = {
		observeRunningCount(callback: (count: number) => void) {
			subscriptions++;
			listener = callback;
			callback(initialCount);
			return () => { listener = undefined; };
		},
	};
	registerHerdrMetadata(pi as never, crew as never, env);
	return {
		handlers, calls,
		start: (mode = "tui") => handlers.get("session_start")?.({}, { mode }),
		stop: () => handlers.get("session_shutdown")?.(),
		update: (count: number) => listener?.(count),
		subscriptions: () => subscriptions,
		fail: () => { fail = true; },
		hold: () => {
			let release: () => void;
			gate = new Promise<void>((resolve) => { release = resolve; });
			return () => { gate = undefined; release(); };
		},
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Herdr sidebar metadata", () => {
	it("does not register or report outside a complete Herdr environment", () => {
		for (const env of [{}, { ...herdrEnv, HERDR_ENV: "0" },
			{ ...herdrEnv, HERDR_PANE_ID: "" }, { ...herdrEnv, HERDR_SOCKET_PATH: "" }]) {
			const host = setup(env);
			host.start();
			assert.equal(host.handlers.size, 0);
			assert.equal(host.subscriptions(), 0);
			assert.deepEqual(host.calls, []);
		}
	});

	it("ignores headless sessions even when they inherit Herdr variables", () => {
		const host = setup();
		for (const mode of ["rpc", "json", "print"]) host.start(mode);
		assert.equal(host.subscriptions(), 0);
		assert.deepEqual(host.calls, []);
	});

	it("reports only count changes and clears its display override without reporting lifecycle state", async () => {
		const host = setup();
		host.start();
		host.update(1);
		await flush();
		host.update(1);
		host.update(2);
		await flush();
		host.update(0);
		await host.stop();
		assert.equal(host.calls.length, 3);
		assert.ok(host.calls[0]!.args.includes("pi · 1 subagent"));
		assert.ok(host.calls[1]!.args.includes("pi · 2 subagents"));
		assert.ok(host.calls[2]!.args.includes("--clear-display-agent"));
		for (const call of host.calls) {
			assert.equal(call.binary, "/bin/herdr");
			assert.deepEqual(call.args.slice(0, 3), ["pane", "report-metadata", "w1:p2"]);
			assert.ok(call.args.includes("custom:pi-crew"));
			assert.ok(!call.args.includes("--state"));
			assert.ok(!call.args.includes("--title"));
		}
	});

	it("coalesces changes during a slow report and sends only the latest count next", async () => {
		const host = setup();
		const release = host.hold();
		host.start();
		host.update(1);
		await flush();
		host.update(2);
		host.update(3);
		host.update(4);
		await flush();
		assert.equal(host.calls.length, 1, "reports must not overlap");
		release();
		await flush();
		assert.equal(host.calls.length, 2);
		assert.ok(host.calls[1]!.args.includes("pi · 4 subagents"));
		await host.stop();
	});

	it("replaces queued counts with a final clear on shutdown during a slow report", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const host = setup();
		const release = host.hold();
		host.start();
		host.update(1);
		await flush();
		for (let count = 2; count <= 20; count++) host.update(count);
		let stopped = false;
		const shutdown = Promise.resolve(host.stop()).then(() => { stopped = true; });
		host.update(21);
		t.mock.timers.tick(60_000);
		await flush();
		assert.equal(stopped, false);
		assert.equal(host.calls.length, 1);
		release();
		await shutdown;
		assert.equal(host.calls.length, 2, "shutdown waits only for the in-flight report and clear");
		assert.ok(host.calls[1]!.args.includes("--clear-display-agent"));
		t.mock.timers.tick(60_000);
		await flush();
		assert.equal(host.calls.length, 2, "shutdown stops renewals");
	});

	it("snapshots preserved work on activation and detaches on shutdown", async () => {
		const host = setup(herdrEnv, 2);
		host.start();
		await flush();
		assert.ok(host.calls[0]!.args.includes("pi · 2 subagents"));
		await host.stop();
		host.update(3);
		await flush();
		assert.equal(host.calls.length, 2);
		assert.ok(host.calls[1]!.args.includes("--clear-display-agent"));
	});

	it("renews the label only while children run and stops renewal at zero", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const host = setup(herdrEnv, 1);
		host.start();
		await flush();
		t.mock.timers.tick(30_000);
		await flush();
		assert.equal(host.calls.length, 2);
		assert.ok(host.calls[1]!.args.includes("--ttl-ms"));
		host.update(0);
		await flush();
		t.mock.timers.tick(60_000);
		await host.stop();
		assert.equal(host.calls.length, 3);
	});

	it("does not let reporting failures break updates or shutdown", async () => {
		const host = setup();
		host.fail();
		host.start();
		host.update(1);
		await flush();
		await host.stop();
		assert.equal(host.calls.length, 2);
	});
});
