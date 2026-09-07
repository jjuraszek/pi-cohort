# Mux execution backends: discovery record and ratified architecture

## Codebase recon

### Request and repository state

Upstream a pluggable pane/multiplexer execution backend into `jjuraszek/pi-cohort`, using Grant's `nertzy/pi-interactive-subagents` fork as donor code. The design should support or propose cmux, tmux, and Herdr adapters and remain extensible to other muxes. The worktree is rebased on current `origin/main` at pi-cohort 6.0.1, after [gh-11](https://github.com/jjuraszek/pi-cohort/issues/11) removed pi-intercom support (`doc/specs/2026-09-06-gh-11-remove-pi-intercom.md`). That removal deletes live parent<->child messaging, foreground detach, and result receipts outright; this design must not reintroduce any of them under a mux-specific name.

### Existing pi-cohort execution boundaries

1. `src/runs/shared/pi-spawn.ts:1-115` is the existing child-process command abstraction. `getPiSpawnCommand()` resolves `pi`, or Node plus Pi's JavaScript entry point on Windows. It is portable process-launch logic, not yet a pane backend.
2. `src/runs/foreground/execution.ts` owns foreground child lifecycle: it builds Pi arguments and environment, calls Node `spawn()`, consumes JSONL events, handles cancellation, `BLOCKED:` classification, and model fallback, and returns `SingleResult`.
3. `src/runs/background/subagent-runner.ts:83-131,217-253` owns the corresponding async child boundary through `runPiStreaming()`. The detached runner itself is launched separately by `src/runs/background/async-execution.ts:174-267,287-333,686-720` and persists status/events/results independently of the parent.
4. `src/runs/foreground/subagent-executor.ts:99-177,2287-2631` owns public subagent parameter validation and dispatch across single, parallel, chain, and async modes. Backend selection may be threaded through here, but transport-specific orchestration should not live here.
5. `src/shared/types.ts:841-856` defines `ExtensionConfig`, which currently has no execution-backend key. `src/extension/config.ts:1-16` loads optional JSON config and fails open to `{}`. `src/extension/index.ts:247-323` initializes state and constructs the executor.
6. `src/runs/shared/pi-args.ts` and existing run types already carry session paths, run identity, nested-depth state, and parent Pi flags. gh-11 removed intercom routing and its environment plumbing outright; a backend must preserve the remaining contracts unchanged and must not reintroduce intercom routing.

Current foreground launch shape (`src/runs/foreground/execution.ts:233-240`):

```typescript
const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(...) };
const spawnSpec = getPiSpawnCommand(args);
const proc = spawn(spawnSpec.command, spawnSpec.args, { cwd, env: spawnEnv, ... });
```

The async runner repeats the child-spawn responsibility in `src/runs/background/subagent-runner.ts:229-253`. A shared backend boundary must cover both child execution paths without replacing the durable detached coordinator.

### Donor implementation

The donor mux implementation is `nertzy/pi-interactive-subagents`'s `pi-extension/subagents/cmux.ts`:

- `cmux.ts:9-123` defines the closed `MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm"` union, `PI_SUBAGENT_MUX` preference, runtime environment markers, executable detection, and automatic selection.
- `cmux.ts:744-849` creates backend-specific surfaces and preserves parent targeting/focus behavior.
- `cmux.ts:1008-1102` delivers commands, escapes, and generated script files for long commands.
- `cmux.ts:1104-1188` reads pane screens.
- `cmux.ts:1190-1216` closes surfaces.
- `cmux.ts:1218+` polls sidecars/session state for completion.

The donor's `/pi-extension/cohort-bridge.ts` is a compatibility layer, not the desired architecture:

- `cohort-bridge.ts:678-710` routes supported Cohort calls to panes and falls back to native execution when no mux is available or fields are unsupported.
- `cohort-bridge.ts:839-926` duplicates validation and effective-persona resolution before launch.
- `cohort-bridge.ts:1154-1187` dynamically loads private pi-cohort source modules from the installed package.
- `cohort-bridge.ts:1930-2140,2270-2361` owns launcher selection, pane lifecycle, artifact paths, result steering, and cleanup.
- The bridge also recreates chain, parallel, dynamic-fanout, acceptance, structured-output, worktree, and model-fallback semantics. Those semantics belong in pi-cohort above any backend contract.

The donor implementation already supports cmux, tmux, Zellij, and WezTerm, but uses one monolithic switch-based module rather than a pluggable registry. It is behavioral donor code, not an extensibility design to copy wholesale.

### Existing design constraints from donor specs

- `doc/specs/2026-08-04-cmux-subagent-auth-env.md:1-44` requires secret-safe pane launch. Resolved credentials must not enter generated scripts, command text, persisted environment files, or terminal metadata. The current design uses launcher indirection and, in newer fork work, one-shot protected handoff mechanisms.
- `doc/specs/2026-08-04-cmux-subagent-permanent-failure-exit.md:1-108` requires structured exit sidecars for permanent model/auth failures and rejects rendered-terminal scraping as the source of truth.
- Pane attempts require cleanup on send, poll, launch, and finalization failures and before native fallback. Donor lifecycle tests assert cleanup ordering.
- Existing specs have no supersession marker relevant to this design.

