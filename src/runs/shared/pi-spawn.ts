import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (true) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		if (dir === path.dirname(dir)) return undefined;
		dir = path.dirname(dir);
	}
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// Non-launch package inspection is best-effort.
		return undefined;
	}
}

export interface PiRuntimeIdentity {
	readonly nodeExecPath: string;
	readonly piEntryPath: string;
	readonly piPackageRoot: string;
}

export class PiRuntimeLaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiRuntimeLaunchError";
	}
}

function canonicalPath(value: string | undefined, source: string): string {
	if (!value) throw new PiRuntimeLaunchError(`${source}: runtime path was not recorded`);
	try {
		return fs.realpathSync.native(value);
	} catch (error) {
		throw new PiRuntimeLaunchError(`${source} ${value}: ${String(error)}`);
	}
}

function owningPackageRoot(entry: string): string {
	let dir = path.dirname(entry);
	while (true) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
				if (pkg?.name !== PI_CODING_AGENT_PACKAGE) {
					throw new PiRuntimeLaunchError(`${entry}: owning package ${manifest} is not ${PI_CODING_AGENT_PACKAGE}`);
				}
				const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
				if (typeof bin !== "string" || !bin) {
					throw new PiRuntimeLaunchError(`${manifest}: missing declared Pi bin for ${entry}`);
				}
				if (canonicalPath(path.resolve(dir, bin), "Declared Pi bin") !== entry) {
					throw new PiRuntimeLaunchError(`${entry}: does not match declared Pi bin in ${manifest}`);
				}
				return dir;
			} catch (error) {
				if (error instanceof PiRuntimeLaunchError) throw error;
				throw new PiRuntimeLaunchError(`${manifest} for ${entry}: ${String(error)}`);
			}
		}
		if (dir === path.dirname(dir)) throw new PiRuntimeLaunchError(`${entry}: no owning ${PI_CODING_AGENT_PACKAGE} package`);
		dir = path.dirname(dir);
	}
}

function checkAvailability(file: string, executable: boolean): void {
	try {
		if (!fs.statSync(file).isFile()) throw new Error("not a file");
		fs.accessSync(file, executable ? fs.constants.X_OK : fs.constants.R_OK);
	} catch (error) {
		throw new PiRuntimeLaunchError(`${file}: ${String(error)}`);
	}
}

export function capturePiRuntime(deps: { execPath?: string; argv1?: string } = {}): PiRuntimeIdentity {
	const nodeExecPath = canonicalPath(deps.execPath ?? process.execPath, "Node executable");
	const piEntryPath = canonicalPath(deps.argv1 ?? process.argv[1], "Pi entry");
	checkAvailability(nodeExecPath, true);
	checkAvailability(piEntryPath, false);
	const piPackageRoot = canonicalPath(owningPackageRoot(piEntryPath), "Pi package root");
	return { nodeExecPath, piEntryPath, piPackageRoot };
}

export function parsePiRuntime(value: unknown, source: string): PiRuntimeIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PiRuntimeLaunchError(`${source}: original runtime was not recorded; a new run is required`);
	}
	const record = value as Record<string, unknown>;
	for (const field of ["nodeExecPath", "piEntryPath", "piPackageRoot"] as const) {
		if (typeof record[field] !== "string" || !record[field] || !path.isAbsolute(record[field])) {
			throw new PiRuntimeLaunchError(`${source}: invalid runtime ${field} ${String(record[field])}; a new run is required`);
		}
	}
	return { nodeExecPath: record.nodeExecPath as string, piEntryPath: record.piEntryPath as string, piPackageRoot: record.piPackageRoot as string };
}

export function getPiSpawnCommand(args: string[], runtime: PiRuntimeIdentity): { command: string; args: string[] } {
	checkAvailability(runtime.nodeExecPath, true);
	checkAvailability(runtime.piEntryPath, false);
	const root = owningPackageRoot(runtime.piEntryPath);
	if (root !== runtime.piPackageRoot) {
		throw new PiRuntimeLaunchError(`${runtime.piEntryPath}: owning package ${root} does not match ${runtime.piPackageRoot}`);
	}
	return { command: runtime.nodeExecPath, args: [runtime.piEntryPath, ...args] };
}
