# Inherit parent Node and Pi across resumable runs

**Goal:** Launch children with the originating parent's Node executable and Pi installation, and retain the identity and resume records outside routine temporary-file cleanup.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** #19 - https://github.com/jjuraszek/pi-cohort/issues/19

## Problem

`getPiSpawnCommand` selects bare `pi` on Linux/macOS and on Windows resolution failure (`src/runs/shared/pi-spawn.ts:102-115`). PATH can therefore replace both the parent's Pi installation and its Node executable. Detached native attempts receive partial Pi metadata, detached external attempts do not, and resume starts from the resuming process rather than the original runtime. Matching version strings does not establish matching installations.

Framing: kept. Parent recon traced foreground single/parallel/chain -> `runSync` -> native/external launch; detached config -> runner -> both launch backends; and resume target -> `executeAsyncSingle`. The shared launch boundary is the right owner, but its inputs must survive the detached and resume boundaries. No predecessor spec is superseded; `doc/specs/2026-07-19-forward-parent-cli-flags.md` governs argument forwarding, not executable identity.

The user also requires ordinary cleanup and parent restarts not to lose new runs' runtime metadata. Existing async state is under `os.tmpdir()` (`src/shared/types.ts:903-905`); completion results are disposable notifications deleted after consumption (`src/runs/background/result-watcher.ts:121-123,177`). Neither a temporary-only record nor a separate runtime file without the remaining resume state meets that requirement. Default artifact cleanup is seven days; chain scratch cleanup is 24 hours. Neither policy applies to the durable state defined below.

## Acceptance criteria

Ticket #19, Acceptance Criteria, rows verbatim:

- [ ] Given a parent launched with Node executable A and Pi installation A while `PATH` selects different Node and Pi installations B, foreground single, parallel, and sequential-chain dispatches start children using A by default, without a new opt-in setting. Cover Linux, macOS, and Windows launch paths; compare the resolved Node executable path and the resolved Pi installation directory containing the launched Pi entry against the parent's, not just version strings.
  in-scope
- [ ] Given the same conflicting setup, detached async dispatch and a subsequent resume start child Pi processes with the original parent's resolved Node executable path and Pi installation directory, and return normal child results.
  in-scope
- [ ] Given the parent-resolved Pi entry file is renamed before dispatch while an alternative `pi` remains on `PATH`, dispatch returns an explicit launch error and the alternative is never started.
  in-scope

## Design

### Runtime identity and capture

`src/runs/shared/pi-spawn.ts` owns the internal `PiRuntimeIdentity` type: readonly string fields `nodeExecPath`, `piEntryPath`, and `piPackageRoot`. Capture all three as non-empty absolute strings using `fs.realpathSync.native` with its string result. Resolution failure fails capture. Preserve these strings unchanged in transport/storage and compare the three fields with exact string equality; do not case-fold, re-canonicalize saved records, or silently repair them on read. This is installation-path identity, not a version, content hash, copied installation, or master-session registry.

At executor creation, capture the running parent's Node executable from `process.execPath` and resolve its actual Pi entry through `process.argv[1]` and symlinks. Verify the entry's owning package is `@earendil-works/pi-coding-agent`. Read that package's `bin` metadata (string or named `pi` entry), require it to identify the same canonical CLI entry, and retain the containing package root. Do not accept an arbitrary JavaScript argv1, select the first unrelated bin, use PATH, or substitute an independently resolved installation. A fixed `dist` layout is not a contract: installed Pi 1.1.0 uses `dist/bundle/cli.js`, while existing fixtures use `dist/cli/index.js`.

Both ordinary and child-safe extension registration already construct `createSubagentExecutor` (`src/extension/index.ts`, `src/extension/fanout-child.ts`). Use that common capture boundary without adding a Pi lifecycle hook, watcher, or process. Retain a capture failure for new dispatch to report; do not prevent management actions from registering. A resume with a valid saved identity does not depend on recapturing the current parent's identity.

The executor's new dispatches and all their attempts use this one captured value. An extension reload creates a new executor and captures anew. Unsupported hosts with no identifiable Node-backed Pi CLI, including unidentifiable custom/SDK launchers, fail explicitly rather than guess. Supporting Bun/standalone executable hosts or adding a runtime override API is not part of this change.

### Launch and propagation

