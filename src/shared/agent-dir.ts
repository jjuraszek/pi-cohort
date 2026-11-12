import * as os from "node:os";
import * as path from "node:path";

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), ".pi", "agent");
}

// A child launched with a settings override has PI_CODING_AGENT_DIR pointing at a
// per-child overlay of the real agent directory, which this variable names. Run
// state and the child's own children stay on the real directory.
export const SUBAGENT_BASE_AGENT_DIR_ENV = "PI_SUBAGENT_BASE_AGENT_DIR";

export const PINNED_AGENT_DIR = path.resolve(process.env[SUBAGENT_BASE_AGENT_DIR_ENV] || getAgentDir());
export const PINNED_AGENT_DIR_OVERRIDE = process.env.PI_CODING_AGENT_DIR ? PINNED_AGENT_DIR : undefined;

/** Pin a child's launch env to the parent's agent directory, unless the env carries the child's own overlay. */
export function pinChildAgentDir(env: Record<string, string | undefined>): void {
	if (PINNED_AGENT_DIR_OVERRIDE && !env[SUBAGENT_BASE_AGENT_DIR_ENV]) env.PI_CODING_AGENT_DIR = PINNED_AGENT_DIR_OVERRIDE;
}
