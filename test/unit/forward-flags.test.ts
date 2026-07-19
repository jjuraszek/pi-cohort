import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveForwardedFlags, RECOGNIZED_PI_FLAGS } from "../../src/runs/shared/forward-flags.ts";

// argv[0]=node, argv[1]=pi entry; real flags start at index 2.
const argv = (...rest: string[]) => ["/node", "/pi", ...rest];

describe("deriveForwardedFlags", () => {
  it("forwards a boolean extension flag", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix"), {}), ["--no-autofix"]);
  });
  it("forwards --name=value verbatim", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens-level=strict"), {}), ["--lens-level=strict"]);
  });
  it("forwards bare --name value as two tokens", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens-level", "strict"), {}), ["--lens-level", "strict"]);
  });
  it("treats bare --name before another flag as boolean", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix", "--other"), {}), ["--no-autofix", "--other"]);
  });
  it("drops recognized core boolean flags", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--verbose", "--no-autofix"), {}), ["--no-autofix"]);
  });
  it("drops a core value flag AND its value, even a dash-prefixed value", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--system-prompt", "--literal-prompt", "--no-autofix"), {}), ["--no-autofix"]);
    assert.deepEqual(deriveForwardedFlags(argv("--model", "openai/gpt", "--no-autofix"), {}), ["--no-autofix"]);
  });
  it("handles guarded core flags (--print consumes only non-dash next)", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--print", "--no-autofix"), {}), ["--no-autofix"]);
  });
  it("bails to [] when parent argv customizes extension loading", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--extension", "/x.ts", "--no-autofix"), {}), []);
    assert.deepEqual(deriveForwardedFlags(argv("--no-extensions", "--no-autofix"), {}), []);
    assert.deepEqual(deriveForwardedFlags(argv("-e", "/x.ts", "--no-autofix"), {}), []);
  });
  it("returns [] when forwardParentFlags is false", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix"), { forwardParentFlags: false }), []);
  });
  it("dedupes by name, last-wins", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens-level", "a", "--lens-level", "b"), {}), ["--lens-level", "b"]);
  });
  it("ignores single-dash unknowns, @file, and positionals", () => {
    assert.deepEqual(deriveForwardedFlags(argv("-x", "@notes.md", "hello", "--no-autofix"), {}), ["--no-autofix"]);
  });

  it("recognizes every core --long flag in the installed pi (drift tripwire)", () => {
    let argsJsPath: string | undefined;
    try {
      const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const mainPath = fileURLToPath(mainUrl);
      const marker = `${path.sep}dist${path.sep}`;
      const idx = mainPath.indexOf(marker);
      if (idx !== -1) argsJsPath = path.join(mainPath.slice(0, idx), "dist", "cli", "args.js");
    } catch {
      argsJsPath = undefined;
    }
    if (!argsJsPath || !fs.existsSync(argsJsPath)) {
      // pi package not resolvable in this environment; nothing to check against.
      return;
    }
    const src = fs.readFileSync(argsJsPath, "utf-8");
    const recognized = new Set<string>();
    for (const m of src.matchAll(/"--[a-z][a-z-]*"/g)) {
      const name = m[0].slice(3, -1); // strip the leading "-- and trailing "
      recognized.add(name);
    }
    const missing = [...recognized].filter((name) => !(name in RECOGNIZED_PI_FLAGS));
    assert.deepEqual(missing, [], `core flags recognized by installed pi but absent from RECOGNIZED_PI_FLAGS: ${missing.join(", ")}`);
  });
});
