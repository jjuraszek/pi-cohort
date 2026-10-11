import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import * as spawn from "../../src/runs/shared/pi-spawn.ts";

function fixture(t: { after: (fn: () => void) => void }, bin: unknown = { pi: "dist/cli/index.js" }, name = spawn.PI_CODING_AGENT_PACKAGE) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi runtime ü spaces [literal]+-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const entry = path.join(root, "dist", "cli", "index.js");
	const bundle = path.join(root, "dist", "bundle", "cli.js");
	for (const file of [entry, bundle]) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "");
	}
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, bin }));
	return { root: fs.realpathSync.native(root), entry: fs.realpathSync.native(entry), bundle: fs.realpathSync.native(bundle) };
}

it("launches the explicit runtime without PATH and preserves arguments", (t) => {
	const f = fixture(t);
	const runtime = { nodeExecPath: fs.realpathSync.native(process.execPath), piEntryPath: f.entry, piPackageRoot: f.root };
	const args = ["--mode", "json", 'read "quotes" & pipes | ü'];
	assert.deepEqual(spawn.getPiSpawnCommand(args, runtime), { command: runtime.nodeExecPath, args: [f.entry, ...args] });
});

for (const [label, bin, layout] of [
	["string bundle", "dist/bundle/cli.js", "bundle"],
	["object pi", { other: "dist/bundle/cli.js", pi: "dist/cli/index.js" }, "entry"],
] as const) {
	it(`captures canonical symlink identity from ${label} metadata`, (t) => {
		const f = fixture(t, bin);
		const link = path.join(f.root, "linked.js");
		fs.symlinkSync(f[layout], link);
		const runtime = spawn.capturePiRuntime({ execPath: process.execPath, argv1: link });
		assert.deepEqual(runtime, { nodeExecPath: fs.realpathSync.native(process.execPath), piEntryPath: f[layout], piPackageRoot: f.root });
		assert.deepEqual(spawn.parsePiRuntime(JSON.parse(JSON.stringify(runtime)), "saved runtime"), runtime);
	});
}

for (const [label, bin, name, entryName] of [
	["wrong package", { pi: "dist/cli/index.js" }, "other-package", "entry"],
	["arbitrary JavaScript", { pi: "dist/bundle/cli.js" }, spawn.PI_CODING_AGENT_PACKAGE, "entry"],
	["alternate bin only", { other: "dist/cli/index.js" }, spawn.PI_CODING_AGENT_PACKAGE, "entry"],
] as const) {
	it(`rejects ${label}`, (t) => {
		const f = fixture(t, bin, name);
		assert.throws(() => spawn.capturePiRuntime({ argv1: f[entryName] }), spawn.PiRuntimeLaunchError);
	});
}

for (const field of ["nodeExecPath", "piEntryPath"] as const) {
	it(`rejects missing ${field} during capture and launch`, (t) => {
		const f = fixture(t);
		const missing = path.join(f.root, "missing");
		assert.throws(() => spawn.capturePiRuntime({ execPath: field === "nodeExecPath" ? missing : process.execPath, argv1: field === "piEntryPath" ? missing : f.entry }), (error) => error instanceof spawn.PiRuntimeLaunchError && error.message.includes(missing));
		const runtime = spawn.capturePiRuntime({ argv1: f.entry });
		assert.throws(() => spawn.getPiSpawnCommand([], { ...runtime, [field]: missing }), (error) => error instanceof spawn.PiRuntimeLaunchError && error.message.includes(missing));
	});
}

it("rejects a captured entry renamed after capture", (t) => {
	const f = fixture(t);
	const runtime = spawn.capturePiRuntime({ argv1: f.entry });
	fs.renameSync(f.entry, `${f.entry}.old`);
	assert.throws(() => spawn.getPiSpawnCommand([], runtime), (error) => error instanceof spawn.PiRuntimeLaunchError && error.message.includes(f.entry));
});

it("rechecks package ownership before launch", (t) => {
	const f = fixture(t);
	const runtime = spawn.capturePiRuntime({ argv1: f.entry });
	fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "other-package", bin: "dist/cli/index.js" }));
	assert.throws(() => spawn.getPiSpawnCommand([], runtime), spawn.PiRuntimeLaunchError);
});

it("parses exact stored strings and rejects malformed serialized fields", () => {
	const runtime = { nodeExecPath: path.resolve("Node ü"), piEntryPath: path.join(path.resolve("Pi Space"), "CLI.js"), piPackageRoot: path.resolve("Package Ü") };
	assert.deepEqual(spawn.parsePiRuntime(runtime, "saved runtime"), runtime);
	const unnormalized = { ...runtime, piEntryPath: `${path.resolve("Pi Space")}${path.sep}..${path.sep}CLI.js` };
	assert.deepEqual(spawn.parsePiRuntime(unnormalized, "saved runtime"), unnormalized);
	const invalid: unknown[] = [null, [], {}, { nodeExecPath: runtime.nodeExecPath }];
	for (const field of Object.keys(runtime)) {
		for (const value of ["", "relative/path", null, 42]) invalid.push({ ...runtime, [field]: value });
	}
	for (const value of invalid) assert.throws(() => spawn.parsePiRuntime(value, "saved runtime"), { name: "PiRuntimeLaunchError", message: /saved runtime/ });
});
