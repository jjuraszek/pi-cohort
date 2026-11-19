# A forked child reports only its own attempt's turns and cost

**Ticket:** none
**Goal:** A child started from a copy of the parent's conversation reports the turns, cost, model, activity, edits and final answer of its own attempt only, on every path that reads a child's saved conversation, and background runs end with the usage their attempts recorded.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-18
**Source bases:** pi-cohort `f1e5ef5` (8.4.0); `@earendil-works/pi-coding-agent` 1.5.0 as installed in `node_modules`, read-only.
**Predecessor:** none superseded. `doc/specs/2026-10-29-gh-37-external-child-turn-open.md` is reused unchanged: its synthesized events still derive from `pendingMessages`, which now holds the attempt's own entries only.

## Problem

Report (Slack paste, pi-cohort 8.4.0, no ticket; a search of open and closed issues in `jjuraszek/pi-cohort` found no prior report): an implementer dispatched without `context: "fresh"` reported about $21.14 over 89 turns; 67 of those turns ($20.32) carried entry ids copied from the parent session, the child's own 22 turns cost about $0.82, and closeout added the reported total to the parent's, logging $123.84 instead of about $103.53.

Original prompt for this spec: `let fix it in short gauntlet. make sure to scan for any potential root causes no bandaid and no followups`.

Terms used below:

| Term | Meaning |
|---|---|
| pane child | A child on an external execution backend (it runs interactive pi in its own terminal pane); pi-cohort learns its result by reading its session file |
| streaming child | A child run as a pi subprocess in JSON mode; pi-cohort reads its events from stdout |
| `ready` report | The custom session entry the in-child reporter appends once per attempt identity at `session_start` (`src/execution-backend/reporting-extension.ts:104-110`) |
| reader | `replayExecutionSession` in `src/execution-backend/session-replay.ts` |
| reporter | The in-child extension in `src/execution-backend/reporting-extension.ts` |
| attempt record | One `ModelAttempt` in a step's `modelAttempts` (`src/shared/types.ts:272-278`); its `usage` is a full `Usage` (tokens, cache, cost, turns) |

Root causes, all confirmed in source at `f1e5ef5`:

1. The reader treats the whole terminal branch of a session file as one attempt. `messages` walks `parentId` from the attempt's `result` entry to the root (`session-replay.ts:130,139-155`) and `pendingMessages` is every message entry in the file (`:131-133`). A fork copies the parent's root-to-leaf entries into the child file under their original ids (`src/shared/fork-context.ts:57-83`; pi `dist/core/session-manager.js:1217-1290`), so both lists start with the parent's turns. Everything downstream inherits that: `usageFrom` sums cost, tokens and turns over every assistant and takes the first model (`src/runs/shared/external-execution.ts:174-192`), the edit check scans every message (`src/runs/foreground/external-single-attempt.ts:140`, `src/runs/background/external-attempt.ts:85-98,188`), the watcher forwards the whole list from index 0 as live activity (`src/execution-backend/session-watcher.ts:55,97-102`), and background live totals add each forwarded turn (`src/runs/background/subagent-runner.ts:1802-1816`).
2. The same cause re-counts earlier attempts. A fork or resume reuses one session file across attempts (`subagent-runner.ts:840-841`), each attempt's replay is cumulative, and the foreground adds every attempt's usage (`src/runs/foreground/execution.ts:943`).
3. The reporter builds the final result from the whole branch (`reporting-extension.ts:54-67,132-138`). With no reply from this attempt, the parent's last assistant turn decides outcome and final output.
4. Background completion replaces the live totals with a reread of a session folder. `parseSessionTokens` (`src/shared/session-tokens.ts`) sums every line of the newest `.jsonl` in `<sessionDir>/parallel-N` (`subagent-runner.ts:2527-2543,2697-2728`). A forked or resumed child's file lives elsewhere (`<sessionRoot>/run-N`, `src/runs/foreground/subagent-executor.ts:2386-2395`; `sessionDir` is `<sessionRoot>/async-<id>`, `src/runs/background/async-execution.ts:656,876`), so the reread returns nothing, the fallback `tokenUsageFromAttempts` (`subagent-runner.ts:189-199`) carries tokens without cost, and `statusPayload.totalCost = previousCumulativeCost` writes the step's cost out of the saved status. For a child that retried on separate files the reread counts only the newest.

