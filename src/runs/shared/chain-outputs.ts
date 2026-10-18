import { isDynamicParallelStep, isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry, SingleResult } from "../../shared/types.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { DynamicFanoutError, hasDynamicFanoutFields, type DynamicFanoutConfig, validateDynamicStepShape } from "./dynamic-fanout.ts";
import { validateStopConditions } from "./stop-conditions.ts";

const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATCH_PATH_FIELD = "patchPath";

/** `name` or `name.patchPath`; anything else is invalid. */
function parseOutputReference(raw: string): { name: string; field?: typeof PATCH_PATH_FIELD } | undefined {
	const dot = raw.indexOf(".");
	const name = dot === -1 ? raw : raw.slice(0, dot);
	if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) return undefined;
	if (dot === -1) return { name };
	return raw.slice(dot + 1) === PATCH_PATH_FIELD ? { name, field: PATCH_PATH_FIELD } : undefined;
}

export class ChainOutputValidationError extends Error {}

function outputNamesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
	if (isDynamicParallelStep(step)) return [step.collect.as];
	const name = (step as SequentialStep).as;
	return name ? [name] : [];
}

function taskTemplatesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.task ?? "{previous}");
	if (isDynamicParallelStep(step)) return [step.parallel.task ?? "{previous}", step.parallel.label ?? ""].filter(Boolean);
	return [(step as SequentialStep).task ?? "{previous}"];
}

export function validateChainOutputBindings(steps: ChainStep[], dynamicFanoutConfig: DynamicFanoutConfig = {}): void {
	const stopError = validateStopConditions(steps);
	if (stopError) throw new ChainOutputValidationError(stopError);
	const worktreeProducers = new Map<string, number>();
	const producerSteps = new Map<string, number>();
	const available = new Set<string>();
	const seen = new Set<string>();
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (hasDynamicFanoutFields(step)) {
			if (!isDynamicParallelStep(step)) {
				throw new ChainOutputValidationError(`Dynamic chain step ${stepIndex + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`);
			}
			try {
				validateDynamicStepShape(step, stepIndex, dynamicFanoutConfig);
			} catch (error) {
				if (error instanceof DynamicFanoutError) throw new ChainOutputValidationError(error.message);
				throw error;
			}
			if (!available.has(step.expand.from.output)) {
				throw new ChainOutputValidationError(`Dynamic chain step ${stepIndex + 1} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`);
			}
		}
		for (const name of outputNamesForStep(step)) {
			if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
				throw new ChainOutputValidationError(`Invalid chain output name '${name}' at step ${stepIndex + 1}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`);
			}
			if (seen.has(name)) {
				throw new ChainOutputValidationError(`Duplicate chain output name '${name}'. Each as name must be unique.`);
			}
			seen.add(name);
		}
		for (const template of taskTemplatesForStep(step)) {
			for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
				const rawReference = match[0];
				const parsed = parseOutputReference(match[1]!);
				if (!parsed) {
					throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}' at step ${stepIndex + 1}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
				}
				if (!available.has(parsed.name)) {
					throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`);
				}
				if (parsed.field === PATCH_PATH_FIELD && !worktreeProducers.has(parsed.name)) {
					const producerStep = producerSteps.get(parsed.name)!;
					throw new ChainOutputValidationError(`Chain step ${stepIndex + 1} references ${rawReference} but step ${producerStep + 1} is not a worktree step.`);
				}
			}
		}
		for (const name of outputNamesForStep(step)) {
			available.add(name);
			producerSteps.set(name, stepIndex);
			if (isParallelStep(step) && step.worktree) worktreeProducers.set(name, stepIndex);
		}
	}
}

export function resolveOutputReferences(template: string, outputs: ChainOutputMap): string {
	return template.replace(OUTPUT_REF_PATTERN, (rawReference, rawName: string) => {
		const parsed = parseOutputReference(rawName);
		if (!parsed) {
			throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}'. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
		}
		const entry = outputs[parsed.name];
		if (!entry) throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
		if (parsed.field !== PATCH_PATH_FIELD) return entry.text;
		if (entry.patchPath) return entry.patchPath;
		const reason = entry.patchError ? `capture failed: ${entry.patchError}` : "no changes";
		throw new ChainOutputValidationError(`Output '${parsed.name}' has no patch (${reason}).`);
	});
}

function compactStructuredText(value: unknown): string {
	return JSON.stringify(value);
}

export interface OutputEntryPatchInfo {
	patchPath?: string;
	patchError?: string;
}

function patchFields(patch: OutputEntryPatchInfo | undefined): Pick<ChainOutputMapEntry, "patchPath" | "patchError"> {
	if (!patch) return {};
	return {
		...(patch.patchPath ? { patchPath: patch.patchPath } : {}),
		...(patch.patchError ? { patchError: patch.patchError } : {}),
	};
}

export function outputEntryFromResult(result: SingleResult, stepIndex: number, patch?: OutputEntryPatchInfo): ChainOutputMapEntry {
	return {
		...patchFields(patch),
		text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : getSingleResultOutput(result),
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		agent: result.agent,
		stepIndex,
	};
}

export function outputEntryFromAsyncResult(result: { agent: string; output: string; structuredOutput?: unknown }, stepIndex: number, patch?: OutputEntryPatchInfo): ChainOutputMapEntry {
	return {
		...patchFields(patch),
		text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : result.output,
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		agent: result.agent,
		stepIndex,
	};
}
