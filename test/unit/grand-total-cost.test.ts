import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionTokens } from "../../src/shared/session-tokens.ts";

test("parseSessionTokens sums cost.total across assistant entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-cost-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, [
        JSON.stringify({ message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } } }),
        JSON.stringify({ message: { usage: { input: 20, output: 7, cost: { total: 0.02 } } } }),
        JSON.stringify({ message: { usage: { input: 1, output: 1 } } }),
    ].join("\n"));
    const result = parseSessionTokens(dir) as (ReturnType<typeof parseSessionTokens> & { cost: number });
    assert.equal(result!.total, 44);
    assert.ok(Math.abs(result!.cost - 0.03) < 1e-9);
});

import { recompute, recordMainCost, recordSyncCost, recordAsyncCost, emptyGrandTotal, formatGrandTotal, sumNestedCost, recordExternalCost } from "../../src/extension/grand-total.ts";

test("recompute sums all three sources", () => {
    const gt = emptyGrandTotal();
    recordMainCost(gt, 1.0);
    recordSyncCost(gt, "r1", 0.5);
    recordSyncCost(gt, "r2", 0.25);
    recordAsyncCost(gt, "j1", 2.0);
    assert.ok(Math.abs(recompute(gt) - 3.75) < 1e-9);
});

test("concurrent sync runs sum without double-count; completion does not regress", () => {
    const gt = emptyGrandTotal();
    recordSyncCost(gt, "r1", 0.10);
    recordSyncCost(gt, "r2", 0.20);
    recordSyncCost(gt, "r1", 0.15);
    assert.ok(Math.abs(recompute(gt) - 0.35) < 1e-9);
    recordSyncCost(gt, "r1", 0.15);
    assert.ok(Math.abs(recompute(gt) - 0.35) < 1e-9);
});

test("async eviction does not decrement", () => {
    const gt = emptyGrandTotal();
    recordAsyncCost(gt, "j1", 1.0);
    assert.ok(Math.abs(recompute(gt) - 1.0) < 1e-9);
});

test("zero/absent cost adds nothing, never NaN", () => {
    const gt = emptyGrandTotal();
    recordMainCost(gt, 0);
    recordSyncCost(gt, "r1", Number.NaN);
    assert.equal(Number.isNaN(recompute(gt)), false);
    assert.equal(recompute(gt), 0);
});

test("formatGrandTotal renders three decimals with sigma", () => {
    assert.equal(formatGrandTotal(3.75), "│ Σ$3.750");
});

test("recordSyncCost never lowers an existing value", () => {
    const gt = emptyGrandTotal();
    recordSyncCost(gt, "r1", 0.5);
    recordSyncCost(gt, "r1", 0.2);
    assert.ok(Math.abs(recompute(gt) - 0.5) < 1e-9);
});

test("sumNestedCost sums own + recursive descendants", () => {
    const tree = [
        { totalCost: 1, children: [{ totalCost: 0.5, children: [{ totalCost: 0.25 }] }] },
        { totalCost: 2 },
    ];
    assert.ok(Math.abs(sumNestedCost(tree as any) - 3.75) < 1e-9);
});

test("sumNestedCost handles undefined / missing totalCost", () => {
    assert.equal(sumNestedCost(undefined), 0);
    assert.ok(Math.abs(sumNestedCost([{ children: [{ totalCost: 1 }] }] as any) - 1) < 1e-9);
});

test("subtree total = own + nested via accumulator", () => {
    const gt = emptyGrandTotal();
    recordSyncCost(gt, "r1", 0.5 + sumNestedCost([{ totalCost: 0.25 }] as any));
    assert.ok(Math.abs(recompute(gt) - 0.75) < 1e-9);
});

test("recordAsyncCost never lowers an existing value", () => {
    const gt = emptyGrandTotal();
    recordAsyncCost(gt, "j1", 1.0);
    recordAsyncCost(gt, "j1", 0.0);
    assert.ok(Math.abs(recompute(gt) - 1.0) < 1e-9);
});

