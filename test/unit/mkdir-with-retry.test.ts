import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirWithEpermRetry } from "../../src/extension/mkdir-with-retry.ts";

function captureThrown(callback: () => void): unknown {
	try {
		callback();
	} catch (error) {
		return error;
	}
	throw new Error("Expected callback to throw");
}

describe("mkdirWithEpermRetry", () => {
	it("creates the directory immediately without waiting", () => {
		const mkdirPaths: string[] = [];
		const waits: number[] = [];

		mkdirWithEpermRetry("dir", {
			mkdir: (path) => mkdirPaths.push(path),
			wait: (milliseconds) => waits.push(milliseconds),
		});

		assert.deepEqual(mkdirPaths, ["dir"]);
		assert.deepEqual(waits, []);
	});

	it("retries one transient EPERM after one second", () => {
		const mkdirPaths: string[] = [];
		const waits: number[] = [];
		let calls = 0;

		mkdirWithEpermRetry("dir", {
			mkdir: (path) => {
				mkdirPaths.push(path);
				calls += 1;
				if (calls === 1) throw { code: "EPERM" };
			},
			wait: (milliseconds) => waits.push(milliseconds),
		});

		assert.deepEqual(mkdirPaths, ["dir", "dir"]);
		assert.deepEqual(waits, [1000]);
	});

	it("retries two transient EPERMs", () => {
		const mkdirPaths: string[] = [];
		const waits: number[] = [];
		let calls = 0;

		mkdirWithEpermRetry("dir", {
			mkdir: (path) => {
				mkdirPaths.push(path);
				calls += 1;
				if (calls < 3) throw { code: "EPERM" };
			},
			wait: (milliseconds) => waits.push(milliseconds),
		});

		assert.deepEqual(mkdirPaths, ["dir", "dir", "dir"]);
		assert.deepEqual(waits, [1000, 1000]);
	});

	it("rethrows a persistent EPERM after three attempts", () => {
		const error = { code: "EPERM" };
		const mkdirPaths: string[] = [];
		const waits: number[] = [];

		const thrown = captureThrown(() =>
			mkdirWithEpermRetry("dir", {
				mkdir: (path) => {
					mkdirPaths.push(path);
					throw error;
				},
				wait: (milliseconds) => waits.push(milliseconds),
			}),
		);

		assert.strictEqual(thrown, error);
		assert.deepEqual(mkdirPaths, ["dir", "dir", "dir"]);
		assert.deepEqual(waits, [1000, 1000]);
	});

	it("rethrows an immediate EACCES unchanged", () => {
		const error = { code: "EACCES" };
		const mkdirPaths: string[] = [];
		const waits: number[] = [];

		const thrown = captureThrown(() =>
			mkdirWithEpermRetry("dir", {
				mkdir: (path) => {
					mkdirPaths.push(path);
					throw error;
				},
				wait: (milliseconds) => waits.push(milliseconds),
			}),
		);

		assert.strictEqual(thrown, error);
		assert.deepEqual(mkdirPaths, ["dir"]);
		assert.deepEqual(waits, []);
	});

	it("stops retrying when EPERM is followed by EACCES", () => {
		const eperm = { code: "EPERM" };
		const eacces = { code: "EACCES" };
		const mkdirPaths: string[] = [];
		const waits: number[] = [];
		let calls = 0;

		const thrown = captureThrown(() =>
			mkdirWithEpermRetry("dir", {
				mkdir: (path) => {
					mkdirPaths.push(path);
					calls += 1;
					throw calls === 1 ? eperm : eacces;
				},
				wait: (milliseconds) => waits.push(milliseconds),
			}),
		);

		assert.strictEqual(thrown, eacces);
		assert.deepEqual(mkdirPaths, ["dir", "dir"]);
		assert.deepEqual(waits, [1000]);
	});

	for (const value of [null, undefined, 42] as const) {
		it(`rethrows ${String(value)} unchanged`, () => {
			const mkdirPaths: string[] = [];
			const waits: number[] = [];

			const thrown = captureThrown(() =>
				mkdirWithEpermRetry("dir", {
					mkdir: (path) => {
						mkdirPaths.push(path);
						throw value;
					},
					wait: (milliseconds) => waits.push(milliseconds),
				}),
			);

			assert.strictEqual(thrown, value);
			assert.deepEqual(mkdirPaths, ["dir"]);
			assert.deepEqual(waits, []);
		});
	}

	it("propagates a wait failure without another mkdir attempt", () => {
		const eperm = { code: "EPERM" };
		const waitError = new Error("wait failed");
		const mkdirPaths: string[] = [];
		const waits: number[] = [];

		const thrown = captureThrown(() =>
			mkdirWithEpermRetry("dir", {
				mkdir: (path) => {
					mkdirPaths.push(path);
					throw eperm;
				},
				wait: (milliseconds) => {
					waits.push(milliseconds);
					throw waitError;
				},
			}),
		);

		assert.strictEqual(thrown, waitError);
		assert.deepEqual(mkdirPaths, ["dir"]);
		assert.deepEqual(waits, [1000]);
	});
});
