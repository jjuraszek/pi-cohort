import * as fs from "node:fs";
import * as path from "node:path";
import { PINNED_AGENT_DIR } from "../../shared/agent-dir.ts";

/** settings.json keys a child launches with instead of the parent's values. */
export type ChildSettings = Record<string, unknown>;

// pi reads these from the agent directory's settings.json only and ignores them in project settings.
const USER_ONLY_KEYS = ["defaultProjectTrust", "httpProxy", "selfUpdateCommand"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function childSettingsError(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return `${label} must be an object of settings.json keys.`;
	const userOnly = USER_ONLY_KEYS.find((key) => key in value);
	if (userOnly) return `${label}.${userOnly} cannot be overridden for a child: pi takes it only from the user's own settings.json.`;
	return undefined;
}

// pi's own merge rule: nested objects merge, everything else replaces.
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = base[key];
		result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return result;
}

export function mergeChildSettings(base: ChildSettings | undefined, override: ChildSettings | undefined): ChildSettings | undefined {
	if (!base || !override) return override ?? base;
	return deepMerge(base, override);
}

function readParentSettings(parentDir: string): Record<string, unknown> {
	const filePath = path.join(parentDir, "settings.json");
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
	if (!isPlainObject(parsed)) throw new Error(`'${filePath}' must contain a JSON object`);
	return parsed;
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Create `dir` as the agent directory for one child: every entry links to the
 * parent's, except settings.json, which is the parent's file with `settings` merged in.
 */
export function writeChildAgentDir(dir: string, settings: ChildSettings, parentDir = PINNED_AGENT_DIR): void {
	try {
		const merged = deepMerge(readParentSettings(parentDir), settings);
		fs.mkdirSync(dir, { mode: 0o700 });
		for (const name of fs.existsSync(parentDir) ? fs.readdirSync(parentDir) : []) {
			if (name === "settings.json") continue;
			const target = path.join(parentDir, name);
			fs.symlinkSync(target, path.join(dir, name), isDirectory(target) ? "junction" : "file");
		}
		fs.writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot apply the child's settings override: ${message}`, { cause: error });
	}
}
