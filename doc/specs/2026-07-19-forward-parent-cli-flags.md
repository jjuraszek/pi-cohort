# Forward parent pi CLI flags into spawned children (universal argv derivation)

- Issue: jjuraszek/pi-cohort#2
- Status: spec (brainstorming complete, awaiting approval)
- Worktree: `.worktrees/forward-parent-cli-flags` (branch `feat/forward-parent-cli-flags`)

## Problem

pi-cohort runs every subagent as an out-of-process child `pi`. Child argv is built
fresh by `buildPiArgs` (`src/runs/shared/pi-args.ts`); it never reads the parent's
launch argv, so any flag the human passed to the top-level `pi` is dropped in every
child. Motivating failure: launching `pi --no-autofix` (a pi-lens flag) does not
carry into children, so child editors re-run autofix (e.g. markdownlint re-pads
tables after every edit) despite the human opting out.

The fix must be universal: forward whatever extension flags the human launched with,
not a hardcoded `--no-autofix`. It must cover all dispatch paths (foreground,
sync-background, detached-async) and all nesting depths (fanout children, grandchild
subagents).

## Goals

- Auto-forward extension flags from the current process's launch argv into child pi
  argv, across foreground, sync-background, and detached-async paths, at any depth.
- Universal derivation (any extension flag), zero per-flag configuration.
- A single global kill-switch.
- Never corrupt the child's JSON event stream and never crash the child under the
  supported configuration.

## Non-goals

- No env-var mechanism (`PI_COHORT_CHILD_PI_FLAGS`) - dropped. Only argv-derived
  forwarding ships.
- No per-flag allowlist/denylist user config.
- No upstreaming into pi's own child-spawn (may revisit later; out of scope here).
- No forwarding of pi core flags (they are pi-cohort-controlled or unsafe).
- No attempt to reproduce the parent's `--extension` loading in children (see
  Safety gate); when the parent customizes extension loading, forwarding is disabled
  wholesale instead.

## Ground truth (verified against `@earendil-works/pi-coding-agent` dist)

These facts are load-bearing; they overturned the issue's original proposal and
several first-draft design choices.

1. **`pi.getFlag(name)` is unusable for foreign flags.** `dist/core/extensions/loader.js`:
   `if (!extension.flags.has(name)) return undefined; return runtime.flagValues.get(name);`.
   The gate is per **calling** extension - getFlag returns a value only for a flag
   *this* extension registered. pi-cohort registers no flags, so
   `pi.getFlag("no-autofix")` is always `undefined`. The issue's `ctx.pi.getFlag(...)`
   design cannot work. No public `ExtensionAPI` method enumerates registered flags or
   resolved values (`getFlags()`/`getFlagValues()` live only on the internal runner).
   **The only source of "what the human launched with" is `process.argv`.**

