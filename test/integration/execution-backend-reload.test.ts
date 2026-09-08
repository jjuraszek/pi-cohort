import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jitiUrl = pathToFileURL(path.join(projectRoot, "node_modules/jiti/lib/jiti.mjs")).href;
const reloadUrl = pathToFileURL(path.join(projectRoot, "src/execution-backend/reload.ts")).href;
const registryUrl = pathToFileURL(path.join(projectRoot, "src/execution-backend/registry.ts")).href;
const selectionUrl = pathToFileURL(path.join(projectRoot, "src/execution-backend/selection.ts")).href;

function writeFixturePackage(
	root: string,
	backendName = "fixture",
	packageDirectory = "unpublished-fixture",
	factoryFails = false,
): { packageJsonUrl: string; factoryMarker: string; defaultMarker: string } {
	const packageDir = path.join(root, packageDirectory);
	const factoryMarker = path.join(packageDir, "factory-called");
	const defaultMarker = path.join(packageDir, "default-loaded");
	fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
	fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
		name: `unpublished-reload-${packageDirectory}`,
		type: "module",
		exports: {
			".": "./src/default.ts",
			"./execution-backend": "./src/backend.ts",
		},
	}));
	fs.writeFileSync(path.join(packageDir, "src/default.ts"), `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(defaultMarker)}, "loaded"); export default {};\n`);
	fs.writeFileSync(path.join(packageDir, "src/backend.ts"), `
		import * as fs from "node:fs";
		export function createBackend() {
			fs.writeFileSync(${JSON.stringify(factoryMarker)}, "called");
			${factoryFails ? "throw new Error(\"fixture failure\");" : ""}
			return {
				name: ${JSON.stringify(backendName)},
				protocolVersion: 1,
				async detect() { return { available: true, version: "1", capabilities: [] }; },
				async launch() { throw new Error("not used"); },
				async reattach() { return { status: "gone" }; },
				async close() {},
			};
		}
	`);
	fs.writeFileSync(path.join(packageDir, "src/private.ts"), "export function createBackend() { return {}; }\n");
	return {
		packageJsonUrl: pathToFileURL(path.join(packageDir, "package.json")).href,
		factoryMarker,
		defaultMarker,
	};
}

function runnerArguments(registrations: unknown, preexisting = false): string[] {
	const args: string[] = [];
	if (process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types")) {
		args.push("--no-experimental-strip-types");
	}
	args.push(
		"--input-type=module",
		"--eval",
		`import { createJiti } from ${JSON.stringify(jitiUrl)};
		 const jiti = createJiti(import.meta.url);
		 const reload = await jiti.import(${JSON.stringify(reloadUrl)});
		 const registry = await jiti.import(${JSON.stringify(registryUrl)});
		 if (${JSON.stringify(preexisting)}) {
			 registry.registerExecutionBackend({
				 name: "preexisting",
				 protocolVersion: 1,
				 async detect() { return { available: true, version: "1", capabilities: [] }; },
				 async launch() { throw new Error("not used"); },
				 async reattach() { return { status: "gone" }; },
				 async close() {},
			 });
		 }
		 try {
			 await reload.reconstructExecutionBackends(${JSON.stringify(registrations)});
			 console.log(JSON.stringify({ names: registry.executionBackends().map(backend => backend.name) }));
		 } catch (error) {
			 console.log(JSON.stringify(${JSON.stringify(preexisting)}
				 ? { code: error?.code, names: registry.executionBackends().map(backend => backend.name) }
				 : { code: error?.code }));
		 }`,
	);
	return args;
}

function coordinatorArguments(config: unknown): string[] {
	const args: string[] = [];
	if (process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types")) {
		args.push("--no-experimental-strip-types");
	}
	args.push(
		"--input-type=module",
		"--eval",
		`import { createJiti } from ${JSON.stringify(jitiUrl)};
		 const jiti = createJiti(import.meta.url);
		 const reload = await jiti.import(${JSON.stringify(reloadUrl)});
		 const registry = await jiti.import(${JSON.stringify(registryUrl)});
		 const selection = await jiti.import(${JSON.stringify(selectionUrl)});
		 const config = reload.decodeDetachedExecutionBackendConfig(${JSON.stringify(config)});
		 const coordinator = reload.createDetachedExecutionBackendCoordinator(config);
		 try {
			await selection.selectExecutionBackend("native", coordinator);
			await selection.selectExecutionBackend("first", coordinator);
			const automatic = await selection.selectExecutionBackend("auto", coordinator);
			console.log(JSON.stringify({ names: registry.executionBackends().map(backend => backend.name), kind: automatic.selection.kind }));
		 } catch (error) { console.log(JSON.stringify({ code: error?.code })); }`,
	);
	return args;
}

