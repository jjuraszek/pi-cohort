import { isDynamicParallelStep, isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { StopCondition, StopMatch, StopRecord } from "../../shared/types.ts";
import { assertJsonPointer, DynamicFanoutError, resolveJsonPointer } from "./dynamic-fanout.ts";

export interface StopEvaluationTask {
	agent: string;
	as?: string;
	label?: string;
	exitCode: number | null | undefined;
	structuredOutput?: unknown;
}

/** Shape check for one condition value; `label` prefixes the message (`Chain step 1 stopOn`, `config.steps[0].stopOn`). */
export function stopConditionShapeError(value: unknown, label: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return `${label} must be an object with path and in.`;
	const record = value as Record<string, unknown>;
	try {
		if (typeof record.path !== "string") throw new DynamicFanoutError("Invalid JSON Pointer type.");
		assertJsonPointer(record.path, `${label}.path`);
	} catch (error) {
		if (!(error instanceof DynamicFanoutError)) throw error;
		return `${label}.path '${String(record.path)}' is not a JSON Pointer (must be "" or start with "/").`;
	}
	const list = record.in;
	if (!Array.isArray(list) || list.length === 0 || list.some((member) => typeof member !== "string")) {
		return `${label}.in must be a non-empty array of strings.`;
	}
	return undefined;
}

/** Pre-run check across a chain; returns the first error message or undefined. */
export function validateStopConditions(steps: ChainStep[]): string | undefined {
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		const stopOn = (step as { stopOn?: unknown }).stopOn;
		if (stopOn === undefined) continue;
		const stepNumber = stepIndex + 1;
		const shapeError = stopConditionShapeError(stopOn, `Chain step ${stepNumber} stopOn`);
		if (shapeError) return shapeError;
		if (isParallelStep(step)) {
			for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
				if (!step.parallel[taskIndex]!.outputSchema) {
					return `Chain step ${stepNumber} task ${taskIndex + 1} has no outputSchema; stopOn requires one on every task.`;
				}
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			if (!step.parallel.outputSchema) return `Chain step ${stepNumber} task 1 has no outputSchema; stopOn requires one on every task.`;
			continue;
		}
		if (!(step as SequentialStep).outputSchema) return `Chain step ${stepNumber} has stopOn but no outputSchema.`;
	}
	return undefined;
}

function resolveStringAt(value: unknown, pointer: string): string | undefined {
	let resolved: unknown;
	try {
		resolved = resolveJsonPointer(value, pointer, "stopOn.path");
	} catch (error) {
		if (error instanceof DynamicFanoutError) return undefined;
		throw error;
	}
	return typeof resolved === "string" ? resolved : undefined;
}

/** Matches in task order; only exit-0 tasks with structured output are considered. Never throws for data. */
export function evaluateStopCondition(
	condition: StopCondition,
	stepIndex: number,
	tasks: StopEvaluationTask[],
	options: { sequential?: boolean } = {},
): StopMatch[] {
	const matches: StopMatch[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		if (task.exitCode !== 0 || task.structuredOutput === undefined) continue;
		const value = resolveStringAt(task.structuredOutput, condition.path);
		if (value === undefined || !condition.in.includes(value)) continue;
		matches.push({
			stepIndex,
			...(options.sequential ? {} : { taskIndex }),
			...(task.as ? { as: task.as } : {}),
			...(task.label ? { label: task.label } : {}),
			agent: task.agent,
			value,
		});
	}
	return matches;
}

export function buildStopRecord(condition: StopCondition, stepIndex: number, matches: StopMatch[]): StopRecord {
	return { reason: "condition", stepIndex, condition, matches };
}

export function formatStopCondition(condition: StopCondition): string {
	const pointer = condition.path === "" ? '""' : condition.path;
	return `${pointer} in [${condition.in.join(", ")}]`;
}
