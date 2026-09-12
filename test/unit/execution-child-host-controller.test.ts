import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import type { Server, Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createChildHostController } from "../../src/execution-backend/child-host-controller.ts";
import { CHILD_HOST_PROTOCOL_VERSION, encodeChildHostMessage } from "../../src/execution-backend/child-host-protocol.ts";
import type { ExecutionBackend } from "../../src/execution-backend/types.ts";

const backend: ExecutionBackend = {
	name: "test", protocolVersion: 1,
	async detect() { return { available: true, version: "1", capabilities: [] }; },
	async launch() { throw new Error("launch must not run"); },
	async reattach() { return { status: "gone" }; },
	async close() {},
};

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

function connectFakeHost(server: FakeServer): void {
	server.connect().emit("data", encodeChildHostMessage({
		protocolVersion: CHILD_HOST_PROTOCOL_VERSION,
		kind: "host_ready",
		runId: "run",
		childId: "child",
	}));
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
	it("rejects win32 platform", async () => {
		await assert.rejects(
			createChildHostController({ backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: AbortSignal.timeout(1_000) }, { platform: "win32" }),
			/unsupported on win32/,
		);
	});

	it("does not create a directory or launch when already aborted", async () => {
		const aborter = new AbortController(); aborter.abort();
		await assert.rejects(
			createChildHostController({ backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal }, testDependencies),
			/launch aborted/,
		);
	});

	for (const method of ["chmodSync", "openSync", "writeFileSync"] as const) {
		it(`removes private setup artifacts when ${method} fails`, async () => {
			const { fileSystem, directory } = failingFileSystem(method);
			await assert.rejects(
				createChildHostController({ backend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: AbortSignal.timeout(1_000) }, { fs: fileSystem, ...testDependencies }),
				new RegExp(`injected ${method} failure`),
			);
			assert.equal(fs.existsSync(directory), false);
		});
	}
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
				{ backend: releasingBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal },
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
				{ backend: failingThenSucceedingBackend, runId: "run", childId: "child", cwd: os.tmpdir(), signal: aborter.signal },
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