2. **`parseArgs` classification, with per-flag arity (`dist/cli/args.js`).** pi walks
   argv with an explicit recognized-flag table; anything left in `--long` form lands
   in `unknownFlags` and is routed to extensions. Recognized flags and their value
   arity (transcribed from the parser, pi 0.74-0.80):

   | Arity | Flags |
   |---|---|
   | boolean | `--help`/`-h`, `--version`/`-v`, `--continue`/`-c`, `--resume`/`-r`, `--no-session`, `--no-tools`/`-nt`, `--no-builtin-tools`/`-nbt`, `--no-extensions`/`-ne`, `--no-skills`/`-ns`, `--no-prompt-templates`/`-np`, `--no-themes`, `--no-context-files`/`-nc`, `--verbose`, `--approve`/`-a`, `--no-approve`/`-na`, `--offline` |
   | value (always consumes next token, even if it starts with `-`) | `--mode`, `--provider`, `--model`, `--api-key`, `--system-prompt`, `--append-system-prompt`, `--name`/`-n`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--models`, `--tools`/`-t`, `--exclude-tools`/`-xt`, `--thinking`, `--export`, `--extension`/`-e`, `--skill`, `--prompt-template`, `--theme` |
   | value (consumes next unless it starts with `@`, or with `-` and is not the `---` sentinel) | `--print`/`-p` |
   | value (consumes next only if it does not start with `-`/`@`) | `--list-models` |

   `--print`/`-p` and `--list-models` differ (verified against installed
   `dist/cli/args.js`): `--print` consumes its next token when
   `!next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))` -
   i.e. it accepts a `---`-prefixed value - while `--list-models` uses the plainer
   `!next.startsWith("-") && !next.startsWith("@")` guard. The implementation models
   these as two distinct arities (`value-guarded-print` vs `value-guarded`).

   Unknown (extension) `--long` flag rule: `--name=value` -> `(name,value)`; bare
   `--name` -> consume next token as value iff it exists and does not start with
   `-`/`@`, else boolean `true`. `@file` tokens and bare positionals are messages,
   not flags. A lone `-x` unknown is a hard error.

3. **Unknown flag in child = crash.** If a forwarded flag's owning extension is not
   loaded in the child, `applyExtensionFlagValues` emits a `type:"error"` diagnostic
   (`Unknown option: --x`) and `main.js` calls `process.exit(1)`. Diagnostics print
   to stderr (they do not corrupt stdout's JSON stream), but the exit(1) kills the
   run. This drives the extension-discovery safety gate.

4. **Version skew is real.** The repo declares `@earendil-works/pi-coding-agent: "*"`
   (peer floor `^0.74.0`); the host runtime observed is 0.80.10. Parent and each
   child are the *same* `pi` binary (children spawn the same `pi`), so parent and
   child always agree on the flag table - but pi-cohort's transcribed mirror of that
   table (item 2) can drift from a newer pi. See Residual risks.

## Design

Derivation is argv-only and must run only in a true in-process context whose
`process.argv` is the human's launch argv. Two consequences:

- The detached async runner (`subagent-runner.ts`) has argv `[node, jiti, runner,
  cfg]` - never the parent's - so it must never derive; it consumes a pre-computed
  list from its cfg JSON.
- Nesting works automatically: a fanout child (its own in-process `pi`) was itself
  launched with the flags forwarded to it, so re-deriving from *its* `process.argv`
  propagates them to grandchildren. Forwarded flags are extension flags (never core),
  so re-derivation never re-injects pi-cohort's own `buildPiArgs`-set core flags.

**Invariant: derive once per in-process executor from that process's own
`process.argv`; the detached runner is a pure consumer of the threaded list.**

### Component 1 - `deriveForwardedFlags(argv, config)` (new `src/runs/shared/forward-flags.ts`, pure)

Mirrors pi's `parseArgs` classification loop (item 2) rather than subtracting an
approximate denylist - this is what makes value-arity correct.

- If `config.forwardParentFlags === false` -> return `[]` (kill-switch).
- If argv contains any extension-loading customization (`--extension`/`-e` or
  `--no-extensions`/`-ne`) -> return `[]` (Safety gate, below).
- Walk `argv` from index 2 (skip node + pi entry). For each token:
  - Recognized **boolean** core flag -> skip.
  - Recognized **value** core flag -> skip it and its value token, using that flag's
    exact arity (unconditional-consume vs `-`/`@`-guarded). This prevents a core
    flag's value (e.g. `--system-prompt --literal`) from being misread as a
    forwardable flag.
  - `@file` / bare positional -> skip.
  - Bare `-x` (single dash) -> skip (never forwardable).
  - Otherwise a `--long` unknown (extension) flag -> collect using pi's unknown rule:
    `--name=value` verbatim; bare `--name` + eligible next token -> `["--name",
    value]`; else boolean `["--name"]`.
- Dedup the collected extension flags by name, last-wins (matching pi's Map).
- Return the flat token list.

`RECOGNIZED_PI_FLAGS` (name -> arity) is a module constant transcribed from
`dist/cli/args.js`, with a comment pinning the source pi version range and a
maintenance note. There is no separate pi-cohort-owned denylist (pi-cohort registers
no flags; that set is empty).

### Component 2 - `buildPiArgs` changes (`src/runs/shared/pi-args.ts`)

New optional input `forwardedFlags?: string[]`.

- **Gate:** append only when `input.extensions === undefined` (child inherits full
  extension discovery). When an agent restricts extensions, skip silently. Combined
  with the derivation-side bail on parent `--extension`, this closes the guaranteed
  crash path (item 3) on both ends.
- **Append point:** insert the forwarded tokens immediately after `input.baseArgs`,
  ahead of every arg `buildPiArgs` emits itself. Because `buildPiArgs` always emits
  at least the runtime `--extension <subagent-prompt-runtime>` after this point, a
  trailing boolean forwarded flag is always followed by a `--`-prefixed token and can
  never abut the task positional (which `buildPiArgs` appends last) - so the child
  never misreads the task as a flag value. `buildPiArgs` pushes `--extension`
  multiple times by design (runtime + fanout + tool + agent extensions); forwarded
  flags must not perturb that.
- **Dedup scope (corrected):** dedup **only among the forwarded tokens** (Component 1
  already did this; `buildPiArgs` does not re-dedup the whole array). Whole-array
  name-dedup is explicitly forbidden - it would collapse the intentional repeated
  `--extension` args. Collision between a forwarded flag and a `buildPiArgs`-emitted
  flag is structurally impossible: `buildPiArgs` emits only recognized core flags,
  which `deriveForwardedFlags` never emits.

### Component 3 - threading (enumerated hops)

`forwardedFlags: string[]` is added to `ExecutorDeps`
(`src/runs/foreground/subagent-executor.ts`) and computed at each in-process
executor-construction site from that process's own argv:

- `src/extension/index.ts:309` (top parent) and `src/extension/fanout-child.ts:142`
  (nested fanout child) both call `createSubagentExecutor({ ..., forwardedFlags:
  deriveForwardedFlags(process.argv, config) })`. Both already load `config` and run
  in-process with the correct argv.
- Foreground / sync path: the executor passes `deps.forwardedFlags` into
  `RunSyncOptions.forwardedFlags` (new field), consumed at
  `src/runs/foreground/execution.ts:156` -> `buildPiArgs`.
- Detached-async path: the executor passes `deps.forwardedFlags` into the async cfg
  builder (`src/runs/background/async-execution.ts`, cfg objects at ~L483 and ~L718,
  beside the existing `piArgv1`) as `SubagentRunConfig.forwardedFlags` (new field).
- Detached runner: `src/runs/background/subagent-runner.ts:655` reads
  `cfg.forwardedFlags ?? []` and passes it to `buildPiArgs`. It never calls
  `deriveForwardedFlags` (its argv is the runner's, not the human's).

### Component 4 - config (`src/shared/types.ts`)

`ExtensionConfig.forwardParentFlags?: boolean`, default behaviour = forward (only an
explicit `false` disables). Consumed solely inside `deriveForwardedFlags`. Single
global kill-switch; no per-flag config.

### Interface additions (summary)

```
// pi-args.ts - BuildPiArgsInput
forwardedFlags?: string[];

