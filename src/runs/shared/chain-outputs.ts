import * as path from "node:path";
import { isDynamicParallelStep, isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry, SingleResult } from "../../shared/types.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { DynamicFanoutError, hasDynamicFanoutFields, type DynamicFanoutConfig, validateDynamicStepShape } from "./dynamic-fanout.ts";
import { materializeTree } from "./worktree.ts";
import { validateStopConditions } from "./stop-conditions.ts";

const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATCH_PATH_FIELD = "patchPath";

/** Only text and filesystem fields are valid output references. */
function parseOutputReference(raw: string): { name: string; field?: "patchPath" | "treePath" } | undefined {
	const dot = raw.indexOf(".");
	const name = dot === -1 ? raw : raw.slice(0, dot);
	if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) return undefined;
	if (dot === -1) return { name };
	const field = raw.slice(dot + 1);
	return field === PATCH_PATH_FIELD || field === "treePath" ? { name, field } : undefined;
}

export class ChainOutputValidationError extends Error {}

function outputNamesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
	if (isDynamicParallelStep(step)) return [step.collect.as];
	const name = (step as SequentialStep).as;
	return name ? [name] : [];
}

function taskTemplatesForStep(step: ChainStep): Array<{ template: string; cwd: boolean }> {
	const templates: Array<{ template: string; cwd: boolean }> = [];
	const add = (value: { task?: string; label?: string; cwd?: string }) => {
		for (const template of [value.task, value.label]) {
			if (template) templates.push({ template, cwd: false });
		}
		if (value.cwd) templates.push({ template: value.cwd, cwd: true });
	};
	if (isParallelStep(step)) {
		if (step.cwd) templates.push({ template: step.cwd, cwd: true });
		for (const task of step.parallel) add(task);
	} else if (isDynamicParallelStep(step)) {
		add(step);
		add(step.parallel);
	} else add(step);
	return templates;
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
		for (const { template, cwd } of taskTemplatesForStep(step)) {
			for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
				const rawReference = match[0];
				const parsed = parseOutputReference(match[1]!);
				if (!parsed) {
					throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}' at step ${stepIndex + 1}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
				}
				if (cwd && parsed.field !== "treePath") {
					throw new ChainOutputValidationError(`Chain step ${stepIndex + 1}: only {outputs.<name>.treePath} may appear in cwd.`);
				}
				if (!available.has(parsed.name)) {
					throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`);
				}
				if (parsed.field && !worktreeProducers.has(parsed.name)) {
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

export function resolveOutputReferences(template: string, outputs: ChainOutputMap, trees?: TreeRegistry): string {
	return template.replace(OUTPUT_REF_PATTERN, (rawReference, rawName: string) => {
		const parsed = parseOutputReference(rawName);
		if (!parsed) {
			throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}'. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
		}
		const entry = outputs[parsed.name];
		if (!entry) throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
		if (parsed.field === "treePath") {
			if (!trees) throw new ChainOutputValidationError(`Output '${parsed.name}' tree registry is unavailable.`);
			return trees.resolve(parsed.name, entry);
		}
		if (!parsed.field) return entry.text;
		if (entry.patchPath) return entry.patchPath;
		const reason = entry.patchError ? `capture failed: ${entry.patchError}` : "no changes";
		throw new ChainOutputValidationError(`Output '${parsed.name}' has no patch (${reason}).`);
	});
}

export class TreeRegistry {
	readonly built = new Map<string, string>();
	readonly created: Array<{ repoCwd: string; dir: string }> = [];

	private readonly chainDir: string;

	constructor(chainDir: string) {
		this.chainDir = chainDir;
	}

	resolve(name: string, entry: ChainOutputMapEntry): string {
		if (this.built.has(name)) return this.built.get(name)!;
		if (!entry.patchPath) {
			const reason = entry.patchError ? `capture failed: ${entry.patchError}` : "no changes";
			throw new ChainOutputValidationError(`Output '${name}' has no patch (${reason}).`);
		}
		const dir = path.join(this.chainDir, "worktree-trees", `step-${entry.stepIndex}`, `task-${entry.taskIndex}-${entry.agent}`);
		this.created.push({ repoCwd: entry.repoCwd!, dir });
		try {
			materializeTree({ repoCwd: entry.repoCwd!, baseCommit: entry.baseCommit!, patchPath: entry.patchPath, dir });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ChainOutputValidationError(`Output '${name}' tree build failed: ${message.split("\n")[0]}`);
		}
		this.built.set(name, dir);
		entry.treePath = dir;
		return dir;
	}
}

function compactStructuredText(value: unknown): string {
	return JSON.stringify(value);
}

export interface OutputEntryPatchInfo {
	taskIndex?: number;
	baseCommit?: string;
	repoCwd?: string;
	patchPath?: string;
	patchError?: string;
}

function patchFields(patch: OutputEntryPatchInfo | undefined): OutputEntryPatchInfo {
	if (!patch) return {};
	return {
		...(patch.taskIndex !== undefined ? { taskIndex: patch.taskIndex } : {}),
		...(patch.baseCommit !== undefined ? { baseCommit: patch.baseCommit } : {}),
		...(patch.repoCwd !== undefined ? { repoCwd: patch.repoCwd } : {}),
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
