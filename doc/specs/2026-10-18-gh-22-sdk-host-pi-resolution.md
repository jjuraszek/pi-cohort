# Resolve the Pi installation for SDK-hosted sessions (#22)

**Goal:** `capturePiRuntime` identifies the running Pi installation when `process.argv[1]` is not Pi's CLI, so subagents start from SDK-hosted sessions (Pi Web, standalone SDK hosts) on the same installation the host loaded, while the CLI-launched path shipped by #19 stays byte-for-byte unchanged.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#22
**Worktree:** `.worktrees/gh-22-sdk-host-pi-resolution`

## Problem

`capturePiRuntime` (`src/runs/shared/pi-spawn.ts:93-100`) canonicalizes `process.argv[1]` and hands it to `owningPackageRoot` (`:56-82`), which walks up to the nearest `package.json` and requires it to be `@earendil-works/pi-coding-agent` with a declared `bin` equal to the entry. In an SDK host `argv[1]` is the host application's entry, so capture throws `owning package .../@jmfederico/pi-web/package.json is not @earendil-works/pi-coding-agent` (`:64`), the executor stores it as `runtimeError` (`src/runs/foreground/subagent-executor.ts:2121-2127`), and every dispatch fails. The README (`README.md:42`) documents this as "Custom hosts whose entry cannot be identified as the installed Pi package's declared CLI are unsupported"; #22 revises that stance.

Premises checked: the ticket's diagnosis holds against the code above, and pi 1.3.0 declares `bin.pi = dist/bundle/cli.js`. One ticket claim is corrected: `import.meta.resolve("@earendil-works/pi-coding-agent")` resolves to the running install only in the unbundled-Node loader branch that passes `{ alias: getAliases() }` to jiti (`dist/core/extensions/loader.js:40-63, 471-476`); the bundled CLI, Bun, and SEA branches use `virtualModules` with no alias, and whether jiti routes `import.meta.resolve` through `alias` is unverified. The design does not depend on it: pi exports `getPackageDir()` from its package index (`dist/index.d.ts:2`, `dist/config.js:316-325`; present in the peer floor 0.85.1 and in 1.3.0), which returns the running installation's root in every loader mode, and pi-cohort already imports runtime values from that package (`src/shared/fork-context.ts:3`).

Framing: kept. Source order decided by the user: `argv[1]` first, exactly as #19 shipped; the installation-derived fallback runs only when `owningPackageRoot(argv1)` rejects.

## Acceptance criteria

Ticket jjuraszek/pi-cohort#22, "Acceptance criteria", rows verbatim:

- [ ] Given a test fixture that starts a Pi session through the SDK from a script whose nearest `package.json` is not Pi's, invoking `subagent` with a valid executable agent starts the child and returns its result, and the spawned Pi entry's package directory (real path, symlinks resolved) equals the installation the fixture loaded the SDK from.
  in-scope
- [ ] Given two Pi installations on the machine, one loaded by the SDK host and another earlier on `PATH`, a child started from the SDK-hosted session launches the Pi entry from the host-loaded installation's package directory (real paths compared), never the `PATH` one.
  in-scope
- [ ] Given a session launched directly through Pi's CLI, subagent execution continues to use the parent's selected Node executable and Pi installation; the existing #19 tests pass unchanged.
  deviates: one #19 test, `retains registration and read-only management when parent capture fails` in `test/unit/index-child-registration.test.ts:18`, asserts that a missing `argv[1]` alone makes capture fail - the premise #22 removes (a parent that loaded Pi falls back to that installation). That test is updated to also point `PI_PACKAGE_DIR` at a missing directory, so capture still fails and the report names that path; every other #19 test file is unedited. The CLI-launched behavior itself (first clause of the row) is in scope and unchanged.
- [ ] Given an SDK-hosted session whose Pi CLI entry is renamed or removed after the parent resolved it and before the child process is spawned, dispatch returns an explicit launch error and no other Pi installation is started.
  in-scope
- [ ] README no longer describes SDK/custom hosts as unsupported; it states how the child's Pi installation is identified when the parent is not launched via Pi's CLI.
  in-scope

