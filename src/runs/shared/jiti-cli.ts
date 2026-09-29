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

function hostResolveCandidates(specifier: string): Array<() => string | undefined> {
	return [
		() => require.resolve(specifier),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve(specifier)
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve(specifier);
		},
	];
}

function resolveJitiCliPath(): string | undefined {
	const candidates = [
		...hostResolveCandidates("jiti/package.json"),
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

function resolveFromHost(specifier: string): string | undefined {
	for (const candidate of hostResolveCandidates(specifier)) {
		try {
			const resolved = candidate();
			if (resolved) return resolved;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

// Pi's extension loader aliases these to its own copies; the detached runner boots
// under the bare jiti CLI, so it gets the same map through JITI_ALIAS.
const HOST_ALIASED_SPECIFIERS = ["typebox", "typebox/compile", "typebox/value"];

export function resolveHostModuleAliases(): Record<string, string> {
	const aliases: Record<string, string> = {};
	for (const specifier of HOST_ALIASED_SPECIFIERS) {
		const resolved = resolveFromHost(specifier);
		if (resolved) aliases[specifier] = resolved;
	}
	return aliases;
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
