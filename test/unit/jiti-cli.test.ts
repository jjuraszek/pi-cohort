import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { createJitiCliResolver, ensureJitiCliPath, resolveHostModuleAliases } from "../../src/runs/shared/jiti-cli.ts";

function installation(root: string, bin: string | Record<string, string> = { jiti: "cli.mjs" }): string {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
	fs.writeFileSync(path.join(root, "pi.mjs"), "");
	const jiti = path.join(root, "node_modules", "jiti");
	fs.mkdirSync(jiti, { recursive: true });
	fs.writeFileSync(path.join(jiti, "package.json"), JSON.stringify({ name: "jiti", bin }));
	fs.writeFileSync(path.join(jiti, "cli.mjs"), "");
	const typebox = path.join(root, "node_modules", "typebox");
	fs.mkdirSync(typebox, { recursive: true });
	fs.writeFileSync(path.join(typebox, "package.json"), JSON.stringify({ name: "typebox", exports: { ".": "./index.js", "./compile": "./compile.js", "./value": "./value.js" } }));
	for (const file of ["index.js", "compile.js", "value.js"]) fs.writeFileSync(path.join(typebox, file), "");
	return root;
}

it("resolves only the selected installation while argv1 and cwd select B", () => {
	const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jiti-")));
	const cwd = process.cwd();
	const argv1 = process.argv[1];
	try {
		const a = installation(path.join(temp, "A"));
		const b = installation(path.join(temp, "B"), "cli.mjs");
		process.argv[1] = path.join(b, "pi.mjs");
		process.chdir(b);
		for (const root of [a, b, a]) {
			assert.equal(ensureJitiCliPath(root), path.join(root, "node_modules", "jiti", "cli.mjs"));
			assert.deepEqual(resolveHostModuleAliases(root), {
				typebox: path.join(root, "node_modules", "typebox", "index.js"),
				"typebox/compile": path.join(root, "node_modules", "typebox", "compile.js"),
				"typebox/value": path.join(root, "node_modules", "typebox", "value.js"),
			});
		}
		fs.rmSync(path.join(a, "node_modules", "jiti"), { recursive: true });
		assert.equal(ensureJitiCliPath(a), undefined);
		fs.rmSync(path.join(a, "node_modules", "typebox"), { recursive: true });
		assert.throws(() => resolveHostModuleAliases(a), (error: Error) => error.message.includes(a) && error.message.includes("typebox"));
	} finally {
		process.chdir(cwd);
		process.argv[1] = argv1;
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

it("rechecks disappeared and replaced CLI entries without caching the selected root", () => {
	const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jiti-disappear-")));
	try {
		const root = installation(path.join(temp, "A"));
		const cli = path.join(root, "node_modules", "jiti", "cli.mjs");
		assert.equal(ensureJitiCliPath(root), cli);
		fs.unlinkSync(cli);
		assert.equal(ensureJitiCliPath(root), undefined);
		const replacement = path.join(path.dirname(cli), "replacement.mjs");
		fs.writeFileSync(replacement, "");
		fs.writeFileSync(path.join(path.dirname(cli), "package.json"), JSON.stringify({ bin: { other: "replacement.mjs" } }));
		assert.equal(ensureJitiCliPath(root), replacement);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

it("passes each selected root to the injected resolver and checks its result per call", () => {
	const roots: string[] = [];
	const resolve = createJitiCliResolver({
		resolve: (root: string) => { roots.push(root); return `${root}/cli`; },
		exists: (file: string) => file !== "/missing/cli",
	});
	assert.deepEqual(roots, []);
	assert.equal(resolve("/A"), "/A/cli");
	assert.equal(resolve("/B"), "/B/cli");
	assert.equal(resolve("/missing"), undefined);
	assert.deepEqual(roots, ["/A", "/B", "/missing"]);
});
