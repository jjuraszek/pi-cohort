import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import * as spawn from "../../src/runs/shared/pi-spawn.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function piPackage(t: { after: (fn: () => void) => void }, options: { name?: string; bin?: unknown; entryFile?: string } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi install root "));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const entryFile = options.entryFile ?? "dist/bundle/cli.js";
	const entry = path.join(root, entryFile);
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "");
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: options.name ?? spawn.PI_CODING_AGENT_PACKAGE, bin: options.bin === undefined ? { pi: entryFile } : options.bin }));
	return { root: fs.realpathSync.native(root), entry: fs.realpathSync.native(entry) };
}

function hostEntry(t: { after: (fn: () => void) => void }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk host "));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const entry = path.join(root, "host.mjs");
	fs.writeFileSync(entry, "");
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@test/sdk-host" }));
	return fs.realpathSync.native(entry);
}

it("falls back to the installation root when argv[1] is not Pi's CLI", (t) => {
	const install = piPackage(t);
	const runtime = spawn.capturePiRuntime({ execPath: process.execPath, argv1: hostEntry(t), installRoot: install.root });
	assert.equal(runtime.piEntryPath, install.entry);
	assert.equal(runtime.piPackageRoot, install.root);
	assert.equal(runtime.nodeExecPath, fs.realpathSync.native(process.execPath));
});

it("never reads installRoot when argv[1] is Pi's CLI", (t) => {
	const cli = piPackage(t);
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "never read "));
	t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
	const expected = spawn.capturePiRuntime({ execPath: process.execPath, argv1: cli.entry });
	const actual = spawn.capturePiRuntime({ execPath: process.execPath, argv1: cli.entry, installRoot: empty });
	assert.deepEqual(actual, expected);
	assert.equal(actual.piPackageRoot, cli.root);
});

it("rejects an installRoot that is not a Pi package or declares no bin", (t) => {
	const host = hostEntry(t);
	const foreign = piPackage(t, { name: "@other/package" });
	assert.throws(() => spawn.capturePiRuntime({ execPath: process.execPath, argv1: host, installRoot: foreign.root }), spawn.PiRuntimeLaunchError);
	const noBin = piPackage(t, { bin: {} });
	assert.throws(() => spawn.capturePiRuntime({ execPath: process.execPath, argv1: host, installRoot: noBin.root }), spawn.PiRuntimeLaunchError);
});

it("rejects an installRoot whose declared bin resolves into another package", (t) => {
	const host = hostEntry(t);
	const other = piPackage(t);
	const linked = fs.mkdtempSync(path.join(os.tmpdir(), "linked install "));
	t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
	fs.mkdirSync(path.join(linked, "dist", "bundle"), { recursive: true });
	fs.symlinkSync(other.entry, path.join(linked, "dist", "bundle", "cli.js"));
	fs.writeFileSync(path.join(linked, "package.json"), JSON.stringify({ name: spawn.PI_CODING_AGENT_PACKAGE, bin: { pi: "dist/bundle/cli.js" } }));
	assert.throws(() => spawn.capturePiRuntime({ execPath: process.execPath, argv1: host, installRoot: linked }), (error: unknown) => error instanceof spawn.PiRuntimeLaunchError && error.message.includes(other.root));
});

it("falls back when argv[1] is missing and still throws without installRoot", (t) => {
	const install = piPackage(t);
	const missing = path.join(os.tmpdir(), "no-such-entry-" + process.pid + ".js");
	const runtime = spawn.capturePiRuntime({ execPath: process.execPath, argv1: missing, installRoot: install.root });
	assert.equal(runtime.piPackageRoot, install.root);
	assert.throws(() => spawn.capturePiRuntime({ execPath: process.execPath, argv1: missing }), spawn.PiRuntimeLaunchError);
});

it("keeps the detached runner's import graph free of runtime pi package imports", () => {
	const seen = new Set<string>();
	const queue = [path.join(repoRoot, "src/runs/background/subagent-runner.ts")];
	const offenders: string[] = [];
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(/^(import|export)\s[^;]*?from\s+"([^"]+)";?$/gm)) {
			const [line, , specifier] = match;
			if (specifier.startsWith("@earendil-works/") && !/^(import|export)\s+type\s/.test(line)) offenders.push(`${path.relative(repoRoot, file)}: ${line}`);
			if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier));
		}
	}
	assert.ok(seen.has(path.join(repoRoot, "src/runs/shared/pi-spawn.ts")), "pi-spawn.ts is reachable from the runner");
	assert.deepEqual(offenders, []);
});
