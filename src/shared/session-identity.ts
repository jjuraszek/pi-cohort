interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

interface SessionLabelManager {
	getSessionName(): string | undefined;
	getSessionId(): string;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}

/** The session's display name, or its id when unnamed. */
export function resolveSessionLabel(sessionManager: SessionLabelManager): string {
	return sessionManager.getSessionName() || sessionManager.getSessionId();
}