All production launches receive an explicit `runtime` value through existing execution contexts. `getPiSpawnCommand` selects `runtime.nodeExecPath` as the executable and `[runtime.piEntryPath, ...args]` as its argument array on every supported OS. Never invoke a shell to interpolate these paths. Keep existing child CLI arguments, flag inheritance, model selection, environment policy, and external-backend protocol unchanged.

Carry the same value through these existing paths:

| Boundary | Responsibility |
|---|---|
| Executor -> foreground single/parallel/chain -> `runSync` | Pass the captured value into every native or external attempt. |
| `execution.ts` / `external-single-attempt.ts` | Build identical explicit launch commands; external owners still receive their existing command/args request. |
| `async-execution.ts` -> one-shot runner config | Serialize `runtime`; launch the detached runner using its `nodeExecPath`, not the current resuming process's executable. |
| `subagent-runner.ts` -> native / `external-attempt.ts` | Use config runtime for all children, including later chain steps, parallel/dynamic fanout, retries, and nested delegation. Runner argv1 identifies the runner, not Pi. |
| `jiti-cli.ts` and runner session export | Resolve jiti, Pi-scoped aliases, and session exports from `runtime.piPackageRoot`. Remove current-module and `process.argv[1]` candidates as competing Pi-installation selectors. Missing selected-installation dependencies fail explicitly; never choose B's modules to repair A. |
| Resume -> new async execution | Pass the original saved runtime unchanged into the revived run and its new records. |

Replace the superseded `piArgv1` and separate `piPackageRoot` config/context transport fields with `runtime`; do not maintain two authoritative representations. Helpers used for non-launch package inspection may remain, but must not become launch fallbacks. Name the internal executor seam `ExecutorDeps.captureRuntime?: () => PiRuntimeIdentity`, defaulting to real capture and invoked once at executor creation. Tests supply a manifest/bin-backed fixture through this seam; direct lower-level launch tests pass the resulting runtime explicitly. This is not a tool parameter, environment override, or user setting.

### Durable state and ownership

Define `RUN_STATE_ROOT_DIR` as the absolute `<getAgentDir()>/pi-cohort` directory. The existing `getAgentDir()` semantics remain the sole profile resolver: honor `PI_CODING_AGENT_DIR`, including tilde/relative paths, otherwise use `~/.pi/agent`. Move that small resolver from `src/shared/utils.ts` to a dependency-free `src/shared/agent-dir.ts` and re-export it from utils so `src/shared/types.ts` can derive the persistent root without importing utils back through its existing types dependency. This is a leaf extraction inside existing storage code, not a new configuration service.

Pin the absolute profile at shared storage initialization, using process cwd at extension load after existing tilde expansion. Derive every parent durable root from this pinned value, not a later executor cwd. When `PI_CODING_AGENT_DIR` is configured, child/runner environments carry the pinned absolute value through that existing key. When unset, leave it unset and preserve the inherited home-profile default. A changed child cwd must not create a different persistent root. This does not pin a separate historical profile on resume: resuming parent B uses the same selected profile to discover A's records.

| Data | Location and lifetime |
|---|---|
| Top-level async state, logs, and run-owned files | `<RUN_STATE_ROOT_DIR>/async-subagent-runs/<id>/`; `status.json` is authoritative. No age-based cleanup. |
| Nested async state | `<RUN_STATE_ROOT_DIR>/nested-subagent-runs/<rootRunId>/<id>/`; no age-based cleanup. |
| Nested route/registry state needed to find and authorize resume | `<RUN_STATE_ROOT_DIR>/nested-subagent-events/`, preserving the current relative layout and capability/containment checks. No age-based cleanup. |
| Default child sessions with a parent session | Preserve existing parent-derived persistent session placement. |
| Default child sessions without a parent session | Unique session roots under `<RUN_STATE_ROOT_DIR>/sessions/`, not `mkdtemp(os.tmpdir())`. No age-based cleanup. |
| Completion-result notifications | Existing `RESULTS_DIR` under the temp root, including nested result notifications. Disposable after delivery. |
| One-shot runner configs, chain scratch, artifacts | Existing temporary locations and cleanup policies. Not authoritative runtime storage. |

User-selected `params.sessionDir` and `config.defaultSessionDir` keep their existing precedence and select bases for unique full-UUID per-run subdirectories; the user can intentionally select temporary storage. Document that this limits session retention. Do not silently move user-owned paths. The durability promise concerns run identity, discovery/authorization state, and default session files, not archival of a worktree, cwd, or every artifact referenced in a conversation. Preserve no-parent artifacts in the existing temporary artifact root; moving default session files does not move artifacts alongside them.

