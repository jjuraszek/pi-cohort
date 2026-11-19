---
name: investigate
description: Use when a request's premises are unverified, the territory is unknown, or the user asks to look into something before planning or brainstorming.
---

# Investigate

## 1. Identify the request

Use the argument text following the skill block as the request. When you loaded the skill yourself, use the user message that led to the load. Read a file as the request only when the entire argument text is one path to an existing file. Treat everything else as request text, not options.

Resolve these stops before creating a folder:

| Condition | Action |
|---|---|
| The user message consists only of the skill block, with no trailing request text. | Stop and ask for the request. |
| You loaded the skill on a request that does not ask for an investigation. | Confirm with the user before proceeding. A request to investigate authorizes both read-only waves. |
| The session has no `subagent` tool. | Stop and say that investigation needs a session with the dispatch tool. |

## 2. Set up one temp folder for both waves

Resolve `git rev-parse --show-toplevel` and `${TMPDIR:-/tmp}` to physical absolute paths. Before creating anything, check whether the temp base is the repository root or a descendant of it. On a match, stop and name the base. Export the checked base as `TMPDIR` and run `DIR=$(mktemp -d)` in that shell. On a lookup or creation error, print the error and stop.

Keep every investigation file under `$DIR`: child outputs, child session storage and `$DIR/brief.md`. Write nothing into the repository. Keep the directory after the report so follow-up questions can use the brief and child outputs.

- On every dispatch set `async: false`, `context: "fresh"`, `artifacts: false`, `sessionDir: "<DIR>/sessions"` and `cwd` (the repository root) at the top level. Expand paths to absolute values in tool arguments.
- Set `reads: false` and an absolute `output` under `$DIR` on every task. Prefix each task text with `Read-only against the repository; write only to your output path.`
- Look up answers available in code, docs or the tracker instead of asking the user. Reject verification tasks that would run, build or validate a proposed change: investigate current behavior only.

| Dispatch result in either wave | Action |
|---|---|
| Async handle (`forceTopLevelAsync` is active) | Stop and report the setting. Do not poll, relaunch or print a report. |
| Call failed with no child results | Keep the evidence gathered. Name the work that did not run and the reason in the brief; mark it unchecked, never verified. |
| Child errored or left its output empty | Write `<agent> failed: <reason>` in its section and continue the brief. |

## 3. Gather the evidence (wave 1)

Detect refs in the request: `http(s)://` URLs, `owner/repo#N`, bare `#N` when `git remote get-url origin` is a GitHub URL, and ticket IDs matching `[A-Z][A-Z0-9]+-\d+`. Make one parallel call with the following tasks; include `context-builder` only when you detected refs. Give every task the request and the read-only prefix from step 2.

| Agent | Output | Task text |
|---|---|---|
| `scout` | `$DIR/scout.md` | Map the relevant files and line ranges, patterns and conventions a change must match, test conventions and integration points. Check whether the codebase or ecosystem already solves this. Cite paths. |
| `reviewer` | `$DIR/premise.md` | Classify each claim the request makes or assumes as Confirmed (cite code), Contradicted (cite code), or Unverified (asserted, not shown). Judge whether the request as framed fits the codebase's recorded design decisions, conventions and idiom. End with a `Design fit:` block: one `- clash: <what the request asks or assumes> - <the decision, convention, or idiom it goes against> (<path>:<line>)` per clash, or the single line `no conflict found - checked <what was read>`. Name the actual sources. No design proposals. |
| `context-builder` | `$DIR/external.md` | Read the supplied refs (one per line). For each, report acceptance criteria, hard constraints, linked discussion that changes scope and contradictions with the request. Record `unreadable: <ref>` for a ref you cannot read and continue. Return only the context handoff; do not write a meta-prompt file. |

Use the reviewer's verdict in `## Design fit` only for a block consisting entirely of cited clash lines or the single clean line naming sources actually checked. For a failed review or a missing, malformed or unsupported verdict, write `not assessed - <reason>` instead. Keep every valid premise line in `## Premise check` regardless.

## 4. Draft the brief

Read the child outputs. Fill the template with the evidence gathered:

```markdown
# Investigation: <slug>
## Request
<the request>
## Findings
<cited findings; put wave 2 results under ### Verified>
## External context
<only when context-builder ran; list unreadable refs>
## Premise check
<Confirmed / Contradicted / Unverified: one line per claim, with evidence>
## Design fit
<cited clash lines, the clean verdict naming what was checked, or not assessed - reason>
## Open questions
<numbered; end each with Recommendation: <answer> - <why>>
## Verification tasks
<numbered independent checks of current behavior; give each a one-paragraph read-only task and Expected: <result>>
## Next steps
<suggestions only; no implementation task decomposition>
```

## 5. Verify and write

Run wave 2 immediately, without a human gate. Send one parallel call with one task per verification task, using `scout` by default and `reviewer` for a judgment. Give each a distinct output under `$DIR`. Fold successful checks into `## Findings` under `### Verified`; skip the wave and omit that subheading when there are no verification tasks.

Write `$DIR/brief.md` and read it back. On a write or read-back failure, print the error and stop without a `Full investigation:` line.

## 6. Report

Read [the report rules](reference/report.md) now and print only the report they define, never the brief itself. On a reference read error, print the error and end with `Full investigation: <absolute path to the brief just read back>`.
