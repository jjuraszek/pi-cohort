import { replayExecutionSession, type ReplayedSession } from "./session-replay.ts";
import type { ExecutionReportIdentity } from "./reporting-protocol.ts";

export interface SessionWatcherHandle {
	close(): void;
}

export interface SessionWatcherDependencies {
	watch(sessionFile: string, listener: () => void, onError: (error: Error) => void): SessionWatcherHandle;
	readFile(sessionFile: string): Promise<string>;
}

export interface SessionWatcher {
	/** Resolves with the durable terminal replay, or rejects on malformed/correlation-violating data. Never fabricates a result. */
	readonly terminal: Promise<ReplayedSession & { readonly result: NonNullable<ReplayedSession["result"]> }>;
	/** Idempotent. Stops watching. Rejects `terminal` if it has not already settled. */
	close(): void;
}

/**
 * Callback invoked for each newly accepted session message entry as it is observed
 * during file reads. Fired at entry granularity, deduplicated across repeated reads
 * and resumed history. Never called after the terminal result has settled.
 */
export type OnNewSessionMessage = (message: ReplayedSession["messages"][number]) => void;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export function createSessionWatcher(
	sessionFile: string,
	identity: ExecutionReportIdentity,
	dependencies: SessionWatcherDependencies,
	onNewMessage?: OnNewSessionMessage,
): SessionWatcher {
	let closed = false;
	let settled = false;
	let resolveTerminal!: (value: ReplayedSession & { result: NonNullable<ReplayedSession["result"]> }) => void;
	let rejectTerminal!: (error: Error) => void;
	const terminal = new Promise<ReplayedSession & { result: NonNullable<ReplayedSession["result"]> }>((resolve, reject) => {
		resolveTerminal = resolve;
		rejectTerminal = reject;
	});
	void terminal.catch(() => {});

	let pending = false;
	let dirty = false;
	let seenMessageCount = 0;

	const settleError = (error: Error): void => {
		if (settled) return;
		settled = true;
		rejectTerminal(error);
	};
	const settleResult = (replayed: ReplayedSession & { result: NonNullable<ReplayedSession["result"]> }): void => {
		if (settled) return;
		settled = true;
		resolveTerminal(replayed);
	};

	const processOnce = async (): Promise<void> => {
		if (pending) {
			dirty = true;
			return;
		}
		pending = true;
		try {
			do {
				dirty = false;
				let content: string;
				try {
					content = await dependencies.readFile(sessionFile);
				} catch (error) {
					if (isErrnoException(error) && error.code === "ENOENT") {
						content = "";
					} else {
						settleError(asError(error));
						return;
					}
				}
				let replayed: ReplayedSession;
				try {
					replayed = replayExecutionSession(content, identity);
				} catch (error) {
					settleError(asError(error));
					return;
				}
				if (onNewMessage) {
					for (let i = seenMessageCount; i < replayed.pendingMessages.length; i++) {
						onNewMessage(replayed.pendingMessages[i]);
					}
					seenMessageCount = replayed.pendingMessages.length;
				}
				if (replayed.result) {
					settleResult(replayed as ReplayedSession & { result: NonNullable<ReplayedSession["result"]> });
					return;
				}
			} while (dirty && !closed && !settled);
		} finally {
			pending = false;
		}
	};

	const handle = dependencies.watch(sessionFile, () => {
		if (closed || settled) return;
		void processOnce();
	}, error => settleError(error));
	void processOnce();

	return {
		terminal,
		close() {
			if (closed) return;
			closed = true;
			handle.close();
			settleError(new Error("session watcher closed"));
		},
	};
}
