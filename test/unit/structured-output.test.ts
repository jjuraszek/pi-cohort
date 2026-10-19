import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import * as structuredOutput from "../../src/runs/shared/structured-output.ts";
import type { JsonSchemaObject } from "../../src/shared/types.ts";

const prefix = "Structured output validation failed: ";
const sentinel = "sensitive-rejected-argument";
const invalidString = structuredOutput.validateStructuredOutputValue({ type: "string" }, null);
assert.equal(invalidString.status, "invalid");
const cases: { name: string; capture?: string; schema: JsonSchemaObject; value?: unknown; error?: string; readError?: boolean }[] = [
	{ name: "null success", capture: '{"status":"success","value":null}', schema: { type: "null" }, value: null },
	{ name: "status user object", capture: '{"status":"success","value":{"status":"DONE"}}', schema: { type: "object" }, value: { status: "DONE" } },
	{ name: "nested envelope", capture: '{"status":"success","value":{"status":"success","value":null}}', schema: { type: "object" }, value: { status: "success", value: null } },
	{ name: "error under null schema", capture: '{"status":"error","message":"validation diagnostic"}', schema: { type: "null" }, error: prefix + "validation diagnostic" },
	{ name: "error under permissive schema", capture: '{"status":"error","message":"validation diagnostic"}', schema: { type: "object" }, error: prefix + "validation diagnostic" },
	{ name: "normalized error", capture: JSON.stringify({ status: "error", message: `${prefix}${prefix}bad\nReceived arguments:\n${sentinel}` }), schema: {}, error: prefix + "bad" },
	{ name: "fallback error", capture: JSON.stringify({ status: "error", message: `${prefix}Received arguments:\n${sentinel}` }), schema: {}, error: prefix + "Invalid structured_output arguments" },
	{ name: "schema-invalid success", capture: '{"status":"success","value":null}', schema: { type: "string" }, error: prefix + invalidString.message },
	{ name: "missing capture", schema: {}, error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." },
	...["{", "null", "[]", '"text"', '{"status":"unknown"}', '{"status":"success"}', '{"status":"error"}', '{"status":"error","message":1}', '{"status":"error","message":""}', '{"status":"error","message":"   "}', '{"ok":true}'].map((capture) => ({ name: `invalid envelope ${capture}`, capture, schema: {}, readError: true })),
	{ name: "legacy null under null schema", capture: "null", schema: { type: "null" }, readError: true },
];

for (const row of cases) {
	it(`reads capture: ${row.name}`, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "structured-reader-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "capture.json");
			fs.writeFileSync(schemaPath, JSON.stringify(row.schema));
			if (row.capture !== undefined) fs.writeFileSync(outputPath, row.capture);
			const result = structuredOutput.readStructuredOutput({ schema: row.schema, schemaPath, outputPath });
			if (row.readError) {
				assert.match(result.error ?? "", /^Failed to read structured output:/);
				assert.equal(Object.hasOwn(result, "value"), false);
			} else if (row.error) {
				assert.deepEqual(result, { error: row.error });
			} else {
				assert.deepEqual(result, { value: row.value });
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}

const diagnostics: { name: string; content: unknown; expected?: string }[] = [
	{ name: "execute rejection", content: prefix + "root: invalid", expected: "root: invalid" },
	{ name: "parameter rejection", content: `Validation failed for tool "structured_output":\n  - value: Required\n\nReceived arguments:\n${sentinel}`, expected: "- value: Required" },
	{ name: "parse rejection", content: `Invalid arguments for tool "structured_output": Unexpected token ${sentinel}`, expected: "Invalid structured_output arguments" },
	{ name: "repeated prefix", content: prefix + prefix + " bad ", expected: "bad" },
	{ name: "empty diagnostic", content: prefix, expected: "Invalid structured_output arguments" },
	{ name: "only argument dump", content: prefix + `Received arguments: ${sentinel}`, expected: "Invalid structured_output arguments" },
	...["Aborted", "Output token limit reached", "ENOENT: capture", 'Validation failed for tool "bash": invalid', `dump: ${prefix}bad`].map((content) => ({ name: content, content })),
	{ name: "non-text", content: null },
];
for (const row of diagnostics) {
	it(`classifies diagnostic: ${row.name}`, () => {
		assert.equal(structuredOutput.getStructuredOutputValidationDiagnostic(row.content), row.expected);
	});
}
