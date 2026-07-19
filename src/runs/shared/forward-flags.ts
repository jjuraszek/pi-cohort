export interface ForwardFlagsConfig {
  forwardParentFlags?: boolean;
}

// Core pi flag names -> value arity. This is the UNION of recognized core flags
// across the supported pi range (0.74-0.80), transcribed from
// @earendil-works/pi-coding-agent dist/cli/args.js. A name present here is never
// forwarded to children. Direction matters: an entry that is core in a NEWER pi
// but absent from an OLDER installed pi is safe (worst case we skip forwarding a
// hypothetical extension flag of the same name); a MISSING entry is the real
// hazard - it would leak a real core flag into the child. The drift tripwire in
// test/unit/forward-flags.test.ts asserts installed-core is a subset of this table.
type Arity = "boolean" | "value" | "value-guarded" | "value-guarded-print";
export const RECOGNIZED_PI_FLAGS: Record<string, Arity> = {
  help: "boolean", version: "boolean", continue: "boolean", resume: "boolean",
  "no-session": "boolean", "no-tools": "boolean", "no-builtin-tools": "boolean",
  "no-extensions": "boolean", "no-skills": "boolean", "no-prompt-templates": "boolean",
  "no-themes": "boolean", "no-context-files": "boolean", verbose: "boolean",
  approve: "boolean", "no-approve": "boolean", offline: "boolean",
  mode: "value", provider: "value", model: "value", "api-key": "value",
  "system-prompt": "value", "append-system-prompt": "value", name: "value",
  session: "value", "session-id": "value", fork: "value", "session-dir": "value",
  models: "value", tools: "value", "exclude-tools": "value", thinking: "value",
  export: "value", extension: "value", skill: "value", "prompt-template": "value",
  theme: "value",
  print: "value-guarded-print", "list-models": "value-guarded",
};
// Short aliases -> long name, so `-p foo` / `-e x` classify correctly.
const SHORT_ALIASES: Record<string, string> = {
  h: "help", v: "version", c: "continue", r: "resume", nt: "no-tools",
  nbt: "no-builtin-tools", ne: "no-extensions", ns: "no-skills",
  np: "no-prompt-templates", nc: "no-context-files", a: "approve", na: "no-approve",
  n: "name", t: "tools", xt: "exclude-tools", p: "print", e: "extension",
};
const EXTENSION_CUSTOMIZATION = new Set(["--extension", "-e", "--no-extensions", "-ne"]);

function consumesNext(arity: Arity, next: string | undefined): boolean {
  if (arity === "value") return next !== undefined;
  if (arity === "value-guarded") return next !== undefined && !next.startsWith("-") && !next.startsWith("@");
  if (arity === "value-guarded-print") return next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"));
  return false;
}

export function deriveForwardedFlags(argv: string[], config: ForwardFlagsConfig): string[] {
  if (config.forwardParentFlags === false) return [];
  if (argv.some((tok) => EXTENSION_CUSTOMIZATION.has(tok))) return [];

  const collected: Array<{ name: string; tokens: string[] }> = [];
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("@") || !tok.startsWith("-")) continue;
    if (tok.startsWith("-") && !tok.startsWith("--")) {
      const alias = SHORT_ALIASES[tok.slice(1)];
      if (alias && consumesNext(RECOGNIZED_PI_FLAGS[alias]!, argv[i + 1])) i++;
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const arity = RECOGNIZED_PI_FLAGS[name];
    if (arity) {
      if (eq === -1 && consumesNext(arity, argv[i + 1])) i++;
      continue;
    }
    if (eq !== -1) {
      collected.push({ name, tokens: [tok] });
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
      collected.push({ name, tokens: [tok, next] });
      i++;
    } else {
      collected.push({ name, tokens: [tok] });
    }
  }

  // Dedup by name, last value wins; first-occurrence position is preserved.
  const lastByName = new Map<string, string[]>();
  for (const { name, tokens } of collected) lastByName.set(name, tokens);
  return [...lastByName.values()].flat();
}
