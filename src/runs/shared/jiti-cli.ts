import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { resolvePiPackageRoot } from "./pi-spawn.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => piPackageRoot ? path.join(piPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

export function createJitiCliResolver(deps: { resolve?: () => string | undefined; exists?: (p: string) => boolean } = {}): () => string | undefined {
	const resolve = deps.resolve ?? resolveJitiCliPath;
	const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
	let cached = resolve();
	return () => {
		if (cached && exists(cached)) return cached;
		cached = resolve();
		if (cached && exists(cached)) return cached;
		cached = undefined;
		return undefined;
	};
}

export const ensureJitiCliPath = createJitiCliResolver();