test("recordExternalCost: valid payload sets map and returns true", () => {
	const gt = emptyGrandTotal();
	assert.equal(recordExternalCost(gt, { source: "pi-context-prune", totalCost: 0.5 }), true);
	assert.ok(Math.abs(recompute(gt) - 0.5) < 1e-9);
});
test("recordExternalCost: re-emit overwrites same source (no double-count)", () => {
	const gt = emptyGrandTotal();
	recordExternalCost(gt, { source: "s", totalCost: 0.5 });
	recordExternalCost(gt, { source: "s", totalCost: 0.9 });
	assert.ok(Math.abs(recompute(gt) - 0.9) < 1e-9);
});
test("recordExternalCost: two sources sum", () => {
	const gt = emptyGrandTotal();
	recordExternalCost(gt, { source: "a", totalCost: 0.2 });
	recordExternalCost(gt, { source: "b", totalCost: 0.3 });
	assert.ok(Math.abs(recompute(gt) - 0.5) < 1e-9);
});
test("recordExternalCost: clamps negative totalCost to 0, keeps payload", () => {
	const gt = emptyGrandTotal();
	assert.equal(recordExternalCost(gt, { source: "s", totalCost: -5 }), true);
	assert.ok(Math.abs(recompute(gt)) < 1e-9);
});
test("recordExternalCost: rejects non-finite totalCost (false, map untouched)", () => {
	const gt = emptyGrandTotal();
	assert.equal(recordExternalCost(gt, { source: "s", totalCost: Number.NaN }), false);
	assert.equal(recordExternalCost(gt, { source: "s", totalCost: Number.POSITIVE_INFINITY }), false);
	assert.equal(gt.externalCostBySource.size, 0);
});
test("recordExternalCost: rejects empty/missing/whitespace source", () => {
	const gt = emptyGrandTotal();
	assert.equal(recordExternalCost(gt, { source: "", totalCost: 1 }), false);
	assert.equal(recordExternalCost(gt, { source: "   ", totalCost: 1 }), false);
	assert.equal(recordExternalCost(gt, { totalCost: 1 }), false);
	assert.equal(recordExternalCost(gt, null), false);
	assert.equal(gt.externalCostBySource.size, 0);
});
test("recordExternalCost: drops bad optional token field but keeps cost", () => {
	const gt = emptyGrandTotal();
	recordExternalCost(gt, { source: "s", totalCost: 0.4, inputTokens: -3, outputTokens: 100 });
	const entry = gt.externalCostBySource.get("s");
	assert.equal(entry?.inputTokens, undefined);
	assert.equal(entry?.outputTokens, 100);
	assert.ok(Math.abs(recompute(gt) - 0.4) < 1e-9);
});
test("recordExternalCost: ignores unknown extra fields", () => {
	const gt = emptyGrandTotal();
	assert.equal(recordExternalCost(gt, { source: "s", totalCost: 0.1, extra: "x" }), true);
	assert.ok(Math.abs(recompute(gt) - 0.1) < 1e-9);
});
test("recompute folds external alongside main/sync/async", () => {
	const gt = emptyGrandTotal();
	recordMainCost(gt, 1.0);
	recordSyncCost(gt, "r1", 0.5);
	recordAsyncCost(gt, "j1", 0.25);
	recordExternalCost(gt, { source: "e", totalCost: 0.25 });
	assert.ok(Math.abs(recompute(gt) - 2.0) < 1e-9);
});
test("emptyGrandTotal has empty externalCostBySource", () => {
	const gt = emptyGrandTotal();
	assert.ok(gt.externalCostBySource instanceof Map);
	assert.equal(gt.externalCostBySource.size, 0);
});
test("formatGrandTotal prefixes Σ$ with a single leading divider", () => {
	assert.equal(formatGrandTotal(0.042), "│ Σ$0.042");
});

test("monotonic across a scripted sequence", () => {
    const gt = emptyGrandTotal();
    const seq: number[] = [];
    recordMainCost(gt, 0.1); seq.push(recompute(gt));
    recordSyncCost(gt, "r1", 0.2); seq.push(recompute(gt));
    recordAsyncCost(gt, "j1", 0.05); seq.push(recompute(gt));
    recordMainCost(gt, 0.3); seq.push(recompute(gt));
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1]);
});
