import { selectExecutionBackend } from "./selection.ts";
import { readProjectExecutionBackend } from "../agents/agents.ts";
import type { ExtensionConfig } from "../shared/types.ts";
import type { ExecutionBackendPreparation, ExecutionBackendSelectionResult } from "./selection.ts";

export interface ConfiguredSelectionInput {
	readonly cwd: string;
	readonly userConfig: ExtensionConfig;
	/** @internal Detached coordinator registration loader. */
	readonly preparation?: ExecutionBackendPreparation;
}

export async function selectConfiguredExecutionBackend(
	input: ConfiguredSelectionInput,
): Promise<ExecutionBackendSelectionResult> {
	const projectPreference = readProjectExecutionBackend(input.cwd);
	const preference = projectPreference ?? input.userConfig.executionBackend ?? "auto";
	return selectExecutionBackend(preference, input.preparation);
}