Reproduction (triage, real fork resolver and external owner, no model): a parent with three $1 assistant turns, a forked pane child with one own $0.25 turn. The fork file held 4 assistant entries, 3 sharing ids with the parent; the child reported `{cost: 3.25, turns: 4}`; a fresh control reported `{cost: 0.25, turns: 1}`. The terminal branch was `user > assistant x3 > ready > user > assistant > settled > result`.

Framing: kept - approach A (cut at the reader on the attempt's `ready` entry, replace the background reread); a per-call-site trim of usage was rejected as a band-aid because the reader also feeds the edit check, activity and output checks.

### Checked claims

| # | Claim | Source | Result |
|---|---|---|---|
| 1 | A fork copies parent entries under their original ids; labels are re-created after the path | `fork-context.ts:57-83`; pi `session-manager.js:1217-1290`; repro | held |
| 2 | The reader rebuilds `messages` from the `result` entry to the root and `usageFrom` sums every assistant on it | `session-replay.ts:130,139-155`; `external-execution.ts:174-192,205-206`; repro | held |
| 3 | The `ready` report sits after inherited entries and before the attempt's own messages | `reporting-extension.ts:104-110`; repro branch walk | held |
| 4 | Replay unit fixtures put messages before `ready` and off its parent chain | `test/unit/execution-session-replay.test.ts:11-27` | held - an order the reporter never writes |
| 5 | The watcher forwards the whole `pendingMessages` list from index 0 for every attempt | `session-watcher.ts:55,97-102` | held |
| 6 | The reporter picks outcome and final output from the last assistant on the whole branch | `reporting-extension.ts:54-67,132-138` | held (read, not run) |
| 7 | The edit check scans every replayed message | `external-single-attempt.ts:140`; `external-attempt.ts:85-98,188` | held |
| 8 | A streaming child writes the session header, then only live events, so it never replays inherited turns | pi 1.5.0 `dist/modes/print-mode.js:81-108`, `dist/core/sdk.js:83-86` | held as a source trace, no live model run; compared with the host's pi 1.5.2: `sdk.js` and `dist/core/session-manager.js` are identical, and the `print-mode.js` differences touch runtime disposal and the signal handler only, not the header-then-live-events path |
| 9 | Triage: the background completion tally double-counts a forked child | `subagent-executor.ts:2386-2395`; `async-execution.ts:656,876`; `subagent-runner.ts:189-199,2527-2543,2697-2728` | corrected - the reread looks in a folder a forked child's file is never in and falls back to tokens without cost, so the step ends with cost 0; `parseSessionTokens` itself sums every line of the newest file (repro: 3.25) |
| 10 | Foreground retries add each attempt's usage; forked and resumed attempts reuse one session file | `execution.ts:943`; `subagent-runner.ts:840-841` | held |
| 11 | The session total sums per-run and per-job values and never rereads child sessions | `src/extension/grand-total.ts:25-33,62-67`; `src/runs/background/async-job-tracker.ts:224-227,310-311` | held - async jobs keep the maximum value seen |
| 12 | The reporter's run used a pane backend on 8.4.0 | bug report | not checked - no session files or backend name supplied |
| 13 | Every attempt record carries full usage, on streaming and pane background paths | `types.ts:272-278`; `subagent-runner.ts:967-974,1081-1088,1141-1148`; `execution.ts:943-950` | corrected - held for streaming attempts and for pane attempts that return; a pane attempt that throws records zero usage (`subagent-runner.ts:898-914`, pushed at `:967-974`) even after paid turns were observed, and no record counts non-assistant charges (`external-execution.ts:174-192`, `subagent-runner.ts:358-374`). Design "Attempt usage" changes both. The launch-failure exit at `subagent-runner.ts:1070-1076` records no attempt |
| 14 | Background live totals come from child events, then completion overwrites them from the folder reread | `subagent-runner.ts:1802-1816,2527-2543,2697-2728` | held |
| 15 | Attempt identities are unique per launch, so each attempt writes its own `ready` report | `subagent-executor.ts:608,2334`; `execution.ts:856,909`; `subagent-runner.ts:890`; `external-execution.ts:296` | held for the exact triple (`runId`, `childId`, `attemptId`) - a resume launches under a fresh run id and reuses the session file. Foreground `childId` and `attemptId` repeat across runs (`child-<index>`, `child-<index>-attempt-<i>`, `execution.ts:856,909`), so a pane child forked from a foreground pane child inherits a `ready` report that differs only in `runId`; Design "Reader" keeps it from claiming the child's stream |
| 16 | A child's own footer total is seeded from its whole branch and never reaches the parent total | `grand-total.ts:94-109`; `src/extension/index.ts:532-544`; `subagent-executor.ts:1257,1825,2112` | held |
| 17 | The structured-output reask and the parent-only tool-call filter read the child's model context, not usage | `src/runs/shared/subagent-prompt-runtime.ts:263-289` | held - the filter already sets an inherited/own boundary at session start |
| 18 | No other code path reads a child session for attribution | `rg "getBranch\(\|getEntries\(\|buildSessionContext\|readSession\|getSessionFile\(" src` | corrected - the reader list is complete (the replay at `external-execution.ts:322,360,385,452`, the reporter, the folder reread, the footer seed, slash snapshot restore and transcript links), but the replay also attributes inherited report entries: a fork copies custom entries (pi `session-manager.js:1217-1249` drops only labels), and a copied `ready` with this attempt's `childId` and `attemptId` under another `runId` throws `execution report correlation mismatch` (`session-replay.ts:65-67,102-104`; probe: a replay of [parent `ready`, user message, child `ready`] under the child identity throws) |
| 19 | The reporter finds its reports in file order and its messages in tree order | `reporting-extension.ts:27-32,136`; pi `session-manager.js:1074-1084` | held - ownership by write order uses `getEntries()` positions |
| 20 | A result with no assistant message is `failed` / `result_missing` before the abort check | `reporting-extension.ts:54-60` | held |
| 21 | The edit flag of a streaming child is per attempt | `execution.ts:185,466`; `subagent-runner.ts:299,352` | held |

Implicit dependencies: the old intercom bridge and its fork setting - searched source, README, docs and CHANGELOG - not found (removed per `CHANGELOG.md:303`). A cmux or tmux pane and the reporter's 8.4.0 session - not checkable: no input supplied. A live model turn in a pane - not checkable in this flow: verification uses saved conversations without model calls (questionary answer below).

Questionary answers: proof is tests that fork a real saved conversation with priced parent turns and assert each path, with no model calls; approach is the cut at the reader on the existing `ready` report plus replacing the background reread. Assumed, not asked: a forked child's own pane footer keeps showing the whole conversation's spend, because that value never reaches the parent total.

## Acceptance criteria

Drafted from the design, no ticket rows:

- [ ] A forked pane child whose saved conversation starts with three copied parent turns costing $1 each, and which makes one turn of its own costing $0.25, reports 1 turn, $0.25 and the model of its own turn.
  in-scope
- [ ] While a forked pane child runs, the live message feed delivers only messages the child wrote; it delivers none of the copied parent messages and nothing before the child's session has started.
  in-scope
- [ ] A forked pane child that settles without producing a reply of its own ends as failed with `result_missing`, not as a success carrying the parent's last answer.
  in-scope
- [ ] A forked pane child that edits no file is not marked as having edited files when the copied history contains a parent file edit, in foreground and background runs.
  in-scope
- [ ] After two attempts on one saved conversation, the second attempt's reported usage covers only the turns made in that attempt, and the child's total is the sum of the two attempts.
  in-scope
- [ ] A background run of a forked child ends with that child's own usage in its saved status: `steps[].tokens` (`{input, output, total}`) and `steps[].modelAttempts[].usage` carry the child's own tokens and cost, and the run's `totalTokens` and `totalCost` include them, where `totalCost` was 0 before.
  in-scope
- [ ] A background step that retried ends with the usage of every attempt in its saved status, where only the newest session file was counted before.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: fork-child-inherited-usage
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; the overrides file has no `## verification-before-completion` or `## PR gate` section and the repo has no `.pi/settings.json`, so no `piGauntlet.verifyBeforeShip`)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7
design: owns `src/execution-backend/session-replay.ts`, `src/execution-backend/reporting-extension.ts`, `src/runs/shared/external-execution.ts`, `src/runs/background/subagent-runner.ts`, `src/shared/session-tokens.ts` (removed), the test files named under Tests, `doc/observability.md`, `CHANGELOG.md`; a pane child's reported messages, usage, model, edit flag, live feed and final result cover only entries appended after its attempt's `ready` report, a report copied in before that `ready` does not claim the attempt's stream, and a background run's completed totals are the sum of every step's attempt records, which carry the attempt's own assistant turns and non-assistant charges.

