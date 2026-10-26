import { selectExecutionBackend } from "./selection.ts";
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
	const preference = input.userConfig.executionBackend ?? "auto";
	return selectExecutionBackend(preference, input.preparation);
}
