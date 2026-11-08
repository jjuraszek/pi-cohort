import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { deriveForwardedFlags } from "../../src/runs/shared/forward-flags.ts";

// argv[0]=node, argv[1]=pi entry; real flags start at index 2.
const argv = (...rest: string[]) => ["/node", "/pi", ...rest];

describe("deriveForwardedFlags", () => {
  for (const name of ["no-autofix", "session"]) {
    it(`forwards a trailing boolean --${name} as =true without consuming child flags`, () => {
      const forwarded = deriveForwardedFlags(argv(`--${name}`), {});
      assert.deepEqual(forwarded, [`--${name}=true`]);
      const reparsed = parseArgs([...forwarded, "--session", "child.jsonl"]);
      assert.equal(reparsed.unknownFlags.get(name), "true");
      assert.equal(reparsed.session, "child.jsonl");
      assert.deepEqual(reparsed.messages, []);
    });
  }
  it("forwards --name=value verbatim", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens-level=strict"), {}), ["--lens-level=strict"]);
  });
  it("forwards bare --name value as --name=value", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens-level", "strict"), {}), ["--lens-level=strict"]);
  });
  it("treats bare --name before another flag as boolean", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix", "--other"), {}), ["--no-autofix=true", "--other=true"]);
  });
  it("drops recognized core boolean flags", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--verbose", "--no-mcp", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
  it("drops a core value flag AND its value, even a dash-prefixed value", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--system-prompt", "--literal-prompt", "--no-autofix"), {}), ["--no-autofix=true"]);
    assert.deepEqual(deriveForwardedFlags(argv("--model", "openai/gpt", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
  it("drops guarded core value flags and their values", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--use-theme", "dark", "--no-autofix"), {}), ["--no-autofix=true"]);
    assert.deepEqual(deriveForwardedFlags(argv("--tui-mode", "fullscreen", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
  it("stops at the -- delimiter, dropping the queued prompt and unknown single-dash tokens", () => {
    assert.deepEqual(
      deriveForwardedFlags(argv("--no-autofix", "--lens", "a", "--name", "--", "-x", "--", "<prompt>"), {}),
      ["--no-autofix=true", "--lens=a"],
    );
    assert.deepEqual(deriveForwardedFlags(argv("--append-system-prompt", "/x", "--", "hello world"), {}), []);
  });
  it("ignores extension-customization tokens after the -- delimiter", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix", "--", "--extension"), {}), ["--no-autofix=true"]);
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix", "--", "-ne"), {}), ["--no-autofix=true"]);
  });
  it("treats -- consumed as a core flag's value as a value, not the delimiter", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--name", "--", "--no-autofix"), {}), ["--no-autofix=true"]);
    assert.deepEqual(deriveForwardedFlags(argv("-n", "--", "--no-autofix", "--", "prompt"), {}), ["--no-autofix=true"]);
  });
  it("forwards --no-autofix when --tui-mode is malformed (missing value)", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--tui-mode", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
  it("handles guarded core flags (--print consumes only non-dash next)", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--print", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
  it("round-trips values that pi would misread in two-token form", () => {
    const forwarded = deriveForwardedFlags(argv("--lens=-x", "--other=@notes.md"), {});
    const reparsed = parseArgs(forwarded);
    assert.equal(reparsed.unknownFlags.get("lens"), "-x");
    assert.equal(reparsed.unknownFlags.get("other"), "@notes.md");
    assert.deepEqual(reparsed.fileArgs, []);
  });
  it("forwards a core name written with = as pi reports it (unknown)", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--model=x", "--no-autofix"), {}), ["--model=x", "--no-autofix=true"]);
  });
  it("bails to [] when parent argv customizes extension loading", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--extension", "/x.ts", "--no-autofix"), {}), []);
    assert.deepEqual(deriveForwardedFlags(argv("--no-extensions", "--no-autofix"), {}), []);
    assert.deepEqual(deriveForwardedFlags(argv("-e", "/x.ts", "--no-autofix"), {}), []);
    assert.deepEqual(deriveForwardedFlags(argv("-ne", "--no-autofix"), {}), []);
  });
  it("returns [] when forwardParentFlags is false", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--no-autofix"), { forwardParentFlags: false }), []);
  });
  it("dedupes by name, last value wins, first position kept", () => {
    assert.deepEqual(deriveForwardedFlags(argv("--lens", "a", "--no-autofix", "--lens", "b"), {}), ["--lens=b", "--no-autofix=true"]);
  });
  it("ignores single-dash unknowns, @file, and positionals", () => {
    assert.deepEqual(deriveForwardedFlags(argv("-x", "@notes.md", "hello", "--no-autofix"), {}), ["--no-autofix=true"]);
  });
});