function registration(name: string, packageJsonUrl: string) {
	return {
		name,
		reload: {
			protocolVersion: 1,
			packageJsonUrl,
			publicSubpath: "./execution-backend" as const,
			factoryExport: "createBackend",
		},
	};
}

test("fresh Jiti process resolves an unpublished package self-reference to an exported TypeScript factory", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-reload-fixture-"));
	try {
		const fixture = writeFixturePackage(root);
		const result = spawnSync(execPath, runnerArguments([
			registration("fixture", fixture.packageJsonUrl),
		]), { cwd: root, encoding: "utf8" });

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), { names: ["fixture"] });
		assert.equal(fs.existsSync(fixture.factoryMarker), true, "the named factory should be called");
		assert.equal(fs.existsSync(fixture.defaultMarker), false, "the package default extension must not load");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fresh detached coordinator preserves factory order across native, explicit, and auto selection", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-detached-coordinator-"));
	try {
		const first = writeFixturePackage(root, "first", "first-package");
		const second = writeFixturePackage(root, "second", "second-package");
		const result = spawnSync(execPath, coordinatorArguments({
			protocolVersion: 1,
			userPreference: "first",
			registrations: [registration("first", first.packageJsonUrl), registration("second", second.packageJsonUrl)],
		}), { cwd: root, encoding: "utf8", env: { ...process.env, EXECUTION_BACKEND_SECRET_SENTINEL: "not-transferred" } });

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), { names: ["first", "second"], kind: "external" });
		assert.equal(fs.existsSync(first.factoryMarker), true);
		assert.equal(fs.existsSync(second.factoryMarker), true);
		assert.equal(fs.existsSync(first.defaultMarker), false);
		assert.equal(fs.existsSync(second.defaultMarker), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fresh Jiti process rejects a factory whose identity differs from its registration", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-reload-identity-fixture-"));
	try {
		const fixture = writeFixturePackage(root, "wrong-name");
		const result = spawnSync(execPath, runnerArguments([
			registration("fixture", fixture.packageJsonUrl),
		]), { cwd: root, encoding: "utf8" });

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), { code: "identity_mismatch" });
		assert.equal(fs.existsSync(fixture.factoryMarker), true, "the factory ran before identity verification");
		assert.equal(fs.existsSync(fixture.defaultMarker), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fresh Jiti process rejects a real private TypeScript factory target", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-reload-private-fixture-"));
	try {
		const fixture = writeFixturePackage(root);
		const result = spawnSync(execPath, runnerArguments([{
			name: "fixture",
			reload: {
				protocolVersion: 1,
				packageJsonUrl: fixture.packageJsonUrl,
				publicSubpath: "./private",
				factoryExport: "createBackend",
			},
		}]), { cwd: root, encoding: "utf8" });

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), { code: "export_not_public" });
		assert.equal(fs.existsSync(fixture.factoryMarker), false);
		assert.equal(fs.existsSync(fixture.defaultMarker), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("fresh Jiti process rolls back only registrations reconstructed by a failed invocation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-reload-rollback-fixture-"));
	try {
		const first = writeFixturePackage(root, "first", "first-fixture");
		const failing = writeFixturePackage(root, "failing", "failing-fixture", true);
		const result = spawnSync(execPath, runnerArguments([
			registration("first", first.packageJsonUrl),
			registration("failing", failing.packageJsonUrl),
		], true), { cwd: root, encoding: "utf8" });

		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.deepEqual(JSON.parse(result.stdout), { code: "factory_failed", names: ["preexisting"] });
		assert.equal(fs.existsSync(first.factoryMarker), true, "the first factory should be reconstructed");
		assert.equal(fs.existsSync(failing.factoryMarker), true, "the failing factory should be attempted");
		assert.equal(fs.existsSync(first.defaultMarker), false);
		assert.equal(fs.existsSync(failing.defaultMarker), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
