import * as fs from "node:fs";
import * as path from "node:path";

export function writeAtomicJson(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
		for (let retries = 0; ; retries++) {
			try {
				fs.renameSync(tempPath, filePath);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || retries >= 5) {
					throw error;
				}
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
			}
		}
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}
