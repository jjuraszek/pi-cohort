import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createChildHostController } from "../../src/execution-backend/child-host-controller.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";

function fakeBackend(): { backend: ExecutionBackend; requests: ExecutionSurfaceRequest[]; hosts: ReturnType<typeof spawn>[]; launched: Promise<void>; releaseCalls: () => number; closeCalls: () => number; reap: () => Promise<void> } {
	const requests: ExecutionSurfaceRequest[] = []; const processes: Promise<void>[] = []; const hosts: ReturnType<typeof spawn>[] = []; let resolveLaunched!: () => void; const launched = new Promise<void>(resolve => { resolveLaunched = resolve; }); let releases = 0; let closes = 0;
	return { requests, hosts, launched, releaseCalls: () => releases, closeCalls: () => closes, reap: async () => { await Promise.all(processes); }, backend: {
		name: "fake", protocolVersion: 1, async detect() { return { available: true, version: "1", capabilities: [] }; },
		async launch(request) {
			requests.push(request);
			const host = spawn(request.command, [...request.args], { cwd: request.cwd, env: request.environment, stdio: "ignore" });
			hosts.push(host); processes.push(new Promise(resolve => host.once("exit", () => resolve()))); resolveLaunched();
			return { handle: { protocolVersion: 1, backend: "fake", surface: { kind: "fake", id: "one" }, display: { label: "fake", hint: "fake surface" }, data: null }, events: (async function*() {})(), async reconcile() { return []; }, async release() { releases += 1; } };
		},
		async reattach() { return { status: "gone" }; }, async close() { closes += 1; },
	} };
}

function hostCommand(action: string): () => { command: string; args: readonly string[] } {
	const script = `const fs=require('fs'),net=require('net');const c=JSON.parse(fs.readFileSync(process.env.PI_COHORT_CHILD_HOST_CONFIG));const send=m=>s.write(JSON.stringify({protocolVersion:1,runId:c.runId,childId:c.childId,...m})+'\\n');const s=net.connect(c.socketPath,()=>{if(process.argv[1]==='disconnect-before-ready')return s.destroy();if(process.argv[1]==='blocked-before-ready')return;if(process.argv[1].startsWith('wrong-'))return send({kind:'host_ready',[process.argv[1].slice(6)]: 'wrong'});if(process.argv[1]==='attempt-before-ready')return send({kind:'attempt_started',attemptId:'attempt'});if(process.argv[1]==='attempt-without-active')process.once('SIGUSR1',()=>send({kind:'attempt_started',attemptId:'attempt'}));if(process.argv[1]==='idle-disconnect')process.once('SIGUSR1',()=>s.destroy());send({kind:'host_ready'});if(process.argv[1]==='disconnect-on-message')s.once('data',()=>s.destroy());});`;
	return () => ({ command: process.execPath, args: ["-e", script, action] });
}

function assertArtifactsRemoved(configPath: string): void {
	assert.equal(fs.existsSync(configPath), false);
	assert.equal(fs.existsSync(path.join(path.dirname(configPath), "host.sock")), false);
	assert.equal(fs.existsSync(path.dirname(configPath)), false);
}

const unixOnly = { skip: process.platform === "win32" };