### Packaging and compatibility

- `package.json:1-88` defines a Node >=20 ESM package with no runtime mux dependency. Adapters should use Node built-ins plus runtime CLI detection, or an optional companion package, rather than make cmux/tmux/Herdr mandatory dependencies.
- pi-cohort uses the current `@earendil-works/*` Pi API line; donor code still contains `@mariozechner/*` imports and cannot be copied wholesale.
- Native execution must remain backward compatible for Windows, CI, no-mux environments, and existing users/configuration.
- Foreground and async are user-visible Cohort semantics. A visible pane must not silently redefine a requested foreground call as detached; backend lifecycle must return through the same completion contract.
- The async coordinator must remain durable independently of a mux pane. A pane backend should execute children inside the runner rather than replace `spawnRunner()` unless a separate reconnect design proves equivalent durability.
- Backend capabilities will differ. Herdr may expose richer Pi-native lifecycle/session APIs than generic tmux; capability negotiation is preferable to pretending every adapter implements identical takeover, screen-read, focus, interrupt, and reconnect behavior.

### Test conventions and likely verification

Existing relevant coverage:

- `test/unit/pi-spawn.test.ts` and `test/unit/windows-hide-spawn.test.ts` for portable spawn behavior.
- `test/integration/single-execution.test.ts` for foreground event/result semantics.
- `test/integration/async-execution.test.ts` for detached durability and persisted lifecycle.
- `test/integration/parallel-execution.test.ts` for concurrency.

Donor patterns:

- Pure routing tests mock mux availability.
- Pane-launch tests use `node:test` mocks and lifecycle test hooks to assert generated commands and cleanup.
- Integration harnesses detect available backends and skip cleanly when unavailable, then exercise create/send/read/close and concurrent surfaces.

The upstream design should provide shared backend contract tests, unit tests with fake CLI adapters, native-regression coverage, and optional real-mux smoke tests. A green skip must prove test discovery/example counts so an unavailable mux cannot produce false evidence.

### Discovery-stage architecture direction (superseded where noted below)

Separate Cohort orchestration from child transport:

- **pi-cohort core owns:** request validation, persona resolution, chains/parallel/dynamic fanout, clarification, worktrees, acceptance/reviewer gates, structured output, model fallback, run/session IDs, persisted status, and result aggregation.
- **Execution backend owns:** availability/capability discovery, safe child launch, pane identity, lifecycle observation, cancellation/interrupt where supported, and cleanup.
- **Native backend:** current process/JSONL implementation and default behavior.
- **Mux adapters:** cmux/tmux/Herdr implementations behind a backend-neutral contract; Zellij/WezTerm can follow from donor behavior.

The key packaging choice remains whether mux adapters ship in pi-cohort core or in a pi-cohort-owned companion package consuming a public backend SPI. A companion package keeps platform-specific support and release compatibility out of the focused core package, but requires a stable registration/loading mechanism.

### Discovery-stage questions (resolved or deferred below)

- Should mux adapters ship inside `pi-cohort`, or in a separately released pi-cohort-owned adapter package?
- Is pane execution explicit per call, configured globally/project-wide, or automatically selected when an adapter is available?
- Should explicit unavailability fail loudly while automatic preference falls back to native?
- Does the first upstream slice implement cmux and tmux, require Herdr immediately, or define the extension point and defer Herdr until its API is sufficiently stable?
- Which adapter capabilities are mandatory versus optional: launch, observe, interrupt, reconnect, takeover/focus, screen read, rename, and close?
- How do backend selection and capabilities compose with foreground/async, nested runs, parallel concurrency, chains, worktrees, cancellation, acceptance, and model fallback?
- Should adapter discovery be static built-ins, package registration, a configured module path, or a typed runtime registry?
- Where does launcher/preset policy live so credentials remain secret without hard-coding Grant's local preset names?
- Which donor extras—Zellij, WezTerm, status widgets, screen APIs—belong in the initial upstream slice?
- What CI contract tests are required for adapters whose real runtime is unavailable on hosted runners?

## Ratified architecture

This section supersedes the discovery-stage direction and the earlier questionary
conclusions where they differ. The reconnaissance above remains the source map for
implementation; this section is the active contract.

### Current status and package boundary

- Core remains `jjuraszek/pi-cohort`.
- `nertzy/pi-cohort-mux` is a **public** GitHub repository. Its npm package is
  private and unpublished.
- Draft PR #1 carries the companion prototype.
- `nertzy/pi-interactive-subagents` remains donor and migration code.
- The first implementation slice is core-only and mux-free. Adapter work follows
  the landed core contract; stable companion release remains deferred.

Core owns all Cohort semantics: validation, agent/persona resolution, chains,
parallelism, fanout, worktree policy, acceptance, output contracts, fallback,
foreground/async coordination, persistence, and aggregation. It also owns:

- child reporting extension injection through `runtimeExtensions`, including
  launches using `--no-extensions`;
- ready/settled/result session-log semantics, parsing, replay, failure ordering,
  durable delivery, and result construction;