## Design

### Ownership rule

A session entry belongs to an attempt when it was appended to the file after that attempt's `ready` report. Append order is file order; the file only grows. The reporter writes `ready` once per attempt identity at `session_start`, after any copied parent entries and after any earlier attempt's entries, and before the attempt's first own message. Before an attempt's `ready` report exists, no entry belongs to it.

Ownership is decided by file position, not by ancestry in the conversation tree: the walk from a result to the root still runs and still validates every parent link, and its output is then restricted to owned entries.

The rule covers report entries and non-message entries as well as messages. The attempt's `ready` entry is the one whose report matches the identity's exact triple (`runId`, `childId`, `attemptId`). A report entry positioned before it is inherited: it does not belong to the attempt and does not claim its stream.

The session file itself is not changed. The child's model context, the saved conversation, its export and its transcript link keep the inherited history.

### Reader (`src/execution-backend/session-replay.ts`)

`replayExecutionSession(content, identity)` locates the entry that carries this identity's `ready` report among the parsed entries: the report entry of kind `ready` whose `runId`, `childId` and `attemptId` all match.

| Output | Before | After |
|---|---|---|
| `messages` | every message entry on the `result` entry's parent chain | the same chain, restricted to message entries positioned after the `ready` entry |
| `pendingMessages` | every message entry in the file | message entries positioned after the `ready` entry, in file order; empty while no `ready` entry exists |
| `reports`, `controls`, `result`, `pendingResult` | built from every report matching the exact triple; a partial match (this `attemptId` with this `runId` or this `childId`, `hasClaimedStream` at `:65-67`) anywhere in the file throws `execution report correlation mismatch` | exact-triple reports are collected and validated as before, wherever they sit; a partial match throws only when positioned after the `ready` entry, and is skipped as inherited when positioned before it or while no `ready` entry exists |
| non-message charges (new output) | - | the top-level `usage` of non-message entries positioned after the `ready` entry, in two lists that mirror the two above: those on the `result` entry's parent chain, and all of them in file order |
| `incompleteTrailingLine`, every other thrown error | - | unchanged |