Update all producers and consumers of async/nested roots together: creation, status/list discovery, result handling, resume, stale reconciliation, nested route validation and ownership resolution. Do not move capability-bearing paths without updating their containment boundary. Preserve existing restrictive nested directory/file permissions. Durable directories must not use `ensureAccessibleDir`'s recursive-delete-on-permission-error repair; report an error without deleting history.

For nested resume, the owning executor records the actual run-specific trusted `sessionRoot` with the existing authorized nested owner/summary records before launch. Retain `runtime` and `sessionRoot` through internal event sanitization, registry projection, and resume targets. A later parent recovers that origin root rather than deriving trust solely from its own session. Keep capability/descendant checks, canonical containment, regular non-symlink `.jsonl` validation, and run-ID sibling exclusion. Do not trust the entire persistent root or a root supplied by a resume caller or unauthenticated event; do not add private runtime/root fields to public result projections.

No automatic expiry, startup pruning, or completion cleanup removes durable records. Records accumulate until the user explicitly removes them. Do not reconcile terminal history entries as stale processes when listing status; listing still scales with retained history, and no bounded-cost claim is made. Document manual removal of a terminal top-level run's `<RUN_STATE_ROOT_DIR>/async-subagent-runs/<id>` directory and that it removes its resume lookup record, not separately located sessions or shared nested routes. Do not remove live runs or guess at shared-route deletion. No new retention setting, janitor, separate runtime-only file, or command is introduced.

### Publication and resume

New async runs publish a complete initial `status.json`, including `runtime`, run/session identifiers, and existing initial-state fields, with `writeAtomicJson` before starting a runner or returning an async-start acknowledgment. State is queued; status `pid` is absent until the runner publishes its own PID with running state. If initial publication fails, return a storage error and spawn nothing. A definite pre-launch failure preserves runtime and reports the failed-start diagnostic through the existing status `error` field. Once a runner has launched, only that runner writes its startup status; the parent performs no post-spawn status update.

Queued startup is not resumable. Leave an uncertain queued start unchanged and return an explicit unresolved-start diagnostic; do not infer abandonment from age or parent/runner liveness, repair it from a completion notification, or automatically relaunch it. The original runner may still publish running state normally. Keep this as an early return in the existing reconciler, without a startup claim, lock, owner record, or starter PID. Existing reconciliation of running records remains separate. This deliberately forgoes automatic recovery when the parent or runner disappears before running-state publication.

The runner config carries the same runtime; startup, progress, terminal, interruption, and stale-reconciliation status writes preserve it. Completion JSON carries an identical copy for the existing result-only recovery path, but deleting that notification must not modify durable status. Notification handling must not recreate durable state from a runtime-less payload.

Retain runtime in the existing `ForegroundResumeRun` records when remembering foreground results, and in authorized durable nested foreground summary/event records. Foreground targets have no async status to consult. A new foreground or nested foreground target must therefore revive with its recorded origin identity rather than current executor capture. Top-level foreground discovery keeps its existing in-memory lifetime; this change adds no general foreground-session registry. Nested async targets use authoritative async status, not a stale summary copy.

Resume retains existing session-file and ownership validation, then selects one complete origin identity:

