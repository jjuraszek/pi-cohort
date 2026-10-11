import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";

const cases = [
	{ name: "immediate success", platform: "win32", codes: [], attempts: 1, waits: 0, success: true },
	{ name: "transient Windows locks", platform: "win32", codes: ["EPERM", "EACCES", "EBUSY"], attempts: 4, waits: 3, success: true },
	{ name: "success on final retry", platform: "win32", codes: Array(5).fill("EPERM"), attempts: 6, waits: 5, success: true },
	{ name: "Windows exhaustion", platform: "win32", codes: Array(6).fill("EBUSY"), attempts: 6, waits: 5, success: false },
	{ name: "non-Windows EPERM", platform: "linux", codes: ["EPERM"], attempts: 1, waits: 0, success: false },
	{ name: "non-Windows EACCES", platform: "darwin", codes: ["EACCES"], attempts: 1, waits: 0, success: false },
	{ name: "non-Windows EBUSY", platform: "linux", codes: ["EBUSY"], attempts: 1, waits: 0, success: false },
	{ name: "other Windows error", platform: "win32", codes: ["ENOENT"], attempts: 1, waits: 0, success: false },
	{ name: "other error after transient", platform: "win32", codes: ["EPERM", "EIO"], attempts: 2, waits: 1, success: false },
];

for (const row of cases) it(`writeAtomicJson: ${row.name}`, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-"));
	const destination = path.join(root, "status.json");
	const oldContent = '{"old":true}';
	const payload = { state: "complete" };
	const content = JSON.stringify(payload, null, 2);
	fs.writeFileSync(destination, oldContent);
	const rename = fs.renameSync;
	const wait = Atomics.wait;
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const errors = row.codes.map((code) => Object.assign(new Error(code), { code }));
	let attempts = 0;
	let waits = 0;
	let temp: fs.PathLike | undefined;
	try {
		Object.defineProperty(process, "platform", { ...platform, value: row.platform });
		fs.renameSync = (source, target) => {
			assert.equal(target, destination);
			if (temp === undefined) temp = source;
			assert.equal(source, temp);
			assert.equal(fs.readFileSync(source, "utf8"), content);
			assert.equal(fs.readFileSync(destination, "utf8"), oldContent);
			assert.equal(waits, attempts);
			const error = errors[attempts++];
			if (error) throw error;
			rename(source, target);
		};
		syncBuiltinESMExports();
		Atomics.wait = (array, index, value, timeout) => {
			assert.ok(array instanceof Int32Array);
			assert.ok(array.buffer instanceof SharedArrayBuffer);
			assert.equal(array.byteLength, 4);
			assert.equal(index, 0);
			assert.equal(value, 0);
			assert.equal(timeout, 50);
			assert.equal(attempts, ++waits);
			assert.equal(fs.readFileSync(destination, "utf8"), oldContent);
			return "timed-out";
		};
		if (row.success) writeAtomicJson(destination, payload);
		else assert.throws(() => writeAtomicJson(destination, payload), (error) => error === errors[row.attempts - 1]);
		assert.equal(attempts, row.attempts);
		assert.equal(waits, row.waits);
		assert.equal(fs.readFileSync(destination, "utf8"), row.success ? content : oldContent);
		assert.deepEqual(fs.readdirSync(root), ["status.json"]);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
		Atomics.wait = wait;
		Object.defineProperty(process, "platform", platform);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