`pendingMessages` stays append-only for a given identity, so the watcher's count-based dedupe (`session-watcher.ts:55,97-102`) needs no change.

Consumers that become correct through this input, with no edit of their own unless the row says so:

| Consumer | Location |
|---|---|
| Cost, tokens, turns, model of an attempt's assistant turns | `usageFrom`, `src/runs/shared/external-execution.ts:174-192` (edited only to add non-assistant charges, see "Attempt usage") |
| Messages returned to the parent, final-output and earlier-error checks | `src/runs/foreground/external-single-attempt.ts:122-154`, `src/runs/foreground/attempt-finalization.ts:209-265` |
| Edit flag | `external-single-attempt.ts:140`, `src/runs/background/external-attempt.ts:85-98,188` |
| Live feed and synthesized child events | `src/execution-backend/session-watcher.ts`, `external-attempt.ts:118-176` |
| Background live tokens, cost, turns and activity | `src/runs/background/subagent-runner.ts:1737-1835` |
| Per-attempt sums across retries | `src/runs/foreground/execution.ts:943-950`; attempt records at `subagent-runner.ts:974,1083,1148` |
| Session total | `src/extension/grand-total.ts`, fed by the values above |

### Reporter (`src/execution-backend/reporting-extension.ts`)

At settle, the reporter builds its result from the branch entries that are positioned after this attempt's `ready` entry in `sessionManager.getEntries()`. The existing `result()` logic then applies unchanged: no assistant message among them yields `failed` with `result_missing`; otherwise the last owned assistant decides outcome, final output, error and stop reason. The report shape and protocol version are unchanged.

### Attempt usage (`src/runs/shared/external-execution.ts`, `src/runs/background/subagent-runner.ts`)

