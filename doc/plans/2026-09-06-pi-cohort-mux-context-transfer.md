# pi-cohort mux execution backends: context transfer

## Purpose

Create `nertzy/pi-cohort-mux`, a companion package that runs `pi-cohort` children in visible terminal-multiplexer surfaces without duplicating Cohort's orchestration logic. The new repository will extract the reusable transport behavior from `nertzy/pi-interactive-subagents`, prove a public execution-backend contract for `jjuraszek/pi-cohort`, and become the proposed upstream home for mux adapters after the design is validated.

This document transfers the current discovery and decisions into the new repository. It is not an assertion that the backend API has already been accepted upstream.

## Current status

- Core implementation is on branch `mux-execution-core` in draft [PR #15](https://github.com/jjuraszek/pi-cohort/pull/15); design remains in [PR #12](https://github.com/jjuraszek/pi-cohort/pull/12).
- At local head `3fa43e3`, the public SPI/registry, deterministic selection, durable session reporting/replay, persistent child host, abort/shutdown control, foreground routing, and Task 21 background routing/reload implementation have passed focused implementation and review gates. One surface spans model fallback attempts; native execution remains built in.
- Full validation at `1c97986`: 870 unit tests passed; 447 integration tests passed, 1 skipped, no failures. Task 21 implementation and focused reviews are complete. External execution is unsupported on Windows; native execution remains supported.
- `nertzy/pi-cohort-mux` is public; its package remains private/unpublished. Draft [PR #1](https://github.com/nertzy/pi-cohort-mux/pull/1) contains research, fixtures, and real-mux spikes, not production adapters. `src/index.js` remains a placeholder; no runnable Pi extension entry point exists yet.
- The donor bridge remains the active local integration. `pi-balanced` is unchanged; do not claim the new mux is installed.
- Post-[gh-11](https://github.com/jjuraszek/pi-cohort/issues/11): no live steer, session rebound, foreground detach, generic completion receipts, or `taken_over`. `BLOCKED:` remains an ordinary terminal failed-child result.

### Remaining execution order

- [x] Finish and review the full-suite result for Task 21.
- [ ] Task 22: export the core-owned package-consumable backend conformance testkit.
- [ ] Task 23: implement production cmux/tmux adapters and Pi extension entry point. Register an explicit `[cmux, tmux]` policy list: higher-level/more opinionated transport first. Core preserves registration order without knowing adapter names; named selection overrides `auto`.
- [ ] Task 14: create an isolated `pi-balanced-mux` launcher/profile using a separate `PI_CODING_AGENT_DIR`, replacing the donor bridge only in that copy. Preserve `pi-balanced` unchanged. This remains gated on runnable adapters/entry point and foreground/background parity.

Task 21 extends SPI v1 with a serializable reload descriptor containing exactly `protocolVersion`, `packageJsonUrl`, `publicSubpath`, and `factoryExport`. The detached coordinator validates that package-anchored descriptor, imports its public named zero-argument factory, and reconstructs adapters in registration order before selecting each child backend. `native` bypasses reconstruction. Explicit selection surfaces that backend's reload failure; `auto` surfaces any registration/reload failure instead of silently changing policy, while normal post-reload unavailability still falls back to native. Only backend names and descriptors cross the process boundary - never live backend objects, credentials, or an environment capsule - and each launch keeps the exact resolved child `cwd`.

Continue from `doc/specs/2026-09-06-mux-execution-backends.md`; earlier proposed phases below describe the overall sequence, not current completion status.

## Repositories and intended ownership

### `jjuraszek/pi-cohort`

Owns orchestration and the public execution-backend SPI:

- request validation and effective agent resolution;
- single, parallel, chain, and dynamic-fanout semantics;
- clarification;
- worktree setup and cleanup;
- acceptance and reviewer gates;
- structured output and output-file behavior;
- model fallback policy;
- foreground and durable async coordination;
- run/session identity, persisted status, ready/settled/result session-log semantics, and result aggregation;
- a narrow, mux-independent control protocol: the child reports readiness, and core requests interrupt (`ctx.abort`) or shutdown (`ctx.shutdown`) - no steer, no session rebound, matching gh-11's removal of live child messaging;
- backend selection and configuration.

Native child-process execution remains built in and backward compatible.

### `nertzy/pi-cohort-mux`

Is Grant's prototype companion package and owns mux transport only:

- mux availability and capability detection;
- creating and identifying panes/surfaces;
- launching children without exposing secrets;
- native mux lifecycle/entity facts and opaque reattach/display metadata;
- closing successful panes and retaining diagnostic panes;
- cmux and tmux adapters in the first releasable scope;
- a documented Herdr adapter design, with implementation deferred until its API is verified.

After the contract and conformance suite are proven, propose moving the repository/package alongside upstream `pi-cohort`. Do not put it in HazAT's GitHub fork network.

### `nertzy/pi-interactive-subagents`

Treat this as donor and migration code, not the permanent package:

- preserve attribution and applicable license notices when extracting code;
- preserve useful commit provenance where practical;
- keep the bridge working until the companion reaches migration parity;
- archive the fork only after cutover and after separating any standalone behavior that still has users.

## Decisions already made

1. **Packaging:** `pi-cohort` exposes a small public SPI; `pi-cohort-mux` is a separately installed companion package.
2. **Prototype ownership (ratified):** `nertzy/pi-cohort-mux` already exists as a public repository and draft PR #1 carries the prototype. Do not rename the existing GitHub fork.
3. **Upstream path:** prototype under `nertzy`, then propose transfer after the integration and conformance tests prove the boundary.
4. **Installation:** users install both packages. The companion should register automatically; ordinary configuration must not contain JavaScript module paths or adapter imports.
5. **Default selection:** when the companion is installed and a supported active mux is detected, use it automatically. Fall back to native execution when no mux is available.
6. **Override:** provide one simple user/project configuration value that forces `native` or a named backend. An explicitly selected unavailable backend fails loudly.
7. **Initial adapters:** implement cmux and tmux. Document how Herdr maps to the SPI, but defer its implementation until its public lifecycle/socket contract is verified. Zellij and WezTerm are later candidates despite existing donor support.
8. **Mode parity:** support pane-backed foreground and async children through the same backend contract. Keep Cohort's detached async runner as the durable coordinator.
9. **Pane retention:** close a pane only after successful result delivery. Retain failed and interrupted panes for inspection and explicit cleanup. Interruption preserves core's existing terminal `paused` result and existing resume/revive behavior; it does not imply a still-running child or Pi session rebound. This is a diagnostic surface promise only - it does not change worktree lifetime, which stays whatever `cleanupWorktrees()` already does (unconditional, in a `finally` block). Outcome-conditional worktree retention/reaping, a distinct `taken_over`/human-takeover state, and attention-needed panes are deferred; gh-11 already makes `resume` on a running child an error, so there is no live child to take over in v1.
10. **SPI scope (ratified):** adapters provide only surface launch, mux lifecycle, reattach metadata, and close/retain cleanup. Core owns session-log parsing/results and the narrow mux-independent control protocol: child readiness plus core-requested interrupt and shutdown, with no steer or session rebound. Screen scraping, focus, and arbitrary interactive input are not v1 contracts.
11. **Repository timing (ratified):** the public GitHub repository already exists and draft PR #1 carries its prototype. The npm package remains private/unpublished; stable adapter release and normal installation await the landed core SPI and conformance evidence.
12. **Foreground/async workflow issue:** the current local bridge sometimes reroutes an explicitly foreground Cohort dispatch into a detached cmux pane. Do not let that block this project now, but record preservation of caller-requested execution semantics as a conformance requirement.

## Target architecture

Cohort compiles each logical child into a backend-neutral launch request containing the already-resolved command, arguments, required `cwd`, run/session identity, artifact locations, and cancellation signals. It preserves Pi arguments unchanged. gh-11 removed intercom environment plumbing outright, and this design does not reintroduce it. Worktree metadata is optional awareness; existing `worktreeSetupHook` remains the setup owner and v1 adds no setup/creation API.

A registered adapter launches a surface and reports mux lifecycle, reattach metadata, and close/retain cleanup only. It does not return Cohort lifecycle/results: Core injects the child reporting extension through `runtimeExtensions`, parses/replays the ordered session JSONL, applies fallback/acceptance/aggregation/persistence, and constructs durable results. This injection applies even with `--no-extensions`.

Pi 0.85.0 cannot combine TUI and `--mode json`. Interactive launches pre-create an empty `--session` JSONL file; native stdout JSONL mode remains unchanged. Pi entries plus core-owned `ready`, `settled`, `result`, and `control` entries are the durable interactive result stream. `agent_settled` leaves the child alive; core shuts it down only after durable delivery. Entry-granularity progress is accepted in v1.

The core-owned control protocol is mux-independent and narrow: the child reports readiness, and core requests interrupt (`ctx.abort`) or shutdown (`ctx.shutdown`). There is no steer and no session rebound in v1 - gh-11 removed live parent<->child messaging from pi-cohort, and `resume` on a running child errors regardless of backend. A `BLOCKED:` child returns an ordinary terminal failed result through the same session-log/result path as any other failure; it is not a retained live child awaiting a decision. cmux hooks are optional corroborating awareness, tmux needs no hook, and neither polling nor screen scraping is a result source. Native mux facts, child/session facts, and unknown/no-activity stay provenance-distinct.

## Important pi-cohort seams

Start core work at these boundaries:

- `src/runs/shared/pi-spawn.ts` — portable Pi command resolution;
- `src/runs/shared/pi-args.ts` — Pi arguments, session flags, and nested routing (intercom environment plumbing was removed by gh-11 and must not be reintroduced);
- `src/runs/foreground/execution.ts` — foreground `spawn()` and JSONL lifecycle;
- `src/runs/background/subagent-runner.ts` — duplicate async child streaming boundary;
- `src/runs/background/async-execution.ts` — durable runner launch; keep this independent from mux panes;
- `src/runs/foreground/subagent-executor.ts` — orchestration entry point; thread selection through it without adding mux logic;
- `src/shared/types.ts` — `RunSyncOptions`, results, status, and `ExtensionConfig`;
- `src/extension/config.ts` and `src/extension/index.ts` — configuration and runtime initialization.

The narrowest useful refactor is to place a backend-neutral child executor below orchestration and above raw process creation, then use it from both foreground execution and the detached runner's child path.

## Donor code map

Use the fork as behavioral evidence rather than copying its architecture wholesale:

- `pi-extension/cohort-bridge.ts`
  - current Cohort tool-call interception;
  - routing and native fallback;
  - launch/session/artifact lifecycle;
  - model fallback and result steering;
  - duplicated orchestration that must not move into the companion.
- `pi-extension/subagents/cmux.ts`
  - cmux, tmux, Zellij, and WezTerm detection;
  - surface creation and reuse;
  - command delivery and escaping;
  - lifecycle polling and cleanup;
  - currently monolithic and switch-based; split by adapter rather than retaining the closed union.
- `pi-extension/subagents/model-failure.ts`
  - failure classification useful as evidence, but model fallback belongs to Cohort.
- `pi-extension/subagents/subagent-done.ts`
  - structured terminal sidecars and autonomous-child completion.
- `pi-extension/subagents/output.ts` and `persona-resolve.ts`
  - compatibility copies that demonstrate missing public boundaries; do not move them into the mux package.
- bridge-specific tests
  - preserve lifecycle, cleanup-order, launch-safety, routing, and failure cases as candidate conformance tests.

The existing `cohort-bridge.ts` is roughly 2,500 Grant-authored lines, and the fork has roughly 6,000 added lines across its complete delta. This is substantial original adapter and compatibility work, but it currently depends on private Cohort modules and duplicates Cohort semantics.

## Registration and installation constraint

Pi packages can contain multiple extensions and extensions share the Pi process, but Pi's documented extension API does not provide a first-class cross-package service registry. Automatic adapter registration therefore needs an explicit, versioned design rather than an assumed import trick.

The first architecture spike should compare:

1. a small process-global registry keyed by a versioned `Symbol.for(...)` contract, tolerant of either extension load order;
2. Cohort discovering an installed companion through a stable package/runtime location;
3. a thin companion extension that calls a deliberately exported Cohort registration API.

Reject any option that depends on private `src/...` imports, hard-coded installation paths, or a required module path in ordinary user configuration. Prove reload behavior, duplicate registration, incompatible SPI versions, and both extension load orders before selecting the mechanism.

## Security requirements

- Never render resolved secrets into pane command text, generated scripts, persisted environment files, logs, or terminal metadata.
- Do not hard-code local Pi preset names or infer retention mode from a directory basename.
- Preserve the exact already-resolved launcher/runtime semantics without asking an adapter to reconstruct user policy.
- Use a one-shot, mode-`0600` named pipe or an equivalently ephemeral mechanism when secret-bearing launch state must cross into a pane process.
- Remove the handoff on success and every failure path.
- Treat structured process/session state—not rendered terminal screen contents—as the lifecycle source of truth.
- Fail loudly when a requested secure launch contract cannot be honored.

## Lifecycle requirements

A conforming adapter supplies surface facts to an integrated core+adapter system, which must demonstrate:

- child session and artifact identity is stable and returned to Cohort;
- startup failures are distinguishable from child failures;
- lifecycle facts cannot be confused with terminal decoration or prompts;
- core control (`ctx.abort`) produces an explicit interrupted state;
- cleanup happens after successful delivery, not merely after child exit;
- failed launch, native lifecycle observation, finalization, and fallback paths clean temporary state predictably;
- retained diagnostic panes are reported to the user with an actionable handle, without implying any change to worktree lifetime;
- parallel launches have deterministic result ordering and bounded resource usage;
- nested Cohort runs preserve depth state (intercom routing no longer exists after gh-11 and must not be reintroduced);
- a parent exit does not destroy durable async coordination;
- unavailable auto-selected adapters fall back to native, while an unavailable explicit selection fails.

## Post-core adapter-release scope

### Included

- public, versioned Cohort backend SPI;
- native backend expressed through the same contract;
- backend registry and auto-selection;
- simple user/project override;
- cmux adapter;
- tmux adapter;
- foreground and durable-async parity;
- backend contract/conformance test kit;
- secret-safe launch handoff;
- migration documentation from `cohort-bridge.ts`;
- Herdr mapping/design note based on verified public APIs.

### Deferred

- Herdr adapter implementation;
- Zellij and WezTerm adapters;
- screen-read/scraping APIs;
- arbitrary input injection;
- focus manipulation, screen capture, and arbitrary terminal input;
- steer and session rebound as control-channel operations (removed with pi-intercom by gh-11; not reintroduced here);
- a distinct `taken_over`/human-takeover result state, and any live decision escalation or resumable blocked child - gh-11 already makes `resume` on a running child an error;
- durable completion/result receipts beyond the existing session-log/result path;
- outcome-conditional worktree retention or reaping owned by this SPI (worktree lifetime stays exactly whatever `cleanupWorktrees()` already does today);
- mux-owned chain, fanout, acceptance, output, persona, or worktree behavior;
- replacing Cohort's detached async coordinator;
- archiving the donor fork before migration parity.

## Proposed implementation sequence

### Phase 1: prototype status and donor preparation

- `nertzy/pi-cohort-mux` already exists publicly; keep its npm package private/unpublished and draft PR #1 as the prototype.
- Record donor provenance and attribution before moving code.
- Add a compatibility matrix covering Pi, `pi-cohort`, Node, cmux, and tmux versions.
- Add test fixtures for a minimal fake backend and fake mux CLI.
- Keep the repository unreleased while the SPI is provisional.

### Phase 2: core-only, mux-free SPI and reporting slice

- Extract one backend-neutral child-execution contract in `pi-cohort`.
- Wrap current native foreground execution without changing behavior.
- Reuse the contract inside `subagent-runner.ts` while leaving the detached runner intact. Carry validated serializable backend reload descriptors into that fresh process so adapter registration is reconstructed before selection; never serialize live backend objects or secrets.
- Add registry, selection, config, version-negotiation, and failure behavior.
- Publish a conformance harness that an external adapter can consume.
- Open an upstream PR focused on the seam and native behavior, not mux implementation.

### Phase 3: prove registration and cmux

- Implement automatic companion registration only after the core SPI is landed and its load-order-safe mechanism is proven.
- Extract and refactor cmux transport behavior from the donor.
- Preserve secure launcher handoff, native lifecycle/entity facts, opaque reattach metadata, and close/retain cleanup; integrate them with core reporting and control.
- Run the same logical conformance scenarios against native and cmux backends; retain only final fallback failure.

### Phase 4: add tmux and mode parity

- Implement tmux behind the same interface without adding backend-specific branches to Cohort.
- Exercise foreground, async, parallel, nested, worktree awareness, cancellation, output, acceptance, and model-fallback flows; preserve one surface per logical child.
- Verify auto-selection and explicit overrides in nested-mux environments.

### Phase 5: migration and upstream proposal

- First create and smoke-test an isolated `pi-balanced-mux` profile/launcher with both packages and no donor bridge. Leave `pi-balanced` unchanged. Replace the normal local bridge installation only after parity is proven and migration is separately approved.
- Compare behavior against the bridge before removing it.
- Document retained-pane recovery and explicit cleanup.
- Draft the transfer/upstream proposal with compatibility and conformance evidence.
- Only then deprecate the bridge and plan archival of the donor fork.

## Validation strategy

### Core contract

- Native regression tests for current foreground and async behavior.
- Public backend contract/conformance tests only for surface launch, mux lifecycle, reattach metadata, close/retain cleanup, unavailable backends, and incompatible versions.
- Core tests for session-log reporting/result construction, child-to-core readiness, and core-to-child interrupt/shutdown.
- Tests proving `auto`, `native`, and named-backend selection.
- Tests for both extension load orders, duplicate registration, and reload.
- Windows and no-mux CI retain native behavior.

### Adapter package

- Unit tests use fake executables and sockets; they assert exact argument boundaries without printing secret-bearing environment values.
- Lifecycle tests assert cleanup ordering for create, launch, native event/reconcile, reattach, close/retain cleanup, and fallback failures.
- Optional real-mux smoke tests exercise create, launch, native lifecycle events, reconcile, reattach, and close/retain cleanup.
- Integrated end-to-end tests exercise core control and delivery ordering separately.
- Skipped real-mux tests must report discovered example counts and the reason for skipping; zero exercised cases cannot be reported as a pass.
- Foreground and async suites run the same behavioral matrix where their persistence expectations differ only at the Cohort coordinator layer.

### Migration parity

At minimum, verify:

- single and parallel children;
- sequential chains and dynamic fanout through Cohort orchestration;
- worktree-isolated tasks;
- structured and file output;
- acceptance/reviewer gates;
- model fallback;
- nested run depth;
- status, core control, and retained-pane metadata: interrupt produces the existing terminal `paused` result; completed, failed, and paused children keep existing resume/revive behavior, while `resume` on a running child errors post-gh-11;
- successful close-after-delivery and failure retention;
- native fallback outside supported muxes.

## Herdr research brief

Do not implement from marketing claims. Verify the released Herdr CLI/socket API and version-specific behavior for:

- runtime and active-session detection;
- pane/session creation;
- launching a command without exposing its environment;
- structured working/blocked/idle events;
- wait semantics and process exit/result retrieval;
- interrupt, reconnect, and cleanup;
- whether lifecycle state remains valid across client disconnects and server restart;
- stable handles suitable for Cohort status and recovery;
- how nested agent launches are represented.

Map verified operations onto the same required SPI. Record richer Herdr-only capabilities as adapter metadata or future optional capabilities rather than expanding version one prematurely.

## Known risks

1. **No native cross-extension registry:** automatic installation may require a carefully versioned process-global protocol.
2. **Interactive versus machine-readable execution (resolved):** Pi 0.85.0 makes TUI and `--mode json` mutually exclusive. Pre-created session JSONL plus core-owned entries is the durable interactive source; stdout JSONL remains native-only.
3. **Secret propagation:** naive pane commands expose inherited credentials in logs and persisted metadata.
4. **Foreground/async drift:** visible panes must not silently change completion, cancellation, or durability semantics.
5. **Fork drift:** the bridge's copied persona/output/runtime logic can diverge from current Cohort while migration is in progress.
6. **Nested muxes:** multiple environment markers can be active; selection needs deterministic precedence and a simple explicit override.
7. **Release compatibility:** the adapter must declare and test compatible ranges for the Cohort SPI, Pi runtime, Node, and supported mux CLIs.
8. **Pane leakage:** retention is intentional on abnormal outcomes, so status must expose actionable handles and cleanup instructions.

## Open design questions for the new repository

Resolve these through code/API inspection before implementation:

- What exact registration mechanism works across separately installed Pi packages and both extension load orders?
- What is the smallest compiled launch request that supports native and pane execution without leaking secrets?
- **Resolved:** interactive TUI uses a pre-created `--session` JSONL file; `--mode json` remains the unchanged native stdout path. The core reporting extension writes ordered custom entries.
- How are retained panes enumerated and cleaned through the existing Cohort status/control surface without adding mux-specific management actions?
- What deterministic priority applies when cmux and tmux are both active?
- Which lifecycle metadata must persist in Cohort's async status files to reconnect after a parent restart?
- Which portions of donor history can be preserved cleanly without carrying the original package's obsolete architecture?

## First actions in the new repository

1. Preserve the existing public repository and draft PR #1; keep the npm package unpublished.
2. Copy this document into `doc/plans/` and keep it as the project handoff.
3. Add donor repository and upstream Cohort references to contributor documentation.
4. Inventory donor files and commits into three buckets: transport to extract, tests to port, compatibility code to discard.
5. Spike automatic registration with a fake backend before moving cmux code.
6. Write the backend conformance scenarios as package-agnostic tests.
7. Draft the minimal `pi-cohort` SPI change from those tests.
8. Open the upstream design discussion before presenting a code-heavy core PR.

## Do not carry forward

- tool-call interception as the permanent integration;
- dynamic imports from installed `pi-cohort/src/...` files;
- copied persona resolution or output behavior;
- mux implementations of chains, fanout, worktrees, acceptance, or fallback;
- a closed `cmux | tmux | zellij | wezterm` type in core;
- hard-coded local launcher/preset names;
- terminal screen scraping as completion evidence;
- mandatory mux dependencies in `pi-cohort`;
- silent fallback after an explicitly requested backend fails.

## Ratified lifecycle addendum

This addendum takes precedence over discovery-era broad lifecycle wording above.
It records the accepted v1 boundary without discarding the donor map, source seams,
registration comparison, security constraints, validation matrix, risks, or
migration history in this transfer document.

### Ownership and result source

| Concern | Owner |
|---|---|
| reporting extension via `runtimeExtensions` | pi-cohort core |
| session-log parse/replay, result construction, durable delivery | pi-cohort core |
| ready/abort/shutdown control channel (no steer, no rebound) | pi-cohort core |
| surface launch and mux lifecycle | pi-cohort-mux |
| reattach metadata and close/retain cleanup | pi-cohort-mux |

The companion never interprets Pi session entries or manufactures Cohort results.
It does not own control semantics. Core injects the reporting extension before
launch, including with `--no-extensions`, and knows the session path first.

### Retention protocol

One logical child has one surface. Attempts from model fallback execute sequentially
in that surface, and only the final failure is retained. After successful durable
result delivery, close the surface. On failure - including a `BLOCKED:` terminal
result - retain the surface for inspection until explicit cleanup, exposing an
actionable reattach handle. Interruption preserves core's existing terminal
`paused` result and also retains the diagnostic surface; completed, failed, and
paused children retain existing resume/revive behavior, while a running child
cannot be resumed. This is a diagnostic surface promise only: worktree lifetime
is unaffected and stays whatever `cleanupWorktrees()` already does today
(unconditional, in a `finally` block, regardless of outcome). A distinct
`taken_over`/human-takeover outcome and outcome-conditional worktree
retention/reaping are deferred, not part of this slice; no live child remains to
take over in v1.

### Superseded discovery conclusions

Earlier statements describing an adapter-provided lifecycle/result stream,
adapter interruption, a broad launch/lifecycle/result/interrupt/cleanup SPI, a
bidirectional control socket with steer/session rebound, a distinct `taken_over`
result state, or outcome-conditional worktree retention/reaping owned by this SPI
are superseded by the narrow four-part SPI and limited core control protocol
above. The steer/rebound/`taken_over`/worktree-retention wording was written before
[gh-11](https://github.com/jjuraszek/pi-cohort/issues/11) removed pi-intercom and
live parent<->child messaging from pi-cohort outright; none of it is reintroduced
here. They are kept only as history of the discovery alternatives. The earlier
no-repository status and "create only after SPI release" delivery wording are
superseded: the repository is public today, draft PR #1 holds the prototype, while
npm publication remains private/unpublished pending the core slice and conformance
evidence.

### First-slice acceptance additions

- Verify session files are created empty before interactive Pi launch and contain
  Pi header plus core custom entries in order.
- Verify `agent_settled` alone does not terminate the child; shutdown follows
  durable result delivery.
- Verify ready, abort, and shutdown operate without a mux (no steer, no rebound).
- Verify adapters do not parse logs, classify results, or duplicate control.
- Verify a failed child (including `BLOCKED:`) retains its surface with an
  actionable reattach handle; success closes only after delivery. Verify worktree
  cleanup runs exactly as it does today (unconditionally) regardless of surface
  retention - this slice makes no new retention/reaping promise over worktrees.
- Verify one surface across sequential fallback attempts and retain only final
  failure.
- Verify polling or screen scraping rendered terminal content never serves as
  result evidence. Prefer authoritative native mux push events; bounded native
  lifecycle reconciliation may poll when a backend cannot push the needed fact.
