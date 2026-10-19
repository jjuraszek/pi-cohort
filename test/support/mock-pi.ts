import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { capturePiRuntime, type PiRuntimeIdentity } from "../../src/runs/shared/pi-spawn.ts";

interface MockPiResponse {
	output?: string;
	stderr?: string;
	exitCode?: number;
	delay?: number;
	keepAliveAfterFinalMessageMs?: number;
	jsonl?: unknown[];
	structuredOutput?: unknown;
	steps?: Array<{
		delay?: number;
		structuredOutput?: unknown;
		structuredOutputError?: string;
		jsonl?: unknown[];
		stderr?: string;
	}>;
	echoEnv?: string[];
	echoRuntime?: boolean;
	echoFiles?: string[];
	echoCwd?: boolean;
	requireAcceptanceStructuredOrder?: boolean;
}

export interface MockPi {
	readonly dir: string;
	readonly runtime: PiRuntimeIdentity;
	captureRuntime(): PiRuntimeIdentity;
	install(): void;
	uninstall(): void;
	onCall(response: MockPiResponse): void;
	reset(): void;
	callCount(): number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "mock-pi-script.mjs");
const CALL_PREFIX = "call-";
const DEFAULT_RESPONSE_FILE = "default-response.json";
const QUEUED_PREFIX = "pending-";

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeExecutable(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
	fs.chmodSync(filePath, 0o755);
}

function listQueueFiles(queueDir: string, prefix: string): string[] {
	try {
		return fs.readdirSync(queueDir)
			.filter((name) => name.startsWith(prefix))
			.sort();
	} catch {
		return [];
	}
}

export function createMockPi(): MockPi {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mock-cli-"));
	const queueDir = path.join(rootDir, "queue");
	const binDir = path.join(rootDir, "bin");
	ensureDir(queueDir);
	ensureDir(binDir);

	const packageRoot = path.join(rootDir, "pi package");
	const entryPath = path.join(packageRoot, "dist", "cli.mjs");
	ensureDir(path.dirname(entryPath));
	fs.copyFileSync(SCRIPT_PATH, entryPath);
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent", type: "module", bin: { pi: "dist/cli.mjs" },
	}));
	const dependencyDir = path.join(packageRoot, "node_modules");
	ensureDir(dependencyDir);
	const require = createRequire(import.meta.url);
	for (const name of ["jiti", "typebox"]) {
		let dependencyRoot = path.dirname(require.resolve(name));
		while (true) {
			const manifest = path.join(dependencyRoot, "package.json");
			if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) break;
			const parent = path.dirname(dependencyRoot);
			if (parent === dependencyRoot) throw new Error(`Cannot find installed ${name} package root`);
			dependencyRoot = parent;
		}
		fs.symlinkSync(fs.realpathSync.native(dependencyRoot), path.join(dependencyDir, name), process.platform === "win32" ? "junction" : "dir");
	}
	const captureRuntime = () => capturePiRuntime({ execPath: process.execPath, argv1: entryPath });
	const runtime = Object.freeze(captureRuntime());
	const shellScriptPath = path.join(binDir, "pi");
	const cmdScriptPath = path.join(binDir, "pi.cmd");
	writeExecutable(shellScriptPath, `#!/bin/sh\nexec "${runtime.nodeExecPath}" "${runtime.piEntryPath}" "$@"\n`);
	writeExecutable(cmdScriptPath, `@echo off\r\n"${runtime.nodeExecPath}" "${runtime.piEntryPath}" %*\r\n`);

	let installed = false;
	let nextSequence = 0;
	let originalPath: string | undefined;
	let originalQueueEnv: string | undefined;

	return {
		runtime,
		captureRuntime,
		get dir() {
			return queueDir;
		},
		install() {
			if (installed) return;
			installed = true;
			originalPath = process.env.PATH;
			originalQueueEnv = process.env.MOCK_PI_QUEUE_DIR;
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			process.env.MOCK_PI_QUEUE_DIR = queueDir;
		},
		uninstall() {
			if (!installed) return;
			installed = false;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalQueueEnv === undefined) delete process.env.MOCK_PI_QUEUE_DIR;
			else process.env.MOCK_PI_QUEUE_DIR = originalQueueEnv;
			try {
				fs.rmSync(rootDir, { recursive: true, force: true });
			} catch {}
		},
		onCall(response) {
			ensureDir(queueDir);
			nextSequence += 1;
			const fileName = `${QUEUED_PREFIX}${String(nextSequence).padStart(6, "0")}.json`;
			const tempPath = path.join(queueDir, `${fileName}.tmp-${process.pid}-${Date.now()}`);
			const finalPath = path.join(queueDir, fileName);
			fs.writeFileSync(tempPath, JSON.stringify(response), "utf-8");
			fs.renameSync(tempPath, finalPath);
			fs.writeFileSync(path.join(queueDir, DEFAULT_RESPONSE_FILE), JSON.stringify(response), "utf-8");
		},
		reset() {
			nextSequence = 0;
			ensureDir(queueDir);
			for (const entry of fs.readdirSync(queueDir)) {
				try {
					fs.rmSync(path.join(queueDir, entry), { recursive: true, force: true });
				} catch {}
			}
		},
		callCount() {
			return listQueueFiles(queueDir, CALL_PREFIX).length;
		},
	};
}