An attempt record's `usage` is the attempt's own spend: its assistant turns plus its non-assistant charges. pi 1.5.0 stores model spend outside assistant messages in three entry types that carry a top-level `usage`: `usage` (for example `cache_warm`), `compaction` and `branch_summary` (`dist/core/session-manager.d.ts:36-67`; pi's own session stats sum the same three, `dist/core/agent-session.js:3470-3475`). The removed folder reread counted them (`session-tokens.ts:29-35`); `usageFrom` (`external-execution.ts:174-192`) and the streaming counter (`subagent-runner.ts:358-374`) count assistant messages only. Without this section a fresh background child with one $0.25 turn and one $0.50 compaction would drop from $0.75 to $0.25 once attempt records become the completion source.

| Child | Source of non-assistant charges | Counted into |
|---|---|---|
| Pane (foreground and background share `mapResult`, `external-execution.ts:201-206`) | the reader's non-message charges on the `result` entry's parent chain, positioned after `ready` | `input`, `output`, `cacheRead`, `cacheWrite` and `cost` of the usage `usageFrom` builds; `turns` and `model` stay assistant-only |
| Streaming, background (`runPiStreaming`, `subagent-runner.ts:358-374`) | `result.usage` of each `compaction_end` event and top-level `usage` of non-message `entry_appended` events; additionally, newly appended `branch_summary` entries in the exact attempt session file, reconciled at child close | the same five fields of the attempt's `usage`; summary charges never add turns or select a model |

Tool results are another non-assistant spend source: pi 1.5.0 emits `toolResult.usage` on canonical `message_end` events (`pi-agent-core/dist/agent-loop.js:663-679`) and counts it in session stats (`pi-coding-agent/dist/core/agent-session.js:3484-3489`). Sum owned tool-result usage in pane `usageFrom` (including failed-attempt replay) and background streaming `message_end`, without incrementing turns or selecting a model. Do not count the same tool execution from additional tool lifecycle events.

Each charge is counted once. Inherited charges are excluded: a pane child's copied `usage`, `compaction` and `branch_summary` entries sit before its `ready` entry, and a streaming child's stdout carries only live events (claim 8).

Streaming summary reconciliation stays inside the existing runner accounting component. For a persisted native attempt, pass an exact session file through the existing `buildPiArgs` option: preserve the supplied fork/resume file, otherwise choose a unique file within the existing session directory for each attempt. Keep disabled persistence disabled; do not create an additional transcript for an explicitly in-memory run. Snapshot the existing parsed-entry prefix immediately before launch, after any header stamping. At close, after the remaining stdout has been consumed and before returning usage, add only newly appended `branch_summary.usage` from this exact file, even on interrupted or nonzero exits. Do not select a file by modification time or reread other charge kinds. Capture a fresh boundary on every retry/resume. The boundary must tolerate Pi's supported legacy migration (entry order/count survives; byte offsets and v1 IDs do not). Exclude a summary already charged through `entry_appended` by its entry ID. Preserve the exact final session path for resume metadata. Missing files on a never-started conversation contribute no disk charge; unreadable, malformed or replaced files, and truncated files that lose part of the prelaunch history or an entry the runner saw on the event stream, must surface an accounting diagnostic without discarding usage already received through events or attributing an ambiguous inherited prefix. A truncation that removes only a branch summary saved without an event leaves no evidence: it raises no diagnostic and its charge is not counted. Saved summary charges are counted in append order, including summaries of abandoned branches.

Thrown pane attempt. A background pane attempt that throws after launch (an interruption that ends without a durable result, `result_missing`, the start deadline, a rejected session file) records the usage its session file shows, where the catch block records zeros today (`subagent-runner.ts:898-914`). The usage comes from one read of the attempt's session file, replayed under the attempt's identity and summed over the entries the attempt owns in file order: `pendingMessages` plus every owned non-message charge, because no result entry defines a final branch. A file that cannot be read or replayed, or that holds no `ready` report for the attempt, gives zero. No terminal result is invented: the record's success flag, exit code, error, messages and final output stay what the catch block produces today.

### Background completion (`src/runs/background/subagent-runner.ts`)

One rule replaces the per-site tallies. At every completion write, a step's `tokens` is `{ input, output, total: input + output }` summed over the `usage` of that step's attempt records (`steps[].modelAttempts[].usage`), and the run's `totalTokens` and `totalCost` are the sums of `input`, `output` and `cost` over the attempt records of every step in `statusPayload.steps`, static, parallel and dynamic. Cost is saved per attempt in `steps[].modelAttempts[].usage.cost` and per run in `totalCost`; `steps[].tokens` holds no cost key and no step cost field is added.

Completion writes happen at three sites: after a parallel group's tasks have all ended (`:2527-2543`), after a single step ends (`:2697-2728`), and after a dynamic fan-out group's children have all ended (`:2152-2260`). The dynamic group has no tally today: its children reach `totalTokens` and `totalCost` only through live events (`:1812-1815`), and the next static step's write replaces both with a cumulative value that leaves them out.

The write is unconditional and never falls back to live totals: a step with attempt records gets their sum as `tokens`, zero included, and a step with no attempt record adds zero to the run totals. The `previousCumulativeTokens` and `previousCumulativeCost` counters (`:1486-1487`) are removed; the recomputed sum replaces them.

### Moving parts

Remove:
- `src/shared/session-tokens.ts` (`parseSessionTokens`) and its import at `src/runs/background/subagent-runner.ts:75`.
- `tokenUsageFromAttempts` at `src/runs/background/subagent-runner.ts:189-199`.
- `test/integration/session-tokens.test.ts`.
- The `parseSessionTokens` import and case at `test/unit/grand-total-cost.test.ts:6-19`.
- The `previousCumulativeTokens` and `previousCumulativeCost` counters at `src/runs/background/subagent-runner.ts:1486-1487`.

Add:
- In `replayExecutionSession`: the position of this identity's exact-triple `ready` entry, the restriction of `messages` and `pendingMessages` to message entries after it, the two lists of non-message charges after it, and the exemption of partial-match reports positioned before it from the correlation check.
- In the reporter's settle step: the same restriction of the branch before `result()` runs.
- In `src/runs/shared/external-execution.ts`: `usageFrom` adds the reader's non-message charges to tokens and cost, and the same sum is exposed for the owned entries of an attempt that has no result.
- In `src/runs/background/subagent-runner.ts`: one function that sums attempt-record lists into `{ input, output, total, cost }`, called at the three completion sites; the streaming counter's non-assistant charges and exact-file, prelaunch-prefix reconciliation of saved branch-summary charges; the thrown pane attempt's usage from a final replay. Extend the existing mock runner's session writer to persist scripted summary entries for tests.
- The test cases under Tests.
- The documentation edits under Documentation impact.

Change:
- Test fixtures that place an attempt's messages before its `ready` report (known: `test/unit/execution-session-replay.test.ts:11-27`; audit the fixtures in every test file named under Tests) write them after it, the order the reporter produces.

### Paid and external actions

None. Implementation and verification make no model call and no network request. Approving this spec authorizes every action named in this section for the whole flow, across seed, rows, repairs and finish, without per-step prompts; no action is named.

## Errors and edge cases

| # | Case | Behavior |
|---|---|---|
| E1 | The attempt's `ready` report is not in the file yet | `messages` and `pendingMessages` are empty; the existing start deadline still fails an attempt whose `ready` never appears (`external-execution.ts:294-330`) |
| E2 | A forked attempt is aborted before its first own reply | `failed` with `result_missing`, as a fresh child reports today (`reporting-extension.ts:54-60`) |
| E3 | The session reloads inside one attempt | no second `ready` is written; the cut stays at the first |
| E4 | A retry or a resume runs on the same file | the new attempt writes its own `ready`; only entries after it belong to the new attempt |
| E5 | The child rewinds its conversation tree to a point inside the copied history and continues | turns appended after `ready` on the final branch are counted; copied turns are not |
| E6 | A retry on a reused file follows an attempt that edited files | the retry's edit flag reflects only the retry's own tool calls, as for a streaming child (`execution.ts:185`, `subagent-runner.ts:299`) |
| E7 | A background attempt never launched | it has no attempt record and adds zero; an interrupted streaming attempt keeps the usage counted from its events (`subagent-runner.ts:1081-1088`); a thrown pane attempt is E10 |
| E8 | A malformed file: blank or unparsable complete line, duplicate entry id, report sequence gap, report out of order, missing or cyclic parent link on the result's chain | the same error as before, including for links inside the copied history |
| E9 | An incomplete trailing line | ignored until complete, as before |
| E10 | A background pane attempt throws after paid turns (an interruption without a durable result, `result_missing`, a rejected session file) | its record carries the usage of the entries it owns from a final replay, inherited entries excluded; zero when the file cannot be replayed or holds no `ready` for the attempt; the saved step and run totals keep that usage |
| E11 | A pane child is forked from a foreground pane child, so its file starts with a copied `ready` report carrying its own `childId` and `attemptId` under the parent's `runId` | the copied report is skipped as inherited; the child's own `ready`, `settled` and `result` are read and validated as before |
| E12 | A report with this attempt's `attemptId` and a mismatched `runId` or `childId` appears after the attempt's own `ready` | `execution report correlation mismatch`, as before; when the attempt's own `ready` never appears, the start deadline fails the attempt (E1) |
| E13 | A child pays for a compaction, cache warm or saved branch summary of its own | the charge is in the attempt's tokens and cost and not in `turns`; the same kind of charge copied from the parent is excluded; a streaming summary observed both on disk and through an event counts once |
| E14 | A dynamic fan-out is followed by another step | the fan-out children's usage is still in `totalTokens` and `totalCost` after the later step's completion write |

## Tests

Every case builds its session files on disk; forked cases create the child file through the real fork resolver from a parent conversation with priced assistant turns. No case calls a model.

- AC 1: forked pane child with three $1 parent turns and one $0.25 own turn reports `turns: 1`, `cost: 0.25` and its own model; a fresh child with the same own turn reports the same - `test/unit/external-foreground-execution.test.ts`
- AC 2: the live feed emits no inherited message and nothing before `ready` - `test/unit/execution-session-watcher.test.ts`
- AC 3: reporter returns `failed` / `result_missing` for a forked attempt with no own reply, and the child's own answer when one exists - `test/integration/execution-reporting-extension.test.ts`
- AC 4: an inherited edit does not set the edit flag, with the real owner replaying a file made by the real fork resolver - `test/unit/external-foreground-execution.test.ts` (foreground), `test/integration/background-external-execution.test.ts` through `runExternalBackgroundAttempt` (background). `test/unit/external-single-attempt.test.ts` and `test/unit/background-external-attempt.test.ts` drive a fake owner that returns a hand-built result, never run the reader, and carry no proof here.
- AC 5: a second attempt on a reused file reports only its own turns and the child total equals the sum of both attempts - `test/unit/external-foreground-execution.test.ts`
- AC 6: a background forked pane step ends with its own usage in `status.json`: `steps[0].tokens` (`{input, output, total}`), `steps[0].modelAttempts[].usage`, `totalTokens` and `totalCost` - `test/integration/detached-external-orchestration.test.ts` (full runner; `runSingleStep` in `test/integration/background-external-execution.test.ts` never reaches the completion writes)
- AC 7: a background step with two attempts ends with both attempts' usage in the saved status - `test/integration/async-execution.test.ts`
- E1, E4, E5: the reader returns only entries appended after the identity's `ready`, nothing before it exists, only the second attempt's entries for the second identity, and the new turns of a rewound tree - `test/unit/execution-session-replay.test.ts`
- E2: covered by the AC 3 case with an applied abort and no own reply - `test/integration/execution-reporting-extension.test.ts`
- E3: a reload writes no second `ready` - `test/integration/execution-reporting-extension.test.ts` ("uses the API append seam for ready, settled, and one terminal result across reloads", existing)
- E6: a second attempt after an editing first attempt reports no edit of its own, with the real owner replaying the reused file - `test/unit/external-foreground-execution.test.ts`
- E7: a step whose attempt never launched adds zero to the saved status totals; stopping between a paid retryable attempt and fallback retains the first attempt's records without launching or recording the next candidate - `test/integration/async-execution.test.ts`
- Tool-result charges: an owned $0.50 tool charge plus a $0.25 assistant turn totals $0.75 with one turn, while a copied parent tool charge is excluded; canonical tool-result events count once - `test/unit/external-foreground-execution.test.ts`, `test/integration/async-execution.test.ts`
- E10: a forked background pane child pays for one own turn and is interrupted with no durable result; `steps[].modelAttempts[].usage`, `totalTokens` and `totalCost` in `status.json` hold that turn and none of the inherited spend - `test/integration/detached-external-orchestration.test.ts`
- E11, E12: the reader skips a copied partial-match `ready` positioned before the identity's own and still throws for one positioned after it - `test/unit/execution-session-replay.test.ts`; a pane child forked from a foreground pane child's saved conversation (both `child-0` / `child-0-attempt-0`, different `runId`) completes with its own result - `test/unit/external-foreground-execution.test.ts`
- E13: the reader returns only the charges positioned after `ready` - `test/unit/execution-session-replay.test.ts`; a fresh and a forked background pane child, each with one $0.25 turn and one $0.50 compaction of its own (the forked parent's history also holds a priced compaction), end with `totalCost` 0.75 - `test/integration/detached-external-orchestration.test.ts`; a fresh background streaming child whose event stream carries a priced `compaction_end` ends with that charge in `totalCost` - `test/integration/async-execution.test.ts`
- Streaming saved summaries: a fresh child with a $0.25 assistant turn and a disk-only $0.10 branch summary totals $0.35 with one turn; a fork excludes a parent's priced summary, retries/resume charge only newly appended summaries, and an event-plus-disk summary counts once. Interrupted attempts retain saved summary charges. Validate the prelaunch boundary across legacy migration, missing/truncated/malformed files, pin that removing only a disk-only summary raises no diagnostic and omits its charge, and preserve disabled-persistence behavior - `test/integration/async-execution.test.ts`, existing mock runner support in `test/support/mock-pi-script.mjs` and `test/support/mock-pi.ts`.
- E14: a dynamic fan-out followed by a static step ends with the fan-out children's usage in `totalTokens` and `totalCost` - `test/integration/async-execution.test.ts`
- E8, E9: malformed-file and trailing-line errors unchanged - none: the existing cases in `test/unit/execution-session-replay.test.ts` already assert them and stay in place.
- Session total: none: `src/extension/grand-total.ts` sums the values AC 1 and AC 6 assert and is not edited.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/observability.md` - "Execution reporting protocol" (communication contract: the host's final messages for an attempt are the result entry's `parentId` branch restricted to entries appended after that attempt's `ready` report; messages appended after `ready` off that branch reach the live feed only; a report positioned before the attempt's `ready` is inherited and does not claim its stream) and "Grand-total session cost" (major definition: a forked child contributes only its own turns and charges to the total, while that child's own footer shows the whole conversation; a background run's live total and the session total may exceed its completed status by the spend on turns the child abandoned by rewinding its tree; a branch summary saved without an event and then lost from the file is not counted and not reported); `CHANGELOG.md` - one `### Fixed` entry under `## [Unreleased]` (release convention). Bar: `reference/documentation-impact.md`.
- Derived / memory docs invalidated: none

## Out of scope

- Recording a fork point when the copy is made and carrying it through options, runner config, saved status and resume. Rejected: it covers forks only and adds a second boundary beside the `ready` report.
- The forked child's own pane footer total (`seedMainCostFromSession`). It reflects the whole conversation and never reaches the parent total.
- The content of the saved conversation, its export and its transcript link. They keep the inherited history.
- How a streaming child's messages are read. A streaming child never replays inherited turns (claim 8). Two things change for it, both in background runs: the completion totals, and the attempt usage counter, which adds non-assistant charges from `compaction_end` and `entry_appended` events plus attempt-owned saved branch summaries (Design "Attempt usage"). Foreground streaming usage is not changed; it never used the reread.
- Spend on turns a child abandoned by rewinding its tree. Those turns are off the final branch and stay out of the attempt's final usage, as for a fresh child today. The surfaces differ: live events still include those turns and the async session-cost latch keeps the maximum seen (`grand-total.ts:25-31`, `async-job-tracker.ts:224-228`), so a background run's live totals and the session total may exceed its completed status by that spend. A thrown attempt has no result and no final branch, so it counts every entry it owns (E10).
- The `cost:external` channel and its producers.
- A live model run in a real pane as verification.

## Open questions

- Whether the reported run used a pane backend is unknown (claim 12). It does not block: the reported shape (inherited turns counted as the child's) matches the pane reader, and the background completion change covers streaming children.
- Streaming branch-summary accounting is settled by the user's G1 fix-now disposition: reconcile newly saved summaries from the exact attempt file, without counting inherited history or event duplicates. Pi 1.5.0 emits no stdout event for `navigateTree`'s summary (`dist/core/agent-session.js:3279,3402-3433`; `dist/modes/print-mode.js:63`), so event-only accounting cannot satisfy this requirement.