Readings adopted as Design clauses: rows 1 and 2 are satisfied by the SDK-host integration fixture in [Tests](#tests), which starts a real session through the SDK of a real `@earendil-works/pi-coding-agent` installation (install A) from a script whose nearest `package.json` is not Pi's, with `PI_PACKAGE_DIR` unset and the executor's `captureRuntime` dep at its default; "the installation the fixture loaded the SDK from" is `realpath` of the package directory that `@earendil-works/pi-coding-agent` resolves to from the repo whose executor module the host imports, and the comparison is `realpath` of the spawned entry's owning package root against it. Row 3's first clause is a Design requirement (the `argv[1]` path is byte-for-byte #19); its "tests pass unchanged" clause carries the `deviates:` disposition above, and the Design clause it adopts is: no #19 test file other than `test/unit/index-child-registration.test.ts` changes, and that file's change is limited to making the fallback fail alongside `argv[1]` in the one test whose premise #22 removes.

## Design

### Import boundary

`src/runs/shared/pi-spawn.ts` is imported by the detached runner (`src/runs/background/subagent-runner.ts:9`, `external-attempt.ts:15`, `src/execution-backend/child-host-controller.ts:10`), which boots under the bare jiti CLI where `@earendil-works/pi-coding-agent` - an optional peer, absent from the installed `pi-cohort`'s `node_modules` - is not resolvable. `pi-spawn.ts` therefore gains no runtime import of that package. The installation lookup lives in the extension process: `src/runs/foreground/subagent-executor.ts`, which already imports pi-coding-agent values at runtime through `src/shared/fork-context.ts:3`, imports `getPackageDir` from `@earendil-works/pi-coding-agent` and passes it in.

### Capture order

`capturePiRuntime(deps)` gains one optional field: `{ execPath?: string; argv1?: string; installRoot?: string }`. With `installRoot` absent the function is byte-for-byte today's behavior (`pi-spawn.ts:93-100`). The body is:

1. Canonicalize `execPath` and run `checkAvailability(nodeExecPath, true)` - unconditional, as today.
2. Identify from `argv1` as today: canonicalize, `checkAvailability(piEntryPath, false)`, `owningPackageRoot(piEntryPath)`. On success return `{ nodeExecPath, piEntryPath, piPackageRoot }`; `installRoot` is never read on this path.
3. If step 2 throws a `PiRuntimeLaunchError` (missing or undefined `argv1`, unreadable entry, or ownership rejection) and `deps.installRoot` is undefined, rethrow - the #19 behavior. If `installRoot` is supplied: canonicalize it, read `<installRoot>/package.json`, require `name === "@earendil-works/pi-coding-agent"` and a `bin` entry named `pi` (string `bin` accepted as `owningPackageRoot` does today), derive `entry = canonicalPath(resolve(installRoot, bin.pi))`, run `checkAvailability(entry, false)`, then run the unchanged `owningPackageRoot(entry)` and require its result to equal the canonical `installRoot` - the "same `owningPackageRoot` check" the user approved, which also rejects a `bin.pi` that resolves through a symlink into another package or under a nearer non-Pi manifest. Return `{ nodeExecPath, piEntryPath: entry, piPackageRoot: installRoot }`. Any failure in this step throws a `PiRuntimeLaunchError` naming the install root and the failed check; no other installation is consulted.

The production caller (`subagent-executor.ts:2123`) becomes `(deps.captureRuntime ?? (() => capturePiRuntime({ installRoot: getPackageDir() })))()`. `ExecutorDeps.captureRuntime` keeps its shape, so existing test wiring (`test/support/mock-pi.ts`, `runtime-parent.mjs`) is untouched.

The returned `PiRuntimeIdentity` has the same three fields as before. Everything downstream - `getPiSpawnCommand` (`pi-spawn.ts:115-123`), `jiti-cli.ts`, the detached coordinator config, `parsePiRuntime`, resume's exact-string comparison - reads only the stored identity and is not changed by this spec. `owningPackageRoot` is not changed: it still returns the canonical directory string that `getPiSpawnCommand` compares, with its current error messages.

### Dead code

`resolvePiPackageRoot`, `resolveInstalledPiPackageRoot`, and `findPiPackageRootFromEntry` (`pi-spawn.ts:7-32`, zero callers outside each other) are deleted.

### Error contract

Capture failure is a `PiRuntimeLaunchError` as today; it lands in `runtimeError` and is reported on dispatch as the current error is. Launch-time errors in `getPiSpawnCommand` (missing entry via `checkAvailability`, ownership recheck) are untouched.

### Edge cases

- **Bun single-file Pi binary.** `getPackageDir()` returns `dirname(execPath)` (`dist/config.js:316-325`), which has no `package.json`; step 3 throws. **Node SEA binary.** `getPackageDir()` has no SEA branch and walks up from its own `__dirname`; whatever it returns is subject to the same name + `bin.pi` + `owningPackageRoot` validation and fails closed when it is not a Pi package with a reachable CLI. Single-file binaries stay unsupported, consistent with the gh-19 spec.
- **`PI_PACKAGE_DIR` set.** Honored because pi's own `getPackageDir()` honors it; the same validation applies. No pi-cohort-specific handling.
- **Two installs, one earlier on `PATH`.** Nothing in capture or launch consults `PATH`; `getPackageDir()` is anchored to the module the host process loaded, so the `PATH` install cannot be selected.
- **Symlinked install roots** (e.g. `~/.pi/agent/install/releases/<v>`). Both root and entry go through `canonicalPath`, so stored paths are real paths, as `argv1` already is.
- **Host that is itself a different pi-coding-agent copy than the SDK it loaded.** `argv[1]` validates and wins; the fallback is not consulted. That is the user's decided order and the #19 behavior.
- **Host whose `process.execPath` is not a Node binary** (Electron, Bun embedding the SDK). The captured `nodeExecPath` is that executable and `getPiSpawnCommand` would run `<exec> <cli.js>`. Out of scope; the README names SDK support as Node-hosted sessions.

## Tests

Unit, in a new `test/unit/pi-spawn-install-root.test.ts` (tests 1-6) and a new `test/unit/executor-runtime-default.test.ts` (test 7), with a mock-package helper of the same shape as `fixture()` in `test/unit/pi-spawn.test.ts:8-19`; the existing #19 test files are not edited (test 10):

1. Non-Pi `argv1` plus `installRoot` pointing at a mock Pi package: `piEntryPath` is `realpath(<installRoot>/<bin.pi>)` and `piPackageRoot` is `realpath(installRoot)`.
2. Valid Pi `argv1` plus an empty temp directory as `installRoot`: the result equals the `argv1`-only capture and `installRoot` is never read (any read of the empty directory would throw). This is the no-regression proof for the CLI path.
3. Non-Pi `argv1` plus `installRoot` whose manifest is not Pi-named, or is Pi-named without `bin.pi`: throws `PiRuntimeLaunchError`.
4. Non-Pi `argv1` plus a Pi-named `installRoot` whose `bin.pi` is a symlink into a second mock Pi package: throws `PiRuntimeLaunchError` (owning root mismatch), and the identity of the second package is never returned.
5. Missing `argv1` (nonexistent path) plus a valid `installRoot`: falls back and succeeds; missing `argv1` without `installRoot` still throws (the existing test at `pi-spawn.test.ts:53-61` already covers the latter).
6. Import boundary: a test walks the static import graph from `src/runs/background/subagent-runner.ts` and asserts no runtime (non-`type`) import of `@earendil-works/*`.
7. Executor wiring: an executor created with the default `captureRuntime` in the test process (whose `argv[1]` is the test file, not Pi), with `PI_PACKAGE_DIR` cleared, answers the `doctor` action with a report that carries no `runtime capture: failed` line (today that process records a capture failure); and `capturePiRuntime({ argv1: <the test file>, installRoot: getPackageDir() })`, with `getPackageDir` imported from `@earendil-works/pi-coding-agent` in the test, returns `piPackageRoot === realpath(getPackageDir())` and `piEntryPath === realpath(<that>/dist/bundle/cli.js)` - the repo's `node_modules` copy, proving the extension-side `getPackageDir()` channel and the value the executor passes.

Integration, in a new `test/integration/runtime-sdk-host.test.ts` with a new standalone host script `test/support/sdk-host-parent.mjs` (`test/support/runtime-parent.mjs` is shared by the #19 tests and is not edited):

8. **SDK host (AC1, AC2).** Install A is the real `@earendil-works/pi-coding-agent` in the repo's `node_modules` (the only real SDK available to the test); install B is `createMockPi()` from `test/support/mock-pi.ts`, placed first on `PATH`. The test copies the host script into a temp package named `@test/sdk-host` (its own `package.json`, nearest to the script) and runs it with `node --import test/support/register-loader.mjs <temp>/host.mjs <request.json>`, so `process.argv[1]` is the host script. The host builds pi-cohort's real executor (`createSubagentExecutor` from `src/runs/foreground/subagent-executor.ts`, the module that owns the `getPackageDir()` lookup) with `captureRuntime` at its default and `PI_PACKAGE_DIR` unset, and invokes `subagent` with a valid executable agent whose `model` is the credential-free scripted provider pattern of `test/integration/fixtures/fanout-lead-grandchild/provider.ts` (a new fixture `test/integration/fixtures/sdk-host/provider.ts` that answers one fixed text and logs `realpath(process.argv[1])` of the child process to `$SDK_HOST_LOG`). Assert: the dispatch returns a non-error result containing the fixed text; the logged child entry's owning package root (walk up to the nearest `package.json`) equals `realpath(A)`, where A is computed in the test from the same module resolution the executor's import graph uses (`realpath(resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), ".."))`, the pattern of `test/integration/fanout-child-own-subagent-history.test.ts:39`; the package exports only an `import` condition, so `createRequire(...).resolve` cannot see it, and the host script sits in a temp package with no `node_modules` of its own), not from any env or hardcoded path; `B.callCount()` is 0.
9. **Renamed entry after capture in SDK host (AC4).** Same host script and B on `PATH`; install A for this test is a second `createMockPi()` package that the host process reaches through `PI_PACKAGE_DIR` (pi's own override, honored by the real `getPackageDir()`), so no file under the repo's `node_modules` is renamed. The request carries the path of A's declared CLI entry; after executor construction and before dispatch the host renames that file: dispatch returns an error result whose message carries the existing `getPiSpawnCommand` launch error, and `B.callCount()` is 0.
10. **AC3.** The existing #19 tests in `pi-spawn.test.ts`, `mock-pi-runtime.test.ts`, `runtime-inheritance.test.ts`, `runtime-retention.test.ts`, and `external-single-attempt.test.ts` run unchanged - no edit to any of those files, nor to `test/support/runtime-parent.mjs` or `test/support/mock-pi.ts`. `test/unit/index-child-registration.test.ts:18` (`retains registration and read-only management when parent capture fails`) is the one #19 test edited: it sets `process.env.PI_PACKAGE_DIR` to a missing directory around `registerSubagentExtension(fakePi)` (restored afterwards) and asserts the `doctor` report and the dispatch error name that directory instead of `/missing/pi-entry.mjs`, because with the repo's Pi loaded the fallback would otherwise succeed.

Run with `env -u PI_CODING_AGENT_DIR npm run test:unit` and `npm run test:integration`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - the Installation-section paragraph at line 42 (communication contract): the sentence "Custom hosts whose entry cannot be identified as the installed Pi package's declared CLI are unsupported." becomes a statement that a host whose entry is not Pi's CLI (an SDK-hosted session) uses the Pi installation the extension was loaded from, identified through Pi's own package-directory export and validated against that package's declared CLI, and that single-file Pi binaries and non-Node host executables remain unsupported; `CHANGELOG.md` - `## [Unreleased]` entry under Fixed citing #22, written in this change (version promotion happens at release)
- Derived / memory docs invalidated: none - `doc/specs/2026-10-11-gh-19-inherit-parent-node-pi.md` is a shipped spec, not a current-state guide, and `AGENTS.md` does not describe this path

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- Bun / SEA / single-file Pi binary support (stays an explicit capture error).
- Hosts whose `process.execPath` is not a Node binary (Electron, Bun embedding the SDK).
- Any `PATH`-based or version-based discovery of a Pi installation.
- Re-resolving persisted detached runs against a new parent installation (#19 contract keeps the recorded runtime).
- Watcher lifecycle and result delivery in SDK hosts (#20, shipped in 7.2.1).
- A new settings key for the installation path.

## Open questions

- Pi Web's loader mode is assumed to be the unbundled-Node alias branch because SDK hosts import `dist/index.js`; the fallback does not depend on the alias (it uses `getPackageDir()`), so a different loader mode changes nothing in the design, but the assumption is unverified against Pi Web itself.
