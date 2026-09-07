import { mkdirSync } from "node:fs";

type MkdirWithEpermRetryDeps = {
	mkdir?: (path: string) => void;
	wait?: (milliseconds: number) => void;
};

const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 3;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function sleep(delayMs: number): void {
	Atomics.wait(waitArray, 0, 0, delayMs);
}

export function mkdirWithEpermRetry(dirPath: string, deps: MkdirWithEpermRetryDeps = {}): void {
	const mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
	const wait = deps.wait ?? sleep;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		try {
			mkdir(dirPath);
			return;
		} catch (error) {
			if (
				!(typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") ||
				attempt === MAX_ATTEMPTS
			) {
				throw error;
			}
			wait(RETRY_DELAY_MS);
		}
	}
}
