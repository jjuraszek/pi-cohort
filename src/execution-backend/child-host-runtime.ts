import * as fs from "node:fs";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { ChildHostFrameDecoder, type ChildHostConfig, type ChildHostMessage, encodeChildHostMessage, validateChildHostConfig } from "./child-host-protocol.ts";

export const PI_COHORT_CHILD_HOST_CONFIG = "PI_COHORT_CHILD_HOST_CONFIG";

export function loadChildHostConfig(configPath = process.env[PI_COHORT_CHILD_HOST_CONFIG]): ChildHostConfig {
	if (!configPath) throw new Error(`${PI_COHORT_CHILD_HOST_CONFIG} is required`);
	let descriptor: number | undefined;
	try {
		try { descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
		catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ELOOP") throw new Error("child host config must be a regular non-symlink file"); throw cause; }
		const details = fs.fstatSync(descriptor);
		if (!details.isFile() || (details.mode & 0o077) !== 0) throw new Error("child host config must be an owner-only regular file");
		return validateChildHostConfig(JSON.parse(fs.readFileSync(descriptor, "utf8")));
	} finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function runChildHost(config = loadChildHostConfig()): void {
	const correlation = { protocolVersion: 1 as const, runId: config.runId, childId: config.childId };
	const socket = net.createConnection(config.socketPath);
	let active: { attemptId: string; process: ChildProcess } | undefined;
	let stopping = false;
	const send = (message: ChildHostMessage) => { if (!socket.destroyed) socket.write(encodeChildHostMessage(message)); };
	const terminateActive = () => { if (active && !active.process.killed) active.process.kill(); };
	socket.on("connect", () => send({ ...correlation, kind: "host_ready" }));
	socket.on("data", data => {
		let messages: ChildHostMessage[];
		try { messages = decoder.push(data); } catch { socket.destroy(); return; }
		for (const message of messages) {
			if (message.runId !== config.runId || message.childId !== config.childId) { socket.destroy(); return; }
			if (message.kind === "shutdown_host") {
				if (active || stopping) { socket.destroy(); return; }
				stopping = true; send({ ...correlation, kind: "shutdown_ack" }); socket.end(); return;
			}
			if (message.kind !== "start_attempt" || active || stopping) { socket.destroy(); return; }
			let child: ChildProcess;
			try { child = spawn(message.command, [...message.args], { cwd: message.cwd, env: message.environment, shell: false, stdio: "inherit", windowsHide: true }); }
			catch { send({ ...correlation, kind: "attempt_spawn_error", attemptId: message.attemptId }); continue; }
			active = { attemptId: message.attemptId, process: child };
			send({ ...correlation, kind: "attempt_started", attemptId: message.attemptId });
			let settled = false;
			child.once("error", () => {
				if (settled) return; settled = true;
				if (active?.attemptId === message.attemptId) active = undefined;
				send({ ...correlation, kind: "attempt_spawn_error", attemptId: message.attemptId });
			});
			child.once("exit", (status, signal) => {
				if (settled) return; settled = true;
				if (active?.attemptId === message.attemptId) active = undefined;
				send({ ...correlation, kind: "attempt_exited", attemptId: message.attemptId, status, signal });
			});
		}
	});
	const decoder = new ChildHostFrameDecoder();
	socket.once("close", () => { terminateActive(); });
	socket.on("error", () => { process.exitCode = 1; });
}

if (process.argv.some(argument => argument.endsWith("child-host-runtime.ts"))) runChildHost();