- Present async status is authoritative. Missing/partial/malformed status runtime rejects even when a completion result contains valid identity. Completion-result-only recovery is permitted only when status is absent.
- Status, runner-config, completion, and authorized foreground/nested transport identities are non-null non-array objects with required non-empty absolute string fields `nodeExecPath`, `piEntryPath`, and `piPackageRoot`. Validate at the deserialization boundary; no field mixing or path repair. When a corresponding result has a present runtime, malformed fields or unequal stored strings reject.
- An identity-less foreground/nested target or authoritative legacy async record rejects with an explanation that the original runtime was not recorded and a new run is required. New dispatches create their own identity automatically.
- Check availability at the launch boundary. The revived run persists the selected origin identity before starting. For a stamped nested record, authorize the regular non-symlink `.jsonl` file by containment in its owner-stamped canonical `sessionRoot` plus existing capability/descendant checks; this replaces the literal run-ID path-segment heuristic, not sibling exclusion. A new revival ID or an `async-` directory prefix need not appear as a bare segment in the original path. A present origin root must remain canonical and cannot be widened or replaced by a caller. Unstamped records keep the existing current-root/run-ID-segment checks, and missing runtime still rejects. Reuse the validated original `sessionFile` without copying it; carry its validated prior root through optional `AsyncSingleParams.originSessionRoot`, separate from the newly allocated session directory. New fork snapshots are created by the existing SessionManager in the selected run's per-task directories, not left in the parent's shared session directory; original sessions are not moved. An async chain with reused fork files carries its explicitly selected, canonical, run-specific common root through `AsyncChainParams.originSessionRoot`. That root must contain every reused file and the chain's new session directory; never infer a broader common ancestor. With no reused file, an origin-root override is invalid. This reuses the existing single owner-root field, without per-step root registries or copying an original conversation during revival. The existing async launch producer, which knows the generated ID and actual directory, publishes complete `runtime` and `sessionRoot` together before spawn, not in a post-spawn duplicate event; new session directories are created and canonicalized first, while an existing origin directory is validated rather than created. A failed origin stamp aborts startup with the existing failed-start diagnostic and starts no child. Newly generated runs use the full `randomUUID()` value, and creating a new async run directory is exclusive: an existing entry produces a storage error before any prior record is overwritten or child is started. Its session attribution belongs to the resuming parent B so B receives completion, while runtime stays A. Resume itself returns the existing async-start acknowledgment, not synchronous child output; tests await the terminal completion/result.

Legacy temp records remain inspectable through status and available for the explicit legacy-resume error; there is no identity inference, migration, or duplicate live record. Exact-ID lookup checks persistent and legacy roots, with persistent precedence for an equal full run ID. Prefix lookup deduplicates equal full IDs with that precedence, then reports ambiguity for distinct IDs across either root. Explicit directories must pass canonical containment and existing ownership checks within the matching persistent or legacy root. Apply the two-root rule within each nested authority (`rootRunId` plus `capabilityToken`): a persistent copy shadows its legacy counterpart, while different authorities and duplicates within the same storage root remain ambiguous. Explicit scoped route order must not override that rule. Preserve canonical async-dir validation, using an unmoved in-flight route's recorded authorized legacy paths rather than rewriting them. New run/route creation writes only persistent storage. Legacy inspection does not rewrite records or roots; existing delivery/control of unmoved in-flight runs continues on their authorized paths without upgrading them.

### Failure contract

A missing/unreadable Pi entry, unavailable Node executable, invalid owning package, or unsupported parent launch produces an explicit runtime-launch error. Name the failing path/reason. Never rediscover a different entry within the package or start a PATH alternative. Runtime-launch failures are not retryable model failures; no model fallback or acceptance retry repairs them.

Check availability immediately before spawning without changing the captured selection. A disappearance after checking still surfaces the actual spawn/process error through the normal foreground result or background failed status. The existing external owner cleanup path must still release its resources. Unrelated model and acceptance failures keep their current policies.

Routine notification consumption, elapsed time, temporary cleanup, and parent restart cannot remove metadata required by a successfully started new async run. This is not a claim that launch can never fail: explicit removal, filesystem corruption, disk/permission errors, installation deletion, or loss of a user-selected temporary session/cwd remain failures. Installing a new binary in place at the same canonical path is not detected or prevented.

## Tests

Use deterministic Pi fixtures and real OS process creation; never require a model/network call. Update the existing PATH-only mock harness before exercising changed dispatch paths so tests cannot accidentally launch installed real Pi. Synthetic Pi packages must have a real manifest/bin and selected-root loader-dependency layout and return normal parsable child results plus observed executable and Pi-root paths. Update `test/support/mock-pi.ts` to supply `captureRuntime` to imported executor tests instead of relying on PATH spoofing; those seam tests do not replace actual-parent A/B process tests. Isolate profile, temp, and HOME/USERPROFILE state; restore process/environment changes and bound every child wait.