describe("execution child host", unixOnly, () => {
	it("uses one pre-listened backend surface for isolated attempts", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-fixture-")); const output = path.join(fixture, "output.jsonl"); const first = path.join(fixture, "one"); const second = path.join(fixture, "two"); fs.mkdirSync(first); fs.mkdirSync(second);
		const fake = fakeBackend(); const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) });
		await controller.ready;
		assert.equal(fake.requests.length, 1); assert.equal(fs.existsSync(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!), true);
		const script = "require('fs').appendFileSync(process.env.OUT, JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),token:process.env.TOKEN})+'\\n')";
		assert.deepEqual(await controller.startAttempt({ attemptId: "one", command: process.execPath, args: ["-e", script, "alpha"], cwd: first, environment: { OUT: output, TOKEN: "first" } }), { status: 0, signal: null });
		assert.deepEqual(await controller.startAttempt({ attemptId: "two", command: process.execPath, args: ["-e", script, "beta"], cwd: second, environment: { OUT: output, TOKEN: "second" } }), { status: 0, signal: null });
		assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line)), [{ argv: ["alpha"], cwd: fs.realpathSync(first), token: "first" }, { argv: ["beta"], cwd: fs.realpathSync(second), token: "second" }]);
		await assert.rejects(controller.startAttempt({ attemptId: "missing", command: path.join(fixture, "missing-command"), args: [], cwd: fixture, environment: {} }), /spawn error/);
		assert.deepEqual(await controller.startAttempt({ attemptId: "signal", command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"], cwd: fixture, environment: {} }), { status: null, signal: "SIGTERM" });
		await controller.releaseObserver(); await controller.releaseObserver(); assert.equal(fake.releaseCalls(), 1); await controller.shutdown(); await fake.reap();
		const configPath = fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!;
		assert.equal(fake.closeCalls(), 0);
		assert.equal(fs.existsSync(configPath), false);
		assert.equal(fs.existsSync(path.join(path.dirname(configPath), "host.sock")), false);
		assert.equal(fs.existsSync(path.dirname(configPath)), false);
		fs.rmSync(fixture, { recursive: true, force: true });
	});

	it("rejects attempts while shutdown acknowledgement is pending", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-shutdown-"));
		const fake = fakeBackend();
		const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) });
		await controller.ready;
		const shutdown = controller.shutdown();
		await assert.rejects(controller.startAttempt({ attemptId: "late", command: process.execPath, args: [], cwd: fixture, environment: {} }), /shutting down/);
		await shutdown;
		await fake.reap();
		fs.rmSync(fixture, { recursive: true, force: true });
	});

	it("rejects child host disconnect lifecycle phases", async t => {
		const cases = [
			{ name: "before ready", action: "disconnect-before-ready", operation: "create", error: /disconnected before ready/ },
			{ name: "during an attempt", action: "disconnect-on-message", operation: "attempt", error: /disconnected during attempt/ },
			{ name: "before shutdown acknowledgement", action: "disconnect-on-message", operation: "shutdown", error: /before shutdown acknowledgement/ },
		] as const;
		for (const scenario of cases) await t.test(scenario.name, async () => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-disconnect-")); const fake = fakeBackend();
			const create = () => createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) }, { childHostCommand: hostCommand(scenario.action) });
			if (scenario.operation === "create") {
				const controller = await create();
				await assert.rejects(controller.ready, scenario.error);
				await controller.releaseObserver();
				assert.equal(fake.releaseCalls(), 1);
			} else {
				const controller = await create();
				await controller.ready;
				if (scenario.operation === "attempt") await assert.rejects(controller.startAttempt({ attemptId: "attempt", command: process.execPath, args: [], cwd: fixture, environment: {} }), scenario.error);
				else await assert.rejects(controller.shutdown(), scenario.error);
			}
			await fake.reap(); assertArtifactsRemoved(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!); fs.rmSync(fixture, { recursive: true, force: true });
		});
	});

	it("reports an idle disconnect on the next operation", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-idle-disconnect-")); const fake = fakeBackend();
		const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) }, { childHostCommand: hostCommand("idle-disconnect") });
		await controller.ready;
		fake.hosts[0]!.kill("SIGUSR1"); await fake.reap();
		let cause: unknown;
		await assert.rejects(controller.startAttempt({ attemptId: "attempt", command: process.execPath, args: [], cwd: fixture, environment: {} }), error => { cause = error; return /disconnected after ready/.test(String(error)); });
		await assert.rejects(controller.shutdown(), error => { assert.equal(error, cause); return true; });
		assertArtifactsRemoved(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!); fs.rmSync(fixture, { recursive: true, force: true });
	});

	it("exposes an actionable lease while the host is blocked before ready", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-blocked-ready-")); const fake = fakeBackend(); const aborter = new AbortController();
		const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: aborter.signal }, { childHostCommand: hostCommand("blocked-before-ready") });
		assert.deepEqual(controller.lease.handle.surface, { kind: "fake", id: "one" });
		await assert.rejects(controller.startAttempt({ attemptId: "attempt", command: process.execPath, args: [], cwd: fixture, environment: {} }), /before ready/);
		aborter.abort();
		await assert.rejects(controller.ready, /launch aborted/);
		await controller.releaseObserver(); await controller.releaseObserver(); assert.equal(fake.releaseCalls(), 1);
		await fake.reap(); assertArtifactsRemoved(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!); fs.rmSync(fixture, { recursive: true, force: true });
	});

	it("rejects correlation and ordering violations from the connected host", async t => {
		for (const action of ["wrong-runId", "wrong-childId", "attempt-before-ready"] as const) await t.test(action, async () => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-invalid-message-")); const fake = fakeBackend();
			const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) }, { childHostCommand: hostCommand(action) });
			await assert.rejects(controller.ready, /disconnected before ready/);
			await controller.releaseObserver();
			await fake.reap(); assertArtifactsRemoved(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!); fs.rmSync(fixture, { recursive: true, force: true });
		});
		await t.test("attempt_started without an active attempt", async () => {
			const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-invalid-message-")); const fake = fakeBackend();
			const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: AbortSignal.timeout(5_000) }, { childHostCommand: hostCommand("attempt-without-active") });
			await controller.ready;
			fake.hosts[0]!.kill("SIGUSR1"); await fake.reap();
			await assert.rejects(controller.startAttempt({ attemptId: "attempt", command: process.execPath, args: [], cwd: fixture, environment: {} }), /disconnected after ready/);
			assertArtifactsRemoved(fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!); fs.rmSync(fixture, { recursive: true, force: true });
		});
	});

	it("rejects concurrent and repeated attempts without another launch", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "child-host-busy-"));
		const fake = fakeBackend(); const aborter = new AbortController();
		const controller = await createChildHostController({ backend: fake.backend, runId: "run", childId: "child", cwd: fixture, signal: aborter.signal });
		await controller.ready;
		await controller.startAttempt({ attemptId: "used", command: process.execPath, args: ["-e", ""], cwd: fixture, environment: {} });
		await assert.rejects(controller.startAttempt({ attemptId: "used", command: process.execPath, args: [], cwd: fixture, environment: {} }), /already been used/);
		const running = controller.startAttempt({ attemptId: "once", command: process.execPath, args: ["-e", "setInterval(() => {}, 1_000)"], cwd: fixture, environment: {} });
		await assert.rejects(controller.startAttempt({ attemptId: "other", command: process.execPath, args: [], cwd: fixture, environment: {} }), /busy/);
		aborter.abort();
		await assert.rejects(running, /launch aborted/);
		await assert.rejects(controller.startAttempt({ attemptId: "once", command: process.execPath, args: [], cwd: fixture, environment: {} }), /before ready/);
		assert.equal(fake.requests.length, 1);
		await fake.reap();
		const configPath = fake.requests[0]!.environment.PI_COHORT_CHILD_HOST_CONFIG!;
		assert.equal(fs.existsSync(configPath), false);
		assert.equal(fs.existsSync(path.join(path.dirname(configPath), "host.sock")), false);
		assert.equal(fs.existsSync(path.dirname(configPath)), false);
		assert.equal(fake.closeCalls(), 0);
		fs.rmSync(fixture, { recursive: true, force: true });
	});
});
