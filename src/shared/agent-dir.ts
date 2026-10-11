import * as os from "node:os";
import * as path from "node:path";

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), ".pi", "agent");
}

export const PINNED_AGENT_DIR = path.resolve(getAgentDir());
export const PINNED_AGENT_DIR_OVERRIDE = process.env.PI_CODING_AGENT_DIR ? PINNED_AGENT_DIR : undefined;