| Scenario | Required observation |
|---|---|
| Conflicting installations A/B, native Linux/macOS/Windows | Launch parent under Node/Pi A while PATH selects different canonical Node/Pi B paths. Foreground single, parallel, and sequential chain return normal child results and actual child-reported canonical Node and Pi root equal A. Verify B is genuinely conflicting, not another symlink to A. |
| Detached and cross-parent resume | Async children use A. Make the original run terminal and exit parent A; parent B in the same profile resumes and gets an async-start acknowledgment. B's completion event/result supplies normal output and observed A runner/child Node and Pi root. Loader aliases also resolve from A, never B. |
| Foreground revival | New top-level foreground and nested foreground targets revive with their retained A identity without async origin records. Identity-less targets reject. In-memory top-level registry lifetime is unchanged. |
| External execution, supported OSes | Foreground and detached external attempts receive the same A command/args and execute normal fixture output. Native Windows coverage does not add external Windows support. |
| Rename after capture | Capture A, rename its Pi entry before dispatch, leave B available, then observe explicit launch failure and zero B sentinel launches. Cover immediate and runner-side launch errors. |
| Capture/availability edges | Symlinked entry, string/object bin fields, space-bearing paths, missing Node, unsupported host, wrong package/entry, and a spawn-time disappearance produce either canonical A or the specified explicit error, never fallback. Round-trip the native canonical strings unchanged, including on Windows; unequal strings are not repaired on read. |
| Saved-state boundaries | Complete status-only and absent-status/result-only identities resume. Runtime-less status plus valid result, null/array/partial/relative/malformed fields, and conflicting metadata reject as specified. Same original identity reaches revived config and status. |
| Publication ordering and ownership | Durable write failure starts no runner/child and returns no success acknowledgment. Queued resume rejects. Reconciliation leaves queued status byte-for-byte unchanged, with no PID probe or result-based repair, and returns an unresolved-start diagnostic. Definite pre-launch failure retains runtime; successful runner startup publishes running state without a parent post-spawn overwrite. |
| Retention and nested authorization | Consume/delete notifications, restart parent, advance beyond 24-hour/seven-day cutoffs and run cleanup functions, clear fixture temporary state, then resume under A. Test cross-parent and no-parent nested session validation from the authorized origin root, and reject forged/outside/sibling roots. Default session files survive while no-parent artifacts keep temporary cleanup. |
| Non-destructive errors and listing | Permission/create failure leaves existing records untouched. Terminal history skips stale-process reconciliation without claiming bounded listing cost. |
| Profile and compatibility | Relative PI_CODING_AGENT_DIR is pinned at storage init before cwd changes and propagated only when configured; unset stays unset. Legacy status remains inspectable and identity-less resume rejects. Cover exact-ID precedence, cross-root prefix ambiguity, permitted/escaped explicit directories, and unmoved legacy nested routes. |

Add `macos-latest` to the existing Ubuntu/Windows CI matrix in `.github/workflows/test.yml`; preserve its Node 24 setup. Native platform results are distinct from branch simulation. Mandatory runtime tests must run rather than silently skip for missing test packages. Run the existing unit and integration suites as regression coverage; in a Pi harness unset `PI_CODING_AGENT_DIR` for their normal defaults (`env -u PI_CODING_AGENT_DIR npm run test:all`), while fixtures explicitly set isolated profiles. Implementation verification, including cross-platform CI, occurs after spec approval; no proposed change was exercised during brainstorming.

## Documentation impact
- Feature / user-facing docs introduced: none.
- Materially amended existing docs: `README.md` (operations/recovery: default inheritance, unsupported hosts, legacy resume, durable retention, terminal-run manual removal and its limits); `doc/observability.md` (operations/storage contract: persistent versus disposable run locations and deletion semantics); `doc/configuration.md` (operations: profile-root resolution, default session placement, explicit temporary-path override caveat); `CHANGELOG.md` (compatibility decision: PATH bypass, durable run state, legacy-resume rejection).
- Derived / memory docs invalidated: none.

Apply the brainstorming guideline `reference/documentation-impact.md`. The scout's `Docs touched: none` found no existing runtime-selection section; parent recon found the observability/configuration ownership above. Observability qualifies because its storage contract changes, not because it should mirror `PiRuntimeIdentity` fields. Amend these owners, not a new standalone guide. No AGENTS.md or sibling public-contract update is required: external-backend request shape, settings keys, and cost channel are unchanged.

## Out of scope

- Installing/selecting Node, copying or content-locking Node/Pi, extra Node flags, arbitrary Pi CLI-flag changes, image resizing, or a diagnosis of an unconfirmed native crash.
- New runtime/retention settings, master-session registry, new execution-backend protocol, external Windows support, cross-machine/profile migration, old in-flight-run upgrades, or retroactive identity recovery.
- Archiving arbitrary working directories, worktrees, chain artifacts, or user-selected temporary sessions. Their removal can still prevent useful continuation even while runtime identity survives.

## Open questions

None requiring a design choice. Unsupported hosts and filesystem/installation loss are explicit limits, not fallback opportunities. The acceptance observations still require implementation and native CI evidence on all three operating systems.
