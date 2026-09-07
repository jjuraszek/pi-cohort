import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { EventEmitter, once } from "node:events";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createExecutionControlChannel } from "../../src/execution-backend/control-channel.ts";
import { ControlFrameDecoder } from "../../src/execution-backend/control-protocol.ts";
import { EXECUTION_REPORT_PROTOCOL_VERSION, loadReporterConfig } from "../../src/execution-backend/reporting-protocol.ts";

const identity = { runId: "run", childId: "child", attemptId: "attempt" };

async function connect(configPath: string): Promise<net.Socket> {
	const socket = net.createConnection(loadReporterConfig(configPath).controlSocketPath);
	await once(socket, "connect");
	return socket;
}

class PendingSocket extends EventEmitter {
	callback: ((error?: Error | null) => void) | undefined;
	write(_data: Buffer, callback: (error?: Error | null) => void) { this.callback = callback; return true; }
	destroy() { this.emit("close"); }
}

class FakeServer extends EventEmitter {
	listening = false;
	listen(_path: string, callback: () => void) { this.listening = true; callback(); return this; }
	close(callback: () => void) { this.listening = false; callback(); return this; }
}

describe("execution control channel", () => {
	it("is fully private and listening before returning, then reports child connection", async () => {
		const channel = await createExecutionControlChannel(identity);
		const directory = path.dirname(channel.configPath);
		try {
			assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
			assert.equal(fs.statSync(channel.configPath).mode & 0o777, 0o600);
			const config = loadReporterConfig(channel.configPath);
			assert.equal(config.protocolVersion, EXECUTION_REPORT_PROTOCOL_VERSION);
			assert.equal(fs.statSync(config.controlSocketPath).mode & 0o777, 0o600);
			let connected = false;
			void channel.connected.then(() => { connected = true; });
			await Promise.resolve();
			assert.equal(connected, false);
			const socket = await connect(channel.configPath);
			await channel.connected;
			assert.equal(connected, true);
			socket.destroy();
		} finally {
			await channel.close();
			assert.equal(fs.existsSync(directory), false);
		}
	});

	it("waits for a child before writing and resolves only after the write callback", async () => {
		const channel = await createExecutionControlChannel(identity);
		const decoder = new ControlFrameDecoder();
		try {
			let settled = false;
			const requested = channel.request("abort").then((id) => { settled = true; return id; });
			await Promise.resolve();
			assert.equal(settled, false);
			const socket = await connect(channel.configPath);
			const data = once(socket, "data");
			const requestId = await requested;
			const [chunk] = await data;
			const [request] = decoder.feed(chunk as Buffer);
			assert.equal(request.requestId, requestId);
			assert.equal(request.action, "abort");
			socket.destroy();
		} finally {
			await channel.close();
		}
	});

	it("rejects connection and pending requests when closed before connect", async () => {
		const channel = await createExecutionControlChannel(identity);
		const connected = channel.connected;
		const requested = channel.request("shutdown");
		await channel.close();
		await assert.rejects(connected, /control channel closed/);
		await assert.rejects(requested, /control channel closed/);
		await assert.rejects(channel.request("abort"), /control channel closed/);
	});

	it("captures disconnects, rejects future requests, and accepts only one child", async () => {
		const channel = await createExecutionControlChannel(identity);
		try {
			const first = await connect(channel.configPath);
			await channel.connected;
			const second = net.createConnection(loadReporterConfig(channel.configPath).controlSocketPath);
			const secondClosed = once(second, "close");
			await secondClosed;
			const firstClosed = once(first, "close");
			first.destroy();
			await firstClosed;
			await assert.rejects(channel.request("abort"), /control socket (?:closed|disconnected)/);
		} finally {
			await channel.close();
		}
	});

	it("rejects a pending write when the child disconnects", async () => {
		let accept: ((socket: PendingSocket) => void) | undefined;
		const server = new FakeServer();
		const fileSystem = {
			...fs,
			chmodSync(target: fs.PathLike, mode: fs.Mode) {
				if (!String(target).endsWith("control.sock")) fs.chmodSync(target, mode);
			},
		};
		const channel = await createExecutionControlChannel(identity, {
			fileSystem,
			createServer(listener) { accept = listener; return server; },
		});
		try {
			const socket = new PendingSocket();
			assert.ok(accept);
			accept(socket);
			await channel.connected;
			const requested = channel.request("abort");
			await Promise.resolve();
			socket.emit("close");
			await assert.rejects(requested, /control socket disconnected/);
			await assert.rejects(channel.request("shutdown"), /control socket disconnected/);
		} finally {
			await channel.close();
		}
	});

	it("retains a write callback failure for future requests", async () => {
		let accept: ((socket: PendingSocket) => void) | undefined;
		const server = new FakeServer();
		const fileSystem = {
			...fs,
			chmodSync(target: fs.PathLike, mode: fs.Mode) {
				if (!String(target).endsWith("control.sock")) fs.chmodSync(target, mode);
			},
		};
		const channel = await createExecutionControlChannel(identity, {
			fileSystem,
			createServer(listener) { accept = listener; return server; },
		});
		try {
			const socket = new PendingSocket();
			assert.ok(accept);
			accept(socket);
			await channel.connected;
			const requested = channel.request("abort");
			await Promise.resolve();
			assert.ok(socket.callback);
			socket.callback(new Error("injected write failure"));
			await assert.rejects(requested, /injected write failure/);
			await assert.rejects(channel.request("shutdown"), /injected write failure/);
		} finally {
			await channel.close();
		}
	});

	it("rejects Windows and overlong Unix socket paths before listening", async () => {
		await assert.rejects(
			createExecutionControlChannel(identity, { platform: "win32" }),
			/unsupported on win32/,
		);
		let directory: string | undefined;
		let privateDirectory: string | undefined;
		const fileSystem = {
			...fs,
			mkdtempSync() {
				directory = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "control-path-"));
				privateDirectory = path.join(directory, "x".repeat(100));
				fs.mkdirSync(privateDirectory);
				return privateDirectory;
			},
		};
		await assert.rejects(
			createExecutionControlChannel(identity, { fileSystem }),
			/socket path exceeds the portable Unix limit/,
		);
		assert.ok(directory);
		assert.ok(privateDirectory);
		assert.equal(fs.existsSync(privateDirectory), false);
		fs.rmSync(directory, { recursive: true, force: true });
	});

	it("awaits idempotent cleanup with zero residue", async () => {
		const channel = await createExecutionControlChannel(identity);
		const directory = path.dirname(channel.configPath);
		const socket = await connect(channel.configPath);
		await channel.connected;
		await Promise.all([channel.close(), channel.close()]);
		socket.destroy();
		assert.equal(fs.existsSync(directory), false);
	});

	it("cleans setup artifacts when owner-only socket setup fails", async () => {
		let directory: string | undefined;
		const fileSystem = {
			...fs,
			mkdtempSync(prefix: string) {
				directory = fs.mkdtempSync(prefix);
				return directory;
			},
			chmodSync(target: fs.PathLike, mode: fs.Mode) {
				if (String(target).endsWith("control.sock")) throw new Error("injected chmod failure");
				fs.chmodSync(target, mode);
			},
		};
		await assert.rejects(
			createExecutionControlChannel(identity, { fileSystem }),
			/injected chmod failure/,
		);
		assert.ok(directory);
		assert.equal(fs.existsSync(directory), false);
	});

	it("handles errors on rejected duplicate sockets without throwing", async () => {
		let accept: ((socket: PendingSocket) => void) | undefined;
		const server = new FakeServer();
		const fileSystem = {
			...fs,
			chmodSync(target: fs.PathLike, mode: fs.Mode) {
				if (!String(target).endsWith("control.sock")) fs.chmodSync(target, mode);
			},
		};
		const channel = await createExecutionControlChannel(identity, {
			fileSystem,
			createServer(listener) { accept = listener; return server; },
		});
		try {
			assert.ok(accept);
			accept(new PendingSocket());
			await channel.connected;

			const duplicate = new PendingSocket();
			accept(duplicate);
			assert.doesNotThrow(() => duplicate.emit("error", new Error("duplicate socket error")));
		} finally {
			await channel.close();
		}
	});
});
