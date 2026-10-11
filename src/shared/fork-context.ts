import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolverOptions {
	sessionDirForIndex?: (index: number) => string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const leafId = sessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const openSession = options.openSession
		?? sessionManager.openSession
		?? ((file: string, dir?: string) => SessionManager.open(file, dir));
	const sessionDir = sessionManager.getSessionDir?.();
	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				if (!fs.existsSync(parentSessionFile)) {
					throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
				}
				const destination = options.sessionDirForIndex?.(index);
				if (destination) fs.mkdirSync(destination, { recursive: true });
				const assignedDir = destination ? fs.realpathSync.native(destination) : undefined;
				const sourceManager = openSession(parentSessionFile, destination ?? sessionDir);
				const sessionFile = sourceManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a forked session file.");
				}
				if (!fs.existsSync(sessionFile)) {
					throw new Error(`Session manager returned a forked session file that does not exist: ${sessionFile}`);
				}
				if (assignedDir) {
					const relative = path.relative(assignedDir, fs.realpathSync.native(sessionFile));
					if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
						throw new Error(`Forked session file is outside assigned session directory: ${sessionFile}`);
					}
				}
				const resolvedFile = assignedDir ? fs.realpathSync.native(sessionFile) : sessionFile;
				cachedSessionFiles.set(index, resolvedFile);
				return resolvedFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}
