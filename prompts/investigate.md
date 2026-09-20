---
description: "Use when a request's premises are unverified, the territory is unknown, or the user asks to look into something before planning or brainstorming."
---

Investigate the request below with parallel read-only personas, then write a brief the user can paste into a fresh session or hand to brainstorming.

Request (text, or a path to a file holding it; optional trailing `--out <path>`):

$@

## Rules

- Empty request -> stop and ask for it. A path that does not exist is request text.
- `DIR=$(mktemp -d)`. Every dispatch: `async: false` and `context: "fresh"` at the top level (never inside a task object); `cwd` = `git rev-parse --show-toplevel`; every task `reads: false` and an absolute `output` under `$DIR`. Interpolate shell variables into the call as absolute paths.
- If a dispatch returns an async handle, a `forceTopLevelAsync` setting is active: stop and report it. Do not poll, relaunch, or continue.
- Every child is read-only against the repository; its only write is its `output` file. Say so in every task text. `reads: false` is mandatory: persona `defaultReads` name chain files that do not exist here.
- Write nothing into the repository. The brief goes to `--out` if given (relative resolves against cwd), else `$DIR/brief.md`.
- A question whose answer is in code, docs, or the tracker is not asked; it is looked up in wave 1 or wave 2.
- A verification task that would run, build, or validate the proposed change is rejected at brief-writing time. Wave 2 exercises the system as it is today.
- No human gate between waves: the request is the approval for the whole investigation, and every wave is read-only.

## Wave 1

Detect refs in the request: `http(s)://` URLs; `owner/repo#N`; bare `#N` when `git remote get-url origin` is a GitHub URL; `[A-Z][A-Z0-9]+-\d+`.

One call, shape `subagent({ async: false, context: "fresh", tasks: [...] })`:

```
subagent({ async: false, context: "fresh", tasks: [
  { agent: "scout", cwd: "<root>", reads: false, output: "<DIR>/scout.md",
    task: "Read-only recon; write only to your output path. Request: <request>. Map the territory: files with line ranges, patterns and conventions a change must match, test conventions, integration points, and whether the codebase or ecosystem already solves this. Cite paths." },
  { agent: "reviewer", cwd: "<root>", reads: false, output: "<DIR>/premise.md",
    task: "Read-only premise critique; do not edit any file, write only to your output path. Request: <request>. For each claim the request makes or assumes, classify: Confirmed (cite code), Contradicted (cite code), or Unverified (asserted, not shown). No design proposals." },
  // only when refs were detected:
  { agent: "context-builder", cwd: "<root>", reads: false, output: "<DIR>/external.md",
    task: "Read-only; write only to your output path, context handoff only (no meta-prompt file). Request: <request>. Refs: <one per line>. For each: acceptance criteria, hard constraints, linked discussion that changes scope, contradictions with the request. A ref you cannot read -> `unreadable: <ref>` and continue." }
]})
```

A task that errored or left its output empty -> its section reads `<agent> failed: <reason>`. The brief is still written.

## Brief

Read the outputs and draft, section names fixed:

```markdown
# Investigation: <slug>
## Request
## Findings            (cited; `### Verified` holds wave 2 results)
## External context    (only when context-builder ran; unreadable refs listed)
## Premise check       (Confirmed / Contradicted / Unverified - one line each, cited)
## Open questions      (numbered; each ends with `Recommendation: <answer> - <why>`)
## Verification tasks  (numbered; independent; each: one-paragraph read-only subagent task + `Expected:`; current behaviour only)
## Next steps          (suggestions only; no implementation task decomposition)
```

## Wave 2

Runs immediately after the draft; no ask. One call `subagent({ async: false, context: "fresh", tasks })`, one task per verification task, `scout` by default or `reviewer` when judgement is needed, each task text containing the phrase "read-only", `reads: false`, absolute `output` under `$DIR`. No verification tasks -> skip the wave and omit `### Verified`. Fold results into `## Findings` under `### Verified`, write the brief, and print the path and the brief once.