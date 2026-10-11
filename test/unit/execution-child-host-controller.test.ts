import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import type { Server, Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createChildHostController } from "../../src/execution-backend/child-host-controller.ts";
import { createMockPi } from "../support/mock-pi.ts";
import { PiRuntimeLaunchError } from "../../src/runs/shared/pi-spawn.ts";
import { PI_COHORT_CHILD_HOST_CONFIG } from "../../src/execution-backend/child-host-runtime.ts";
import { CHILD_HOST_PROTOCOL_VERSION, decodeChildHostFrames, encodeChildHostMessage } from "../../src/execution-backend/child-host-protocol.ts";
import type { ExecutionBackend } from "../../src/execution-backend/types.ts";

const backend: ExecutionBackend = {
	name: "test", protocolVersion: 1,
	async detect() { return { available: true, version: "1", capabilities: [] }; },
	async launch() { throw new Error("launch must not run"); },
	async reattach() { return { status: "gone" }; },
	async close() {},
};

const fixture = createMockPi();
fixture.install();
after(() => fixture.uninstall());
const runtime = fixture.runtime;
const testDependencies = { platform: "darwin" as const };

class FakeSocket extends EventEmitter {
	write(_data: string, callback?: (error?: Error | null) => void): boolean { callback?.(); return true; }
	end(): this { this.emit("close", false); return this; }
	destroy(): this { this.emit("close", false); return this; }
}

class FakeServer extends EventEmitter {
	private connectionListener: ((socket: Socket) => void) | undefined;

	setConnectionListener(listener: (socket: Socket) => void): void { this.connectionListener = listener; }
	listen(socketPath: string, callback?: () => void): this { fs.writeFileSync(socketPath, ""); callback?.(); return this; }
	close(callback?: (error?: Error) => void): this { callback?.(); return this; }
	connect(): FakeSocket {
		assert.ok(this.connectionListener, "fake server must receive the connection listener");
		const socket = new FakeSocket();
		this.connectionListener(socket as Socket);
		return socket;
	}
}

function fakeHostDependencies(): { server: FakeServer; dependencies: typeof testDependencies & { createServer: typeof import("node:net").createServer } } {
	const server = new FakeServer();
	return {
		server,
		dependencies: {
			...testDependencies,
			createServer: ((listener: (socket: Socket) => void) => {
				server.setConnectionListener(listener);
				return server as Server;
			}) as typeof import("node:net").createServer,
		},
	};
}

function connectFakeHost(server: FakeServer): FakeSocket {
	const socket = server.connect();
	socket.emit("data", encodeChildHostMessage({
		protocolVersion: CHILD_HOST_PROTOCOL_VERSION,
		kind: "host_ready",
		runId: "run",
		childId: "child",
	}));
	return socket;
}

function failingFileSystem(method: "chmodSync" | "openSync" | "writeFileSync"): { fileSystem: typeof fs; directory: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-fs-failure-"));
	fs.rmdirSync(directory);
	const fileSystem = { ...fs } as typeof fs;
	fileSystem.mkdtempSync = () => { fs.mkdirSync(directory); return directory; };
	fileSystem[method] = (() => { throw new Error(`injected ${method} failure`); }) as never;
	return { fileSystem, directory };
}

describe("execution child host controller setup", () => {
	it("boots with the selected root and Node, and rejects its missing jiti before launch", async () => {
		const mock = createMockPi();
		mock.install();
		const aborter = new AbortController();
		const { server, dependencies } = fakeHostDependencies();
		let launches = 0;
		try {
			const selectedBackend: ExecutionBackend = { ...backend, async launch(request) {
				launches++;
				assert.equal(request.command, mock.runtime.nodeExecPath);
				assert.equal(request.args[0], fs.realpathSync(path.join(mock.runtime.piPackageRoot, "node_modules/jiti/lib/jiti-cli.mjs")));
				return { handle: { protocolVersion: 1, backend: "test", surface: { kind: "test", id: "1" }, display: { label: "test", hint: "test" }, data: null }, events: { async *[Symbol.asyncIterator]() {} }, async reconcile() { return []; }, async release() {} };
			} };
			const options = { backend: selectedBackend, runtime: mock.runtime, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal };
			const controller = await createChildHostController(options, dependencies);
			connectFakeHost(server);
			await controller.ready;
			aborter.abort();
			let jitiChecks = 0;
			await assert.rejects(createChildHostController({ ...options, signal: new AbortController().signal }, {
				...dependencies,
				ensureJiti: root => { jitiChecks++; assert.equal(root, mock.runtime.piPackageRoot); return undefined; },
			}), error => {
				assert.ok(error instanceof PiRuntimeLaunchError);
				assert.match(error.message, /^jiti for selected Pi installation /);
				assert.ok(error.message.includes(mock.runtime.piPackageRoot));
				return true;
			});
			assert.equal(jitiChecks, 1);
			assert.equal(launches, 1);
		} finally { aborter.abort(); mock.uninstall(); }
	});
	it("rejects an unavailable selected Node before backend launch and removes private setup", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-missing-node-"));
		fs.rmdirSync(directory);
		const fileSystem = { ...fs, mkdtempSync: () => { fs.mkdirSync(directory); return directory; } } as typeof fs;
		const selectedNode = path.join(directory, "unavailable-node");
		let launches = 0;
		const selectedBackend = { ...backend, async launch() { launches++; throw new Error("unexpected backend launch"); } };
		const { dependencies } = fakeHostDependencies();
		await assert.rejects(createChildHostController(
			{ runtime: { ...runtime, nodeExecPath: selectedNode }, backend: selectedBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: new AbortController().signal },
			{ ...dependencies, fs: fileSystem },
		), error => error instanceof PiRuntimeLaunchError && error.message.includes(selectedNode));
		assert.equal(launches, 0);
		assert.equal(fs.existsSync(directory), false);
	});
	it("rejects win32 platform", async () => {
		await assert.rejects(
			createChildHostController({ runtime, backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: AbortSignal.timeout(1_000) }, { platform: "win32" }),
			/unsupported on win32/,
		);
	});

	it("does not create a directory or launch when already aborted", async () => {
		const aborter = new AbortController(); aborter.abort();
		await assert.rejects(
			createChildHostController({ runtime, backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal }, testDependencies),
			/launch aborted/,
		);
	});

	for (const method of ["chmodSync", "openSync", "writeFileSync"] as const) {
		it(`removes private setup artifacts when ${method} fails`, async () => {
			const { fileSystem, directory } = failingFileSystem(method);
			await assert.rejects(
				createChildHostController({ runtime, backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: AbortSignal.timeout(1_000) }, { fs: fileSystem, ...testDependencies }),
				new RegExp(`injected ${method} failure`),
			);
			assert.equal(fs.existsSync(directory), false);
		});
	}
});

describe("execution child host controller attempts", () => {
	it("maps a host spawn-error frame to the selected runtime error and permits cleanup", { timeout: 1_000 }, async () => {
		const aborter = new AbortController();
		const { server, dependencies } = fakeHostDependencies();
		let launches = 0;
		let releases = 0;
		let directory = "";
		const selectedRuntime = { ...runtime, nodeExecPath: "/selected/node", piEntryPath: "/selected/pi.js" };
		const selectedBackend: ExecutionBackend = { ...backend, async launch(request) {
			launches++;
			directory = path.dirname(request.environment[PI_COHORT_CHILD_HOST_CONFIG]);
			return { async release() { releases++; } };
		} };
		try {
			const controller = await createChildHostController(
				{ runtime: selectedRuntime, backend: selectedBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal },
				{ childHostCommand: () => ({ command: "echo", args: [] }), ...dependencies },
			);
			const socket = connectFakeHost(server);
			await controller.ready;
			const sent: string[] = [];
			socket.write = (data, callback) => { sent.push(data); callback?.(); return true; };
			const attempt = { attemptId: "attempt", command: selectedRuntime.nodeExecPath, args: [selectedRuntime.piEntryPath], cwd: os.tmpdir(), environment: {} };
			const pending = controller.startAttempt(attempt);
			const rejected = assert.rejects(pending, error => {
				assert.ok(error instanceof PiRuntimeLaunchError);
				assert.match(error.message, /spawn error/);
				assert.ok(error.message.includes(selectedRuntime.nodeExecPath));
				assert.ok(error.message.includes(selectedRuntime.piEntryPath));
				return true;
			});
			socket.emit("data", encodeChildHostMessage({ protocolVersion: CHILD_HOST_PROTOCOL_VERSION, kind: "attempt_spawn_error", runId: "run", childId: "child", attemptId: attempt.attemptId }));
			await rejected;
			assert.deepEqual(decodeChildHostFrames(sent.join("")).messages, [{ protocolVersion: CHILD_HOST_PROTOCOL_VERSION, kind: "start_attempt", runId: "run", childId: "child", ...attempt }]);
			await assert.rejects(controller.startAttempt(attempt), /attemptId has already been used/);
			assert.equal(fs.existsSync(directory), true);
			const shutdown = controller.shutdown();
			assert.equal(decodeChildHostFrames(sent[1]).messages[0].kind, "shutdown_host");
			socket.emit("data", encodeChildHostMessage({ protocolVersion: CHILD_HOST_PROTOCOL_VERSION, kind: "shutdown_ack", runId: "run", childId: "child" }));
			await shutdown;
			await Promise.all([controller.releaseObserver(), controller.releaseObserver()]);
			assert.equal(launches, 1);
			assert.equal(releases, 1);
			assert.equal(sent.length, 2);
			assert.equal(fs.existsSync(directory), false);
		} finally {
			aborter.abort();
		}
	});
});

describe("execution child host controller releaseObserver", () => {
	it("concurrent releaseObserver calls share the same release operation", async () => {
		const aborter = new AbortController();
		let releaseCallCount = 0;
		const releasingBackend: ExecutionBackend = {
			name: "test", protocolVersion: 1,
			async detect() { return { available: true, version: "1", capabilities: [] }; },
			async launch() {
				return {
					async release() { releaseCallCount++; },
				};
			},
			async reattach() { return { status: "gone" }; },
			async close() {},
		};

		try {
			const { server, dependencies } = fakeHostDependencies();
			const controller = await createChildHostController(
				{ runtime, backend: releasingBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal },
				{ childHostCommand: () => ({ command: "echo", args: [] }), ...dependencies },
			);
			connectFakeHost(server);
			await controller.ready;

			// Start two concurrent releaseObserver calls
			const release1 = controller.releaseObserver();
			const release2 = controller.releaseObserver();

			await Promise.all([release1, release2]);

			// Should have called release exactly once, not twice
			assert.equal(releaseCallCount, 1, "release() should be called exactly once for concurrent calls");
		} finally {
			aborter.abort();
		}
	});

	it("releaseObserver retries after a failed release", async () => {
		const aborter = new AbortController();
		let releaseAttempt = 0;
		const failingThenSucceedingBackend: ExecutionBackend = {
			name: "test", protocolVersion: 1,
			async detect() { return { available: true, version: "1", capabilities: [] }; },
			async launch() {
				return {
					async release() {
						releaseAttempt++;
						if (releaseAttempt === 1) throw new Error("first release failed");
					},
				};
			},
			async reattach() { return { status: "gone" }; },
			async close() {},
		};

		try {
			const { server, dependencies } = fakeHostDependencies();
			const controller = await createChildHostController(
				{ runtime, backend: failingThenSucceedingBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal },
				{ childHostCommand: () => ({ command: "echo", args: [] }), ...dependencies },
			);
			connectFakeHost(server);
			await controller.ready;

			// First call should reject
			await assert.rejects(
				controller.releaseObserver(),
				/first release failed/,
			);

			// Second call should retry, not silently succeed
			await controller.releaseObserver();

			assert.equal(releaseAttempt, 2, "release() should have been called twice (initial attempt + retry)");
		} finally {
			aborter.abort();
		}
	});
});
