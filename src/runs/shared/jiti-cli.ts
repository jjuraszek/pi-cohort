import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

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

function resolveJitiCliPath(piPackageRoot: string): string | undefined {
	const require = createRequire(path.join(piPackageRoot, "package.json"));
	const candidates = [
		() => require.resolve("jiti/package.json"),
		() => path.join(piPackageRoot, "node_modules", "jiti", "package.json"),
	];
	for (const candidate of candidates) {
		try {
			const cliPath = resolveJitiCliFromPackageJson(candidate());
			if (cliPath) return cliPath;
		} catch {
			// Package exports may hide package.json; try the selected install's layout.
		}
	}
	return undefined;
}

// Pi's extension loader aliases these to its own copies; the detached runner boots
// under the bare jiti CLI, so it gets the same map through JITI_ALIAS.
const HOST_ALIASED_SPECIFIERS = ["typebox", "typebox/compile", "typebox/value"];

export function resolveHostModuleAliases(piPackageRoot: string): Record<string, string> {
	const require = createRequire(path.join(piPackageRoot, "package.json"));
	const aliases: Record<string, string> = {};
	for (const specifier of HOST_ALIASED_SPECIFIERS) {
		try {
			aliases[specifier] = require.resolve(specifier);
		} catch (cause) {
			throw new Error(`Cannot resolve required alias ${specifier} from selected Pi installation ${piPackageRoot}`, { cause });
		}
	}
	return aliases;
}

export function createJitiCliResolver(deps: { resolve?: (piPackageRoot: string) => string | undefined; exists?: (p: string) => boolean } = {}): (piPackageRoot: string) => string | undefined {
	const resolve = deps.resolve ?? resolveJitiCliPath;
	const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
	return (piPackageRoot) => {
		const cliPath = resolve(piPackageRoot);
		return cliPath && exists(cliPath) ? cliPath : undefined;
	};
}

export const ensureJitiCliPath = createJitiCliResolver();