// subagent-executor.ts - ExecutorDeps
forwardedFlags: string[];

// execution.ts - RunSyncOptions
forwardedFlags?: string[];

// subagent-runner.ts - SubagentRunConfig
forwardedFlags?: string[];

// types.ts - ExtensionConfig
forwardParentFlags?: boolean;   // default: forward unless explicitly false
```

## Safety gate and edge cases

- **Forwarded flag with no owning extension in child (crash, item 3).** Two-sided
  mitigation: (a) derivation returns `[]` when the parent argv itself customizes
  extension loading (`--extension`/`-e`/`--no-extensions`), so a parent-loaded
  extension's flag is never orphaned; (b) `buildPiArgs` forwards only when the child
  inherits full discovery (`extensions === undefined`).
- **Residual (accepted, documented): cross-project cwd.** A child whose cwd is in a
  *different* project, where a **project-scoped** extension owning a forwarded flag is
  not discovered, still crashes with exit(1). User-scoped extensions (pi-lens, the
  motivating case) load regardless of cwd and are immune. Escape hatch:
  `forwardParentFlags: false`. Reproducing parent project-scoped extensions in the
  child was considered and rejected (conflicts with `buildPiArgs`'s own extension
  management; disproportionate to a narrow edge).
- **Core-flag value arity.** Handled structurally by mirroring the parser (Component
  1); values of dropped core flags are consumed, not re-classified.
- **Repeated `--extension`.** Preserved - forwarded-only dedup, never whole-array.
- **Restricted-extensions agent.** Silent skip (no per-dispatch stderr note).
- **Detached runner argv.** Never derived from; guards against forwarding
  `[node, jiti, ...]`.

## Testing

Unit tests follow the array-assert style of `test/unit/pi-args.test.ts`.

- **`deriveForwardedFlags`** (`test/unit/`): boolean extension flag forwarded;
  `--name=value` verbatim; bare `--name value` space-consumed; core boolean dropped;
  core value flag + its value dropped (incl. a value that starts with `-`, e.g.
  `--system-prompt --x`); `--print`/`--list-models` conditional-consume; bail to `[]`
  on parent `--extension` / `--no-extensions`; `forwardParentFlags:false` -> `[]`;
  dedup last-wins; single-dash + `@file` + positional ignored.
- **`buildPiArgs`**: `forwardedFlags` appended after `baseArgs` when `extensions ===
  undefined`; dropped when extensions restricted; repeated `--extension` args
  survive; a trailing boolean forwarded flag is followed by a `--` token (never the
  task positional); forwarded-only dedup does not touch non-forwarded args.
- **Threading (unit-level where possible):** async cfg carries `forwardedFlags`;
  `subagent-runner` reads `cfg.forwardedFlags` and does not re-derive.

**Hermetic contract test (required, CI gate).** Prove forwarding end-to-end without
model calls or external packages: install a tiny fixture extension that registers a
throwaway boolean flag, dispatch through the real executor on each path (foreground,
sync, detached-async) with that flag in a controlled argv, and assert the flag lands
in the child's argv (via the child's json event stream or an argv-capture shim), plus
the gate and kill-switch cases. Deterministic; no `pi-lens`, no model dependency.

**pi-lens observable-effect smoke test (separately provisioned).** Additionally,
when `pi-lens` is installed and a model is available, run the real motivating case:
parent launched `pi --no-autofix`, dispatch a child that performs an edit autofix
would otherwise rewrite, and assert the edit is left untouched. This is the real
proof requested for the motivating bug. It is a verify-phase check (running the
proposed change is deferred past brainstorming) and runs as a provisioned smoke test,
not the hermetic CI gate; when pi-lens or a model is absent it is an explicit named
skip, never a silent pass.

## Documentation impact

- Feature / user-facing docs introduced: none (no new standalone doc).
- Materially amended existing docs: `doc/configuration.md` (document the
  `forwardParentFlags` key and the auto-forwarding behaviour + extension-discovery
  gate; README already delegates settings detail there); `README.md` (one-line
  behaviour note where dispatch semantics are described); `CHANGELOG.md`.
- Derived / memory docs invalidated: none.

## Acceptance criteria

1. Parent launched with an extension flag (e.g. `--no-autofix`) and no
   extension-loading customization -> that flag appears in dispatched child argv for
   foreground, sync-background, and detached-async, including nested (fanout ->
   grandchild) dispatch.
2. Parent launched without it -> absent from child argv.
3. Pi core flags (`--model`, `--mode`, `--system-prompt`, `--session*`, `-p`,
   `--extension`, ...) and their values are never forwarded.
4. Parent argv contains `--extension`/`-e`/`--no-extensions` -> nothing forwarded
   (silent bail).
5. Agent with restricted extensions -> nothing forwarded (silent).
6. `forwardParentFlags: false` -> nothing forwarded on any path.
7. Repeated `--extension` args in child argv are preserved unchanged; forwarded-flag
   dedup is last-wins among forwarded tokens only.
8. Unit tests cover 1-7 on the pure functions and threading; the hermetic contract
   test proves per-path argv forwarding + gate + kill-switch; the pi-lens smoke test
   proves the real `--no-autofix` effect (named skip when unavailable).
9. `doc/configuration.md`, `README.md`, and `CHANGELOG.md` updated in the same change.

## Residual risks

- **`RECOGNIZED_PI_FLAGS` drift vs pi releases.** A new core flag absent from the
  mirror is treated as an extension flag and forwarded; since the child is the same
  pi version it parses it as core (no crash), but it is forwarded when it should not
  be. A new core *value* flag is the sharper case: the mirror would treat it as
  boolean and misread its value token. Mitigation: pin the source version in the
  constant's comment, keep a unit test enumerating the expected recognized set as a
  drift tripwire, and note the maintenance obligation. No public pi API exposes the
  table for runtime derivation.
- **pi-lens smoke test provisioning.** Depends on pi-lens + a model in the
  environment; named skip otherwise. The hermetic contract test carries the CI
  guarantee.
