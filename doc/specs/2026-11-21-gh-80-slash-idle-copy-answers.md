# A pi-cohort copy without a session stays silent on slash commands

**Ticket:** [#80](https://github.com/jjuraszek/pi-cohort/issues/80)
**Goal:** When pi runs two pi-cohort copies and only one serves the session, a slash command shows the serving copy's answer and nothing else; a copy without a session no longer answers slash-command requests.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-21
**Source bases:** pi-cohort `5ab3ef7` (8.5.0); `@earendil-works/pi-coding-agent` 1.5.0 (the worktree's `node_modules` copy) and the installed 1.6.0 release, both read-only.
**Predecessor:** none

## Problem

pi-cohort can be listed in a user's pi settings and in a project's own pi settings. With both lists set and a trusted project started without `--approve`, pi loads the user-scope extension set first with the project treated as untrusted, then loads the final set, where the project-scope copy wins. The first copy gets no `session_shutdown` and no session events, keeps its event-bus subscriptions, and is not in the final extension list. Two pi-cohort copies now listen on one bus; only the second has a session.

Each copy registers a slash-command request handler at load (`registerSlashSubagentBridge`, wired in `src/extension/index.ts:356-359` with `getContext: () => state.lastUiContext`). `state.lastUiContext` starts as null (`src/extension/index.ts:271`) and is set only when that copy sees `session_start`, an assistant `message_end`, or a UI-visible `subagent` `tool_result` (`src/extension/index.ts:509-520, 534-550`). A handler whose context is null answers the request with an error response - text "No active extension context for slash subagent execution.", `errorText` "No active extension context.", `isError: true` - and returns, before any STARTED event and before a controller is registered (`src/slash/slash-bridge.ts:81-93`).

The requester, `requestSlashRun` (`src/slash/slash-commands.ts:183-260`), resolves on the first response whose request id matches and unsubscribes. The idle copy's reply is synchronous; the serving copy's reply follows an awaited executor call. So the idle copy's error is the one shown, and the serving copy still carries the command out: the user is told a command failed while it took effect unseen.

Observed in triage on a throwaway setup (pi 1.6.0, pi-cohort 8.5.0 listed in user and project settings, trusted project, pi in RPC mode with a probe extension logging `subagent:slash:request`, `subagent:slash:started` and `subagent:slash:response`):

- `/interrupt-child abc` produced two responses for one request: first the no-context error, shown as the error notice, then "Stop id 'abc' is too short; type at least 4 characters of the id at the start of the row."
- `/run scout say hi` produced the no-context error first, then a STARTED event and the serving copy's own response. The result card read "No active extension context for slash subagent execution." and the notice "No active extension context."; the child's result was not shown.
- With `--approve`, with pi-cohort in user settings only, and with pi-cohort in project settings only, `/interrupt-child abc` produced one response, the "too short" text.

Framing: kept (ticket #80) - the scout's objection is that silencing the slash handler leaves the idle copy's other load-time work running (a result file watcher, the prompt-template delegation handler, async and control notice listeners, the `cost:external` listener; `src/extension/index.ts:281-291, 356-390, 485-506`). The ticket's `Out of scope / Follow-up` list parks prompt-template delegation, `/chain`, `/parallel`, background-job notices and pi's own startup, and that recorded scope is adopted.

### Checked claims

| Claim | Source | Lookup | Result |
|---|---|---|---|
| A slash handler with no context answers "No active extension context for slash subagent execution." | ticket Reporter note 1 | read `src/slash/slash-bridge.ts:73-95` | held: null `getContext()` emits a response event with `isError: true` before any STARTED event |
| The command shows the first response for its request id | ticket Reporter note 3 | read `src/slash/slash-commands.ts:183-262` | held: `onResponse` resolves on the first matching response and unsubscribes |
| With no handler answering, the command fails at once, not after 15 s | ticket Reporter note, proposed approach | read `src/slash/slash-commands.ts:251-260`, `src/slash/slash-bridge.ts:80-108` | held: a handler that proceeds emits STARTED synchronously; with no STARTED and no response after the synchronous emit the requester rejects with "No slash subagent bridge responded. Ensure the subagent extension is loaded correctly." |
| Both request handlers read the same per-copy context, null until that copy sees a session | ticket Reporter note 2 | read `src/extension/index.ts:261-271, 356-365, 509-520, 534-550` | held |
| A copy's handlers are disposed only on `session_shutdown` | scout | read `src/extension/index.ts:566-596` | held: a copy that never gets session events never runs that teardown |
| pi starts the user-scope set, then the final set, and keeps the first copy subscribed | ticket Reporter note 5 | read pi 1.6.0 `dist/core/resource-loader.js:365-382, 570-600`, `dist/core/extensions/loader.js:116-165, 425-452` | held by reading: the bootstrap pass forces the project untrusted, the final pass reuses preloaded extensions by resolved path and passes the bootstrap runtime on; no dispose or invalidate call for a copy dropped from the final list |
| One command gets two responses under two copies | ticket Reporter notes 6, 7, 11 | triage run on the throwaway two-copy pi 1.6.0 setup over RPC with a probe extension | held: the three observations listed above |
| The fault belongs to pi 1.6.0 | ticket Context and rows name pi 1.6.0 | `rg loadProjectTrustExtensions` in the worktree's pi 1.5.0 `dist/core/resource-loader.js` | corrected: pi 1.5.0 has the same two-pass load (`:363, 377, 579`); 1.6.0 is where it was observed. `npm view @earendil-works/pi-coding-agent version` prints 1.6.0, so no newer pi exists to check for an upstream fix. The fix does not branch on the pi version |
| pi gives a copy a signal that it was dropped | scout | read pi 1.6.0 `dist/core/extensions/types.d.ts:555-570, 1229` | held as absent: `project_trust` is a trust-decision hook; no per-copy dispose event |
| Two copies can recognize each other by the bus object | approach recon | read pi 1.6.0 `dist/core/extensions/loader.js:197, 428-452` | corrected: `pi.events` is a per-extension wrapper around the shared bus, so object identity is not available |
| The prompt-template handler has the same no-context reply | ticket Reporter note 8 | read `src/slash/prompt-template-bridge.ts:292-306` | held: same branch, text "No active extension context for delegated subagent execution."; asserted by `test/unit/prompt-template-bridge.test.ts:182`; out of scope per the ticket |
| The idle copy's other listeners misbehave | scout Framing line | read `src/extension/index.ts:281-288, 484-506`, `src/runs/background/notify.ts:46-102`, `src/runs/background/completion-dedupe.ts:49-63`, `src/extension/control-notices.ts:33-87`, `src/runs/background/result-watcher.ts:158-178` | not observed failing: completion and control notices dedupe process-wide; the result watcher and tracker do run twice |
| No test puts two slash handlers on one bus | ticket Reporter note 10 | `rg registerSlashSubagentBridge test` | held: `test/integration/slash-commands.test.ts:965, 992` register one each |
| The no-context text for the slash handler is asserted or documented elsewhere | design recon | `rg "No active extension context" src test doc README.md CHANGELOG.md` | held as absent for the slash reply: its text is only at `src/slash/slash-bridge.ts:85, 89`. The search also matches the prompt-template handler's own reply at `src/slash/prompt-template-bridge.ts:302` and its test at `test/unit/prompt-template-bridge.test.ts:182`, both out of scope per the ticket. `doc/commands.md` (Direct commands) says only that the command reports the tool's response through a notice, which stays true |
| Every slash command uses the one request path | design recon | `rg "requestSlashRun\(|runSlashSubagent\(" src` | held: `/run`, `/chain`, `/run-chain`, `/parallel` and `/cohort-doctor` call `runSlashSubagent` (`src/slash/slash-commands.ts:479, 503, 533, 557, 596`), which calls `requestSlashRun` (`:331`); `/interrupt-child` calls it directly (`:583`) |
| An Escape cancel reaches the idle copy too | design recon | read `src/slash/slash-bridge.ts:62-72`, `src/slash/slash-commands.ts:227-233` | held, existing behavior: the idle copy has no controller for the id, adds it to its pending-cancel set and clears it only on `cancelAll` or `dispose` |
| An in-suite test already stops one child of a blocked foreground run through a real handler | design recon | read `test/integration/slash-commands.test.ts:976-1000` | held: `/interrupt-child stops one child of a blocked foreground run` uses `createMockPi`, `createSubagentExecutor` and `registerSlashSubagentBridge` on the harness bus |
| A real-host child can be the suite's mock child | scout open question | read `src/runs/shared/pi-spawn.ts:95-128`, `test/support/mock-pi.ts:100-140` | not available: a real pi host spawns its own entry script; a real-host `/run` needs a model |
| The repo's tests run on pi 1.6.0 | scout implicit dependency | `package.json:87-90`, the worktree's installed pi `package.json` | corrected: devDependency `^1.5.0`, installed 1.5.0 |
| pi's RPC mode accepts a second command while a `/run` handler is awaiting | design recon | read pi 1.6.0 `docs/rpc.md:44`, `dist/modes/rpc/rpc-mode.js:318-343, 663-664` | held: each input line runs as `void handleInputLine(line)` and the `prompt` case does not await `session.prompt(...)` |
| The stop id is visible to a scripted driver | design recon | read `doc/commands.md:20-24`, pi 1.6.0 `dist/modes/rpc/rpc-mode.js:106-134` | held: `/interrupt-child` with no argument prints the running stop ids through a notice, and notices reach an RPC client as extension UI requests |
| pi writes its login file in place | design recon | read pi 1.6.0 `dist/core/auth-storage.js:5, 42, 72, 148` | held: `writeFileSync` on the path under a lock, no rename; a symlinked login file is written through |
| `CHANGELOG.md` has an Unreleased section | design recon | `rg -n "^## \[" CHANGELOG.md` | corrected: the first heading is `## [8.5.0] - 2026-11-20`; this change adds `## [Unreleased]` above it |
| The worktree is clean apart from the spec | design recon | `git status --porcelain`, `git diff -- package-lock.json` | corrected: dependency install rewrote the lockfile's own `version` from 7.6.7 to 8.5.0; the committed lockfile is stale against `package.json`. Not part of this change |

Not checked:

- Stopping a running child under two copies (ticket row 3): never reproduced; it needs a model-backed child that stays running. The real-pi run in Design observes it on the unfixed and the fixed build.
- Whether the reporter's child actually stopped: no session log holding the error text was found.
- The reporter's own settings and trust state were read once in triage; the real-pi run uses a throwaway setup of the same shape, not the reporter's project.

Design decisions recorded from the questionary:

- The rows that need a real child are proven by this flow on a throwaway two-copy pi 1.6.0 setup driven by script, the operator's logged-in model running the child.
- Of three approaches - the idle copy stays silent, the requester ignores an idle answer, the older copy retires itself - the first is chosen: it removes code, adds no construct, and reuses the requester's existing "nobody answered" error.
- A lone copy without a session reads "No slash subagent bridge responded..." after this change; the old wording is not kept.
- The lockfile version drift stays out of this change.

## Acceptance criteria

Ticket #80, "Acceptance Criteria", rows verbatim:

- [ ] With pi 1.6.0 started without `--approve` in a trusted project, and pi-cohort listed in both the user settings and the project's settings, `/interrupt-child abc` gets exactly one response to its request and shows one error notice, "Stop id 'abc' is too short; type at least 4 characters of the id at the start of the row.", and no "No active extension context" notice.
  deviates: unreachable in this checkout - missing source-base stop trace and this worker cannot launch a real scout; proof at top-level pi 1.6.0 two-copy RPC setup
- [ ] In the same setup, `/run scout say hi` shows the result card that a setup with pi-cohort in the user settings only shows for the same command - the child run's own output, generated wording aside - and neither the card nor a notice reads "No active extension context".
  in-scope
- [ ] In the same setup, with a child running, `/interrupt-child <the id at the start of that child's row>` stops the child and shows the stop result that a setup with one copy shows, and no "No active extension context" notice.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-80-slash-idle-copy-answers
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (overrides `## Release`)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3
design: owns `src/slash/slash-bridge.ts`, `test/integration/slash-commands.test.ts`, `CHANGELOG.md`; with an idle and a serving copy on one bus, a slash command gets one response, the serving copy's.

## Design

### Responsibilities

The slash-command request handler of a pi-cohort copy answers only when its copy has a session context. A handler whose `getContext()` returns null ignores the request: no response event, no STARTED event, no controller, no pending-cancel bookkeeping change.

`requestSlashRun` is unchanged. Its two rules stay: the first matching response wins, and a request that gets neither STARTED nor a response during the synchronous emit rejects at once.

### Flow

Two copies, one idle and one serving: the command emits one request. The idle handler returns. The serving handler emits STARTED, runs the executor, and emits its response. The command shows that response. Handler registration order does not matter, because the idle handler never answers.

One copy without a session, for a command that emits a request (`/interrupt-child abc` is the example): the request gets no STARTED and no response, and the command shows "No slash subagent bridge responded. Ensure the subagent extension is loaded correctly." Before this change that case read "No active extension context for slash subagent execution." The ticket lists this case as out of scope; the wording change is accepted and no new message is added. A command whose own local validation rejects it before it emits a request shows that validation's notice as before - `/run scout say hi` can stop at "Subagent session cwd is not initialized yet" (`src/slash/slash-commands.ts:464`) - and local validation is unchanged.

The change does not branch on the pi version.

### Moving parts

Remove:

- In `src/slash/slash-bridge.ts`, the body of the null-context branch of the request handler (`src/slash/slash-bridge.ts:81-93` at the source base: `if (!ctx) {` at 81, the response object at 82-90, the emit at 91, `return;` at 92): the text "No active extension context for slash subagent execution.", the `errorText` "No active extension context.", and the emit.

Add:

- In the same branch, a bare `return` as the whole body when `getContext()` returns null.
- In `test/integration/slash-commands.test.ts`, the four tests named in `## Tests`. The three two-handler tests register a null-context handler first and a serving handler second on the harness bus and observe `subagent:slash:response` events by request id independently of the requester. The serving handler's `execute` in the row 1 and row 3 tests is `createSubagentExecutor(...).execute`, as in the existing blocked-run test, so the "too short" text and the stop come from the real executor and not from a stub that echoes the expected text. The row 2 test wires `/run` itself (the existing `/interrupt-child` harness registers only that command's handler and hides sent messages), captures the messages the command sends, and gives the serving handler a deterministic result. Each test counts the matching response events only after the serving execution has settled and its response has reached the independent observer; a count taken when the command returns reads 1 on the unfixed code too, because the idle reply is synchronous and the serving reply lands later.
- In `CHANGELOG.md`, a `## [Unreleased]` section above `## [8.5.0]` with one `### Fixed` entry ending `(#80)`.

### Reading of the ticket rows

Each row names pi 1.6.0 and a real two-copy start. The test suite installs pi 1.5.0 and replaces the child with a mock, so each row has two proofs: the in-suite two-handler test for the handler behavior, and the real-pi run below for the row as written. In row 2, "the result card that a setup with pi-cohort in the user settings only shows" is read as: the card carries the child run's output and is not an error card; the generated wording differs between runs. In row 3, "the stop result that a setup with one copy shows" is read as the stop acknowledgment the serving copy's executor returns for a resolved child id ("Interrupt requested for child <id> of foreground run <run id>."), and "stops the child" as that same child's entry in the terminal `/run` result reporting `interrupted: true`. An acknowledgment followed by the id leaving the list, or by the `/run` completing, does not rule out the child finishing on its own.

### Real-pi run (paid, external)

- Runner: a throwaway script under the system temp folder, not committed. It starts pi 1.6.0 with `--mode rpc --no-session`, without `--approve`, in a throwaway project that pi's trust file marks trusted, with an isolated agent directory, home and temp folder. A probe extension logs every `subagent:slash:request`, `subagent:slash:started` and `subagent:slash:response` event; the driver also records the notices pi sends as extension UI requests and the custom messages pi emits as RPC `message_end`.
- Two-copy layout: the agent directory's settings and the project's settings both list `npm:pi-cohort`. The script seeds both scope-specific npm roots - `<agent directory>/npm` for the user scope and `<project>/.pi/npm` for the project scope - with a physical install of the same pi-cohort build and its dependencies: two real directory trees, no link to a shared tree. It records both resolved install paths in the run log. No other layout reproduces one idle and one serving copy: pi reuses a preloaded extension whose resolved path matches, so two entries behind one shared realpath are one copy that has a session, and two distinct local package identities both stay in the final list and both get a session.
- Host preflight: the script clears every inherited `PI_SUBAGENT_*` variable from the top-level pi launch's environment and selects the throwaway agent directory explicitly through `PI_CODING_AGENT_DIR`. An inherited `PI_SUBAGENT_CHILD=1` makes each copy skip command registration (`src/extension/index.ts:247-250`), after which an RPC `/run` that no command handles becomes an ordinary paid host prompt; an inherited `PI_SUBAGENT_BASE_AGENT_DIR` overrides the selected agent directory (`src/shared/agent-dir.ts:14-17`). Before it sends any prompt the script sends RPC `get_commands` and requires the reply to list the `/run` and `/interrupt-child` commands; otherwise it stops and reports.
- Inputs: the operator's pi login file `auth.json` and model store `models.json` (pi 1.6.0 `dist/config.js:521-527`), symlinked from the operator's agent directory into the throwaway one, not copied, so pi and the child it spawns have the operator's model access. The links do not carry the operator's model selection, which lives in settings: the script reads `defaultProvider` and `defaultModel` from the operator's own agent-directory `settings.json` and sets both keys in the throwaway agent directory's settings. Before any paid call it sends RPC `get_state` and stops if the reported model is not that pair, or if the operator's settings hold no pair.
- Control, run first, on the source-base build (`5ab3ef7`) in the two-copy layout with both installs holding that build: the stop sequence of row 3 below. The `/interrupt-child <id>` request id must get two `subagent:slash:response` events in this order: the idle copy's no-context error, then the serving copy's child-stop acknowledgment. If it does not, the script stops and reports the two-copy proof as invalid, and no fixed-build check counts. The control's log keeps the serving handler's outcome (its acknowledgment, and whether that child's entry in the `/run` request's terminal response reports `interrupted: true`) apart from what the command displayed (the notice the user saw).
- Fixed-build checks: the same two-copy layout with both installs holding this branch's build. A row is reported as failed if any of its predicates is unmet.
  - Row 1, `/interrupt-child abc`: after the command completes, exactly one `subagent:slash:response` for its request id; exactly one error notice, with the full text "Stop id 'abc' is too short; type at least 4 characters of the id at the start of the row."; no notice containing "No active extension context".
  - Row 2, `/run scout say hi`, run with two copies and once with pi-cohort in the agent directory's settings only, for comparison: in both runs the driver captures the final `subagent-slash-result` custom message for the request id from RPC `message_end` - the command sends an initial running message first, which is not the card. Each final card must be a non-error card carrying that run's successful child output, and neither the card nor any notice may contain "No active extension context". The two runs are compared on that behavior, not on the generated wording.
  - Row 3, the stop sequence: `/run scout Run the bash command "sleep 120", then reply "done".` While that `/run` is outstanding the driver sends `/interrupt-child` with no argument every 2 seconds for up to 60 seconds and reads the rows in the notice. It takes the id from the running `scout` child row, not from the foreground run's row, which is listed first; the row fails if no `scout` child id appears within the bound. Then `/interrupt-child <that id>`: exactly one `subagent:slash:response` for the stop request id; the child-specific info notice "Interrupt requested for child <id> of foreground run <run id>."; no notice containing "No active extension context"; and `interrupted: true` for that same child in the `/run` request's terminal result.
- Each `/run` is one paid child run on the operator's default model: two for row 2 and one stop sequence each on the source-base and the fixed build. Approving this spec authorizes every action named in this subsection for the whole flow, across seed, rows, repairs and finish, without per-step permission prompts. An action not named here needs separate explicit authorization.
- The run's logs stay under the system temp folder and are the evidence for the three ticket rows as observed in this setup.

## Errors and edge cases

- A lone copy without a session, given a command that emits a request (`/interrupt-child abc`), fails at once with "No slash subagent bridge responded. Ensure the subagent extension is loaded correctly."; there is no 15-second wait. A command that its own local validation rejects never emits a request and keeps that validation's notice.
- `/chain`, `/parallel`, `/run-chain` and `/cohort-doctor` send through the same request path and lose the false error too. They get no test and no real-pi check of their own; the ticket lists them as unchecked.
- Escape during a command cancels in the serving copy as before. The idle copy still records the cancelled id in its pending-cancel set and never clears it; that is the behavior before this change and stays.
- The prompt-template delegation handler keeps its no-context reply and its existing test.
- Two copies that both have a session context are not addressed; that state was not observed.

## Tests

All new tests are in `test/integration/slash-commands.test.ts`.

- Row 1: with an idle handler registered before a serving one whose `execute` is `createSubagentExecutor(...).execute`, `/interrupt-child abc` yields exactly one `subagent:slash:response` for its request id, counted after the serving response has reached the independent observer, and one error notice, the "Stop id 'abc' is too short..." text - `/interrupt-child abc gets only the working handler's answer when an idle handler registered first`.
- Row 2: with an idle handler registered before a serving one that returns a deterministic result, and `/run` wired with its sent messages captured, `/run` shows the serving handler's result, and no result card or notice contains "No active extension context"; the response count is taken after the serving execution has settled - `/run shows the working handler's result when an idle handler registered first`.
- Row 3: with an idle handler registered before a serving one whose `execute` is `createSubagentExecutor(...).execute`, and a blocked foreground run, `/interrupt-child <id>` stops the child and shows the stop result, with exactly one response for the stop request id counted after the serving response has reached the independent observer - `/interrupt-child <id> stops a running child when an idle handler registered first`.
- A lone handler without a session: the command shows "No slash subagent bridge responded" as an error notice - `/interrupt-child reports no handler when the only handler has no session`.
- Rows 1-3 as written, on pi 1.6.0 with two real copies - none: the suite installs pi 1.5.0 and a mock child; the real-pi run in Design is the proof.
- Handler registration order does not matter - none: the null-context return does not depend on order, and idle-first is the order that failed.
- `/chain`, `/parallel`, `/run-chain`, `/cohort-doctor` lose the false error - none: same request path, unchecked per the ticket.
- Escape cancel behavior is unchanged - none: no code on that path changes.
- The prompt-template handler keeps its no-context reply - `test/unit/prompt-template-bridge.test.ts` (existing).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - a new `## [Unreleased]` section with one `### Fixed` entry (major procedures / conventions: the release script promotes that section)
- Derived / memory docs invalidated: none

The materiality bar is `reference/documentation-impact.md`. `doc/commands.md` (Direct commands) was a candidate and is dropped: it never documented the no-session wording, so nothing in it goes stale.

## Out of scope

- With pi 1.6.0 started without `--approve` in a trusted proje - unreachable in this checkout - missing source-base stop trace and this worker cannot launch a real scout. Keep the short-id regression and fix; the integration check does not prove the live setup.

- The prompt-template delegation handler's no-context reply (`src/slash/prompt-template-bridge.ts`).
- The idle copy's result file watcher, async and control notice listeners, and `cost:external` listener.
- pi leaving the first copy running; no change to pi and no pi-version check.
- A new message for a slash command when the only pi-cohort copy has no session.
- A committed real-pi harness; the real-pi run uses a throwaway script.
- The stale `version` field in `package-lock.json`. The worktree carries it as an unstaged modification; every commit of this change stages its paths by name, and `package-lock.json` stays unstaged and untouched.

## Open questions

None.