- a narrow, mux-independent control protocol: the child reports readiness, and
  core requests interrupt (`ctx.abort`) or shutdown (`ctx.shutdown`); and
- backend selection and the public SPI.

Post-gh-11, pi-cohort has no live parent<->child messaging, foreground detach, or
result-receipt delivery, and `resume` on a running child errors. This design does
not reintroduce any of that under a mux-specific name: there is no "steer" and no
"session rebound" in v1. A blocked child (`BLOCKED:`) is an ordinary terminal
failed result returned to the parent through the existing session-log/result
path, exactly as it is for a native child; it is never modeled as a retained live
child waiting for a decision, and reaching it does not require or imply a visible
surface.

The companion owns only mux availability/detection, safe surface launch, native
mux lifecycle/entity facts, opaque reattach/display metadata, and close/retain
cleanup. It owns no Cohort result semantics or child-control semantics.

### Pi reporting contract

Pi 0.85.0 makes TUI execution and `--mode json` mutually exclusive. Interactive
children therefore receive a pre-created empty `--session` JSONL file. Pi can then
write its header and custom entries from line one. Native stdout JSONL execution is
unchanged.

For interactive children, the session JSONL is the durable result source. Core
injects its reporting extension before launch and knows that session path in
advance. Pi entries and core-owned `ready`, `settled`, `result`, and `control`
entries form one ordered stream. Core parses and replays it; neither core nor an
adapter treats rendered terminal content or polling as result evidence.

`agent_settled` does not end an interactive child. The child stays alive until core
has received durable result delivery, then core requests shutdown. Version-one
progress is entry-granularity, not token-stream fidelity.

### SPI v1 and control plane

SPI v1 is limited to four adapter responsibilities:

1. surface launch;
2. mux lifecycle;
3. reattach metadata; and
4. close/retain cleanup.

Core keeps session parsing/results and control. Its control channel is
mux-independent and handles only ready, interrupt through `ctx.abort`, and
shutdown through `ctx.shutdown`. There is no steer and no session rebound: gh-11
removed live parent<->child messaging from pi-cohort, and `resume` on a running
child errors regardless of backend. cmux hooks are optional corroborating
awareness; tmux needs no Pi hook. Mux facts, child/session facts, and
unknown/no-activity remain provenance-distinct.

`cwd` is mandatory for a surface launch. Worktree metadata is optional awareness
only. Existing `worktreeSetupHook` remains the setup owner; this slice creates no
worktree creation or setup API, and no new worktree retention/reaping ownership
(see Lifecycle below).

### Lifecycle, fallback, and retention

Each logical Cohort child uses one visible surface. Fallback attempts run
sequentially inside that surface; only the final failed attempt is retained.

| Outcome | Required handling |
|---|---|
| successful durable delivery | close surface; core's existing unconditional worktree cleanup runs as today |
| failure (including a `BLOCKED:` terminal result) | retain the surface for inspection until explicit cleanup; core's existing unconditional worktree cleanup still runs in its `finally` block |
| interrupted | preserve core's existing terminal `paused` result and retain the surface with an actionable reattach handle; existing resume/revive behavior remains core-owned |

A successful child closes only after delivery, not merely at child exit. Surface
retention on failure or interruption is purely diagnostic; it is not a promise
about the worktree. The existing `paused` result is not `taken_over` and does not
imply a still-running child or Pi session rebound. `cleanupWorktrees()`
runs unconditionally today (`src/runs/foreground/subagent-executor.ts`,
`chain-execution.ts`, `src/runs/background/subagent-runner.ts`) regardless of
success or failure, and v1 makes no new retention/reaping ownership claim over
that behavior. Special worktree retention tied to outcome, and a distinct
`taken_over`/human-takeover result state, are deferred (see below): gh-11 already
makes `resume` on a running child an error, so there is no live child left to take
over in v1.

### Delivery and deferred scope

The first core-only slice adds session-log reporting, the reporting extension and
control socket, session reader/replay and result construction, deterministic
failure ordering, and native regression coverage. It deliberately adds no mux
adapter.

After that slice, the companion may implement cmux and tmux against the landed
contract. Herdr needs verified public lifecycle/socket APIs before implementation;
its richer capabilities are metadata rather than SPI expansion.

Deferred, not active v1 (several superseded by gh-11's removal of pi-intercom;
do not reintroduce any of these under a mux-specific name without a fresh design):

- steer and session rebound as control-channel operations;
- a distinct `taken_over`/human-takeover result state, and any live decision
  escalation or resumable blocked child;
- durable completion/result receipts beyond the existing session-log/result path;
- outcome-conditional worktree retention or reaping owned by this SPI (worktree
  lifetime stays exactly whatever `cleanupWorktrees()` already does);
- focus manipulation, arbitrary terminal input, screen capture;
- Herdr, Zellij, WezTerm adapters, nested-mux policy, and stable companion release.

Preserve foreground versus async caller semantics: the detached async runner remains
the durable coordinator. Auto-selection may use native when no adapter is available;
an explicitly selected unavailable backend fails loudly. Secret-safe launch rules
remain unchanged: resolved secrets never enter commands, scripts, persisted
environments, logs, or mux metadata.
