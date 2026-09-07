# Remove pi-intercom support; blocked children return `BLOCKED:` (gh-11)

Ticket: [jjuraszek/pi-cohort#11](https://github.com/jjuraszek/pi-cohort/issues/11). The ticket asks for conditional escalation ("work without pi-intercom when absent or `mode: off`"). Decision taken here: pi-intercom support is removed outright. pi-cohort is written as if pi-intercom does not exist - no detection, no `mode`, no compat shim, no legacy-config diagnostic.

## Problem

- Shipped personas (`agents/worker.md:22,50-53`, `agents/delegate.md:6,12`, `agents/oracle.md:18-20,41-42`, `agents/reviewer.md:76-78`, `agents/monitor.md:19,24,26`, `agents/scout.md:50`, `agents/planner.md:55`, `agents/context-builder.md:39,45`) require or reference live supervisor contact; decision-making personas forbid returning a question and mandate waiting. Without the bridge, the tool is unavailable. The instruction conflict is source-verified; the ticket explicitly says the no-intercom execution outcome was not reproduced in its audit. A plain question currently has no runtime blocked-result classification.
- Source-confirmed deadlock risk: the foreground tool waits for child completion (`execution.ts:249-343`), while pi-intercom 0.12.1 delivers supervisor traffic through `pi.sendMessage(..., { deliverAs: "steer" })` (`~/.pi/agent.balanced/npm/node_modules/pi-intercom/index.ts:1189`). The parent's blocked tool call prevents a normal decision turn. No `pi-intercom:detach-request` emitter exists in that installed package (`rg -n "detach-request|DETACH"` found nothing); its TypeScript `detach` matches are Node spawn options only. The event-driven escape is unavailable, but `execution.ts:653-656` can still detach on user abort during supervisor contact. Removing this integration removes both paths, not just unreachable code.
- Supporting observation, not a controlled reproduction: issue #11 audited retained local sessions from September 1-6, 2026, with pi-cohort 5.3.1 / pi-intercom 0.12.1. It counted 96 decision requests, two replies (both background children), and 91 ten-minute timeouts; the parent call remained in progress throughout each of those 91 waits. The ticket provides no counting script or classification for the other three requests and labels these local observations, not shared-environment or controlled benchmark results. The source-level circular wait, not this frequency estimate, motivates removal.
- pi-intercom is a third-party, pre-1.0 dependency. `rg -il "intercom|contact_supervisor"`: 21 source files, 20 test files, 8 personas, README, AGENTS.md, 5 docs, the skill - maintenance cost with no working foreground value.

## Design

### 1. Delete all intercom surface

| Surface | Location |
|---|---|
| Bridge module | `src/intercom/intercom-bridge.ts` deleted |
| Receipts module | `src/intercom/result-intercom.ts` deleted; its non-intercom functions move to `src/runs/shared/result-children.ts`: `resolveSubagentResultStatus` (drop the `detached` input), `attachNestedChildrenToResultChildren`, `compactNestedResultChildren`, and its private dependency `compactNestedRun`. The type `SubagentResultIntercomChild` stays in `types.ts:167`, renamed `SubagentResultChild`. Rename the existing shared `IntercomEventBus` (`types.ts:758`) to `SubagentEventBus`, retaining its `on`/`emit` shape and non-intercom callers in the result watcher, executor and chain execution; no new event abstraction. Everything else in the file (receipt building, `deliverSubagentIntercomMessageEvent`, target resolution) goes. `src/intercom/` directory removed. |
| Tests | `test/unit/intercom-bridge.test.ts`, `test/unit/result-intercom.test.ts`, `test/integration/intercom-result-delivery.test.ts` deleted |
| Config | Top-level `intercomBridge` in `<PI_CODING_AGENT_DIR>/extensions/pi-cohort/config.json`: `ExtensionConfig` and bridge config types in `src/shared/types.ts`, example at `src/extension/index.ts:12`, `doc/configuration.md#intercombridge`. There is no supported `settings.json#subagents.intercomBridge` key. |
| Channel | `"intercom"` member of `ControlNotificationChannel` (`types.ts:99`) and `CONTROL_NOTIFICATION_CHANNELS` (`subagent-control.ts:11`); `formatControlIntercomMessage` (`subagent-control.ts:270-286`); `childIntercomTarget` parameter dropped from `controlNotificationKey`, `claimControlNotification`, `formatControlNoticeMessage` (`subagent-control.ts:201-225`) - dedupe key becomes `runId[:index]:type:reason` for every caller (previously the intercom target when one existed; same identity in practice since the target was derived from `runId`/`index`). Callers that thread `childIntercomTarget`: `src/extension/control-notices.ts:11-54`, `src/runs/background/async-job-tracker.ts:89-106` (`SUBAGENT_CONTROL_INTERCOM_EVENT` emit, `record.intercom`, `channels.includes("intercom")`), `src/runs/background/subagent-runner.ts:1153` (`!== "intercom"` filter). A persisted `intercom` field on an in-flight control record is ignored. Delete the dead `nudgeCommand` and both `Nudge:` branches in `formatControlNoticeMessage`; keep status/interrupt guidance, not a permanent "no route" stub. |
| Detach state machine | `execution.ts`: `intercomStarted` + tool-name sniff (`:498`), `detachForIntercom` (`:255-267`) and its `finish(-2)` sentinel, `progress.status = "detached"`, `allowIntercomDetach`, `!result.detached` in the acceptance guard (`:1019`), `INTERCOM_DETACH_*` constants/events. `result.detached` / `detachedReason` fields and their guards in `subagent-executor.ts:255,279,716,1350,1947-1951,2242,2261`; parallel/dynamic/sequential detached branches in `chain-execution.ts:693-707,900-914,1145-1150`. In branches shared with `interrupted`, remove only the detached operand; interrupt behavior stays. The `"detached"` member of `WorkflowNodeStatus` (`types.ts:33`), `SubagentResultStatus` (`types.ts:149`), progress status unions (`types.ts:204`, `chain-execution.ts:85`, `subagent-runner.ts:1091`), `workflow-graph.ts:27-67`, `render.ts:576-1267`. Exit code `-2` no longer exists. Node's `spawn({ detached: true })` in `async-execution.ts` is unrelated and stays. |
| Result fields | `intercomTarget`, `ownerIntercomTarget`, `leafIntercomTarget`, receipt fields on result/status types; writers in `async-execution.ts`, `subagent-runner.ts`, `async-resume.ts`, `run-status.ts:228`, `nested-events.ts:241-243` |
| Env plumbing | `PI_SUBAGENT_INTERCOM_SESSION_NAME`, `SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET"` (`pi-args.ts:14,200-204`), the child/orchestrator intercom options on `pi-args`; `subagent-prompt-runtime.ts:203-206` including the `pi.setSessionName()` call - child sessions no longer get a name (it existed only for intercom addressing). |
| Doctor | `DoctorDeps.diagnoseIntercomBridge` (`doctor.ts:27`), `DEFAULT_DEPS` entry (`:52-56`), `DoctorReportInput.orchestratorTarget` (`:38`), diagnostic formatter (`:189-203`), report section (`:225-232`); doctor help text `index.ts:450` |
| Live-child follow-up | Replace only the two `kind: "live"` return sites in `async-resume.ts` (the selected-child-running branches) with an error identifying the selected child: "Selected child is still active; wait for completion, then resume." Remove the corresponding live route in `subagent-executor.ts:590-608` and the live-resume action in `fanout-child.ts:89-99`; retain nested interrupt. Gate on the selected child, never the enclosing run: a completed/failed/paused child's existing `kind: "revive"` route remains available while a sibling is still running. Apply the same selected-child rule to nested resume. |
| Async result-watcher | intercom delivery tail only (`result-watcher.ts:175-182`, the `data.intercomTarget` block). `normalizedChildren` (`:142-174`) feeds `SUBAGENT_ASYNC_COMPLETE_EVENT` (`:186-203`) and stays. |
| Tools | `intercom`, `contact_supervisor` removed from `READ_ONLY_BUILTIN_TOOLS` (`completion-guard.ts:57-65`) and from every persona `tools:` line |

Existing config: `intercomBridge` in the extension's `config.json` becomes an unknown key and is ignored. `notifyChannels: ["intercom"]` filters to empty in `parseControlList` (`subagent-control.ts:31-37`), which returns `undefined` and falls back to the default `["event", "async"]` - a user who had scoped notices to intercom-only starts receiving event/async notices. Persisted `.async` status/result files with intercom fields keep parsing (readers spread unknown fields). No migration, no diagnostic.

Async spawning (including Node `detached: true`), filesystem watch/poll completion delivery, status, interrupt, finished-session revival, nested-result aggregation, and sequential/parallel/dynamic execution remain. Foreground control notices keep their #7 invariant (steer while non-idle, append while idle) - their producers are the `event`/`async` channels, which stay.

### 2. `BLOCKED:` result contract

Personas replace the `contact_supervisor` mandate with one rule (exact wording lives in each persona body; the runtime relies on the contract below):

> If you hit a decision that was not approved and is required to continue safely, stop. The first characters of your reply must be the plain text `BLOCKED:` followed by the decision needed, then `Done:` (what is complete) and `Remaining:` (what is left). No heading, bold, list marker, or code fence around the marker. Do not guess, do not wait for a reply.

Grammar: `BLOCKED:` case-sensitive, at column 0 of the first line whose `trim()` is non-empty, in the child's stripped output (`stripAcceptanceReport(getFinalOutput(messages))`) - never the file-only reference message. A marker anywhere else is prose.

Detection: one helper in `src/runs/shared/completion-guard.ts`:

```ts
export function blockedLine(output: string): string | undefined {
	const line = output.split("\n").find((l) => l.trim() !== "");
	return line?.startsWith("BLOCKED:") ? line : undefined;
}
```

Both runners classify an otherwise clean, non-interrupted child after existing process/hidden-error detection but BEFORE `readStructuredOutput` and `evaluateCompletionMutationGuard`:

- Foreground `execution.ts`: compute stripped output before the structured-output block (~725), reusing it for later output handling. A detected marker sets `exitCode=1`, `error` to the FULL stripped response (decision + `Done:` + `Remaining:`), and failed progress/error. Existing failure guards skip structured-output and mutation checks.
- Background `subagent-runner.ts`: detect from the stripped child response after `hiddenError` (~698), before the structured-output block. Gate structured-output and mutation checks on no blocker; feed `effectiveExitCode=1` and the FULL stripped response into the existing error/result path. Keep the interrupted and existing-error paths unchanged.
- Stop model fallback on a blocker in BOTH loops, before `isRetryableModelFailure` (`execution.ts:937-940`, `subagent-runner.ts:750-751`). Use the existing output/error plus the helper, or the attempt-local match; no new public status or persisted flag. Words such as "api key", "forbidden", or "timeout" in a decision request must not launch another model attempt. Normal model failures retain existing fallback behavior.

Consequences, no new state:

- `BLOCKED:` wins over missing/invalid structured output and the mutation guard. A child that stops before writing edits or schema output reports its actual decision request, not a generic validation failure.
- The acceptance-failure blocks (`execution.ts:1012-1026`, `subagent-runner.ts:784-790`) are gated on `exitCode === 0` and do not fire; the acceptance ledger is still recorded on the result, its failure text is not appended to `error`. Blocked is the run's failure reason; do not change the acceptance schema.
- `exitCode=1` is what the foreground sequential chain loop (`chain-execution.ts:1149-1170`) and the background loops (`subagent-runner.ts:1648,1917,2143`) already test to stop; parallel/dynamic groups fail the step and keep sibling results exactly as for any nonzero child today. Async delivery via `event`/`async` reports failure with the full blocked response. Foreground single and sequential-chain tool `content`, not merely UI `details`, must carry the decision, `Done:` and `Remaining:`.
- Follow-up after a block is a fresh dispatch once the parent/human decides - the existing model.
- Only shipped personas carry the rule (the bridge used to inject its instructions into any agent). Custom personas author their own stop wording; the runtime check applies to all of them regardless.

### 3. Personas (8)

| File | Edit |
|---|---|
| `worker.md` | `:22`, `:50-53` -> the `BLOCKED:` rule; `contact_supervisor` off `tools:` |
| `delegate.md` | `:12` -> the `BLOCKED:` rule; `contact_supervisor` off `tools:` (`:6`) |
| `oracle.md` | `:18-20`, `:41-42` -> the `BLOCKED:` rule; `intercom` off `tools:` |
| `reviewer.md` | "Supervisor coordination" (`:76-78`) -> the `BLOCKED:` rule (reviewer stays no-edit-wins); `intercom` off `tools:` |
| `scout.md`, `planner.md` | `:50` / `:55` escalation paragraph -> the `BLOCKED:` rule; `intercom` off `tools:` |
| `context-builder.md` | `:39` drop "ask via `intercom`"; `:45` -> the `BLOCKED:` rule; `intercom` off `tools:` |
| `monitor.md` | `:19` delete (live progress ping); `:24` stall -> record in the trail only; `:26` drop the "Without contact_supervisor" clause. The `BLOCKED:` rule does not apply - a monitor makes no decisions; its trail + final summary are the record. `skills/pi-cohort/SKILL.md:365` ("Live 15m reports require the pi-intercom bridge") and `test/unit/monitor-persona.test.ts:80` follow. |

## Out of scope

- Any in-repo replacement for async parent<->child messaging. If wanted later it is a separate spec.
- Async policy, pi-gauntlet gates, any `resume` change beyond removing the live route.
- `doc/specs/*` and `doc/plans/*` history mentioning intercom - records, not contracts.
- Any behavior for users still carrying `intercomBridge` in settings beyond silent ignore.

## Testing

- Delete the three intercom test files; strip intercom/`contact_supervisor` cases from the 19 tests: `pi-args`, `subagent-prompt-runtime`, `pi-coding-agent-dir`, `subagent-control`, `agent-overrides` (comment), `agent-frontmatter` (`:406` asserts `contact_supervisor` in worker/delegate tools), `monitor-persona`, `run-status`, `async-resume`, `nested-control`, `doctor`, `doctor-executor`, `async-job-tracker`, `async-execution`, `result-watcher`, `fork-context-execution`, `parallel-execution`, `chain-execution`, `single-execution`. Remaining `event`/`async` coverage stays; `result-watcher` tests must still assert `normalizedChildren` reaches `SUBAGENT_ASYNC_COMPLETE_EVENT`.
- `subagent-control.test.ts`: defaults/validation assert `["event", "async"]`; an arbitrary unknown channel (not a removed-product-specific fixture) resolves to the default. Notices contain no `Nudge:` line and retain status/interrupt guidance.
- New `completion-guard` unit: `blockedLine` - leading blank lines skipped; ` BLOCKED:` (indented), `blocked:`, `**BLOCKED:**`, `## BLOCKED:`, and a marker on a later non-empty line return `undefined`. Formatting tolerance is deliberately not added; an otherwise successful response with a decorated marker remains prose.
- Foreground single and sequential-chain: `BLOCKED: need X\nDone: ...\nRemaining: ...` yields `exitCode=1`, full stripped response in `error` AND parent-visible tool `content`, mutation guard not triggered. Cover `outputMode: "file-only"` without losing the handoff.
- Foreground and background: with structured output configured, a blocked child that produces no schema file surfaces its full blocker, not "structured output missing". Existing non-blocked schema validation stays covered.
- Foreground and background: configure a fallback candidate; the first attempt returns `BLOCKED: need approval to rotate the api key`. Assert exactly one attempt, no fallback note, failed status and full blocked handoff. Retain existing retryable model-failure tests.
- Foreground and background chains: blocked step 1 prevents dependent step 2. In standalone foreground parallel execution, assert blocked and successful sibling outcomes in `content`; in a chain parallel step, assert the blocker in `content` and both outcomes in `details.results` (existing visibility, no new formatting machinery). Background parallel/dynamic results retain sibling records and report failure through normal async delivery.
- Must retain `test/unit/async-resume.test.ts` case "revives a completed child by index while a sibling async child is still running" (~179-199), finished/failed/paused revival and nested interrupt coverage. Selected-running-child resume errors; sibling activity never blocks an eligible revival.
- Keep non-intercom result-child helper tests when moving helpers, plus async spawn/watch/poll/status/interrupt/delivery and foreground control-notice ordering coverage. Exercise normal and blocked foreground single/parallel/chain paths in fresh and fork contexts, requested artifacts, and a fresh foreground follow-up that resolves the block.
- Gate: `env -u PI_CODING_AGENT_DIR npm run test:all`; `rg -i "intercom|contact_supervisor" src agents skills doc/*.md README.md AGENTS.md test` returns nothing. Audit `rg -n '\bdetach' src test` separately: no removed lifecycle fields, sentinels or branches may remain; allow only unrelated Node background-process detachment and its tests. Type-stripping is not static type checking, so stale field reads need this audit.

## Release

Breaking for anyone using `intercomBridge` or `notifyChannels: ["intercom"]` - major bump (`5.3.1` -> `6.0.0`) per the release skill's propose step. CHANGELOG entry under Removed + Changed (`BLOCKED:` contract, selected-running-child `resume` unsupported; eligible sibling revival retained). Foreground abort no longer leaves a child alive for supervisor coordination; it uses normal child termination. Publishing/version changes are not part of this spec-revision step. pi-gauntlet has no code coupling to the bridge; its docs referencing `contact_supervisor` (if any) are checked in the ship phase and fixed in a sibling commit, not here.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (drop pi-intercom companion link), `AGENTS.md` (intro line: drop "intercom-coordinated multi-agent workflows"), `doc/configuration.md` (drop `intercomBridge`), `doc/skills-and-companions.md` (drop optional companion section, escalation examples -> `BLOCKED:`), `doc/observability.md` (drop intercom events/payload claims), `doc/orchestration-patterns.md:78` (drop receipt early-return branch), `doc/programmatic-api.md:217-219` (drop doctor/resume intercom claims; live resume now errors), `skills/pi-cohort/SKILL.md` (drop coordination sections and `:365`; document the `BLOCKED:` stop contract), `skills/pi-cohort/reference/config-fields.md` (`notifyChannels` = event/async), `CHANGELOG.md`
- Derived / memory docs invalidated: `doc/skills-and-companions.md` companion table

## Open questions

None.
