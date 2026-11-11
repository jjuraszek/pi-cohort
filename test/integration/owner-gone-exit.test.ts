import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const runtimePath = new URL("../../src/runs/shared/subagent-prompt-runtime.ts", import.meta.url).href;
const loaderPath = fileURLToPath(new URL("../support/register-loader.mjs", import.meta.url));
let harnessRoot: string;
let script: string;
before(() => {
	harnessRoot = createTempDir("owner-harness-");
	script = path.join(harnessRoot, "runtime.mjs");
	fs.writeFileSync(script, `
import { spawn } from "node:child_process";
import * as fs from "node:fs";
const [mode, runtimePath, readyFile, leafFile] = process.argv.slice(2);
delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
if (mode !== "owner") {
  const { default: register } = await import(runtimePath);
  if (mode === "unknown") {
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("permission"), { code: "EPERM" });
      return kill(pid, signal);
    };
  }
  const shutdownHandlers = [];
  register({ on(event, handler) { if (event === "session_shutdown") shutdownHandlers.push(handler); }, registerTool() {} });
  if (mode === "shutdown-pending") shutdownHandlers.push(() => new Promise(() => {}));
  if (mode === "fallback" || mode === "shutdown-pending") process.on("SIGTERM", async () => {
    fs.appendFileSync(readyFile + ".signals", "term\\n");
    if (mode === "shutdown-pending") {
      for (const handler of shutdownHandlers) await handler();
      process.exit(0);
    }
  });
  else process.on("SIGTERM", () => process.exit(0));
  if (mode === "tree") {
    const leaf = spawn(process.execPath, [...process.execArgv, process.argv[1], "leaf", runtimePath, leafFile, ""], {
      env: { ...process.env, PI_SUBAGENT_OWNER_PID: String(process.pid) }, stdio: "ignore",
    });
    fs.writeFileSync(readyFile + ".leaf-pid", String(leaf.pid));
  }
}
fs.writeFileSync(readyFile, String(process.pid));
if (mode !== "unref") setInterval(() => {}, 1000);
`);
});
after(() => removeTempDir(harnessRoot));

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		assert.ok(Date.now() < deadline, "process condition exceeded deadline");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

interface RuntimeFixture {
	child: ChildProcess;
	exited: Promise<unknown[]>;
	ready: string;
	leafPid?: number;
}

async function withRuntime(mode: string, check: (fixture: RuntimeFixture) => Promise<void>): Promise<void> {
	const root = createTempDir("owner-gone-");
	const ready = path.join(root, "ready");
	const leafReady = path.join(root, "leaf");
	const processes: ChildProcess[] = [];
	let leafPid: number | undefined;
	let stderr = "";
	const launch = (role: string, readyFile: string, ownerPid: string) => {
		const child = spawn(process.execPath, ["--import", loaderPath, script, role, runtimePath, readyFile, leafReady], {
			env: { ...process.env, PI_SUBAGENT_OWNER_PID: ownerPid }, stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr!.on("data", data => { stderr += data; });
		processes.push(child);
		return child;
	};
	try {
		const owner = launch("owner", path.join(root, "owner"), "");
		await waitFor(() => fs.existsSync(path.join(root, "owner")));
		const child = launch(mode, ready, mode === "empty" ? "" : String(owner.pid));
		const exited = once(child, "exit");
		await waitFor(() => fs.existsSync(ready) || child.exitCode !== null);
		assert.ok(fs.existsSync(ready), stderr);
		if (mode === "tree") {
			await waitFor(() => fs.existsSync(leafReady));
			leafPid = Number(fs.readFileSync(ready + ".leaf-pid", "utf8"));
		}
		const ownerExit = once(owner, "exit");
		owner.kill("SIGKILL");
		await ownerExit;
		await check({ child, exited, ready, leafPid });
	} finally {
		// The leaf is detached from the test's ChildProcess handles after its owner exits.
		if (!leafPid && fs.existsSync(ready + ".leaf-pid")) leafPid = Number(fs.readFileSync(ready + ".leaf-pid", "utf8"));
		if (leafPid) try { process.kill(leafPid, "SIGKILL"); } catch {}
		await Promise.all(processes.map(async child => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}));
		removeTempDir(root);
	}
}

const unixOnly = { skip: process.platform === "win32", timeout: 20000 };

test("owner death stops the native child and its nested descendant", unixOnly, async () => {
	await withRuntime("tree", async ({ child, exited, leafPid }) => {
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		assert.equal((await exited)[0], 0);
		assert.ok(leafPid);
		await waitFor(() => !alive(leafPid));
	});
});

for (const mode of ["fallback", "shutdown-pending"]) {
	test(`owner death forces exit 143 when SIGTERM does not settle the runtime (${mode})`, unixOnly, async () => {
		await withRuntime(mode, async ({ child, exited, ready }) => {
			await waitFor(() => child.exitCode !== null || child.signalCode !== null);
			assert.equal((await exited)[0], 143);
			assert.equal(fs.readFileSync(ready + ".signals", "utf8"), "term\n");
		});
	});
}

for (const mode of ["unknown", "empty"]) {
	test(`owner monitoring does not terminate a runtime (${mode})`, unixOnly, async () => {
		await withRuntime(mode, async ({ child }) => {
			await new Promise(resolve => setTimeout(resolve, 1200));
			assert.equal(child.exitCode, null);
			assert.equal(child.signalCode, null);
			assert.equal(alive(child.pid!), true);
		});
	});
}

test("the owner poll does not keep an otherwise idle runtime alive", unixOnly, async () => {
	await withRuntime("unref", async ({ child, exited }) => {
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		assert.equal((await exited)[0], 0);
	});
});
