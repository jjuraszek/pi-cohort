---
description: "Use when the context window is nearly full and the work must continue in a fresh session."
---

Write a handoff brief for a fresh session. The template is the contract in `doc/handoff-template.md` of pi-cohort; section names are fixed.

Optional `--out <path>` (relative resolves against cwd):

$@

## Rules

- `DIR=$(mktemp -d)`. The dispatch: `async: false` and `context: "fresh"` at the top level; `reads: false`; absolute `output` under `$DIR`. If it returns an async handle, a `forceTopLevelAsync` setting is active: stop and report it. Do not poll, relaunch, or continue.
- The child is read-only against the repository; its only write is its `output` file.
- You write `## Intent`, `## Decisions`, `## Open questions`, and `## Skills loaded` from your own transcript, before the call and after it returns. Do not fork a child for this: forking a near-full transcript is the cost this handoff avoids.
- Write nothing into the repository; the brief goes to `--out` or `$DIR/handoff.md`.

## Repo snapshot

```
subagent({ async: false, context: "fresh", tasks: [
  { agent: "scout", cwd: "<cwd>", reads: false, output: "<DIR>/repo.md",
    task: "Read-only; write only to your output path. Report each field on its own line, `unavailable` when a command fails: toplevel (git rev-parse --show-toplevel); `worktree: yes <path>` when git rev-parse --git-dir and --git-common-dir differ, else `worktree: no`; branch (git branch --show-current, `detached` when empty); HEAD SHA; base (origin/HEAD short name, else origin/main or origin/master if present, else `base: unknown`); dirty (git status --porcelain, or `clean`); diff-stat (git diff --stat <base>...HEAD; `diff-stat: unavailable` when base is unknown); test command (package.json scripts or AGENTS.md). Not a git repo -> the single line `not a git repo`." }
]})
```

## Process state

Include `## Process state` only when both `phase_tracker` and `plan_tracker` tools exist AND `phase_tracker status` shows a phase `in_progress`. Then: `phase_tracker status` and `plan_tracker status` outputs verbatim; `Active task: <task name>` (the task you are working on; `none` when no plan is active or no task is active); the line `Gate history not restored - re-validate before advancing.`. Tools absent, all phases pending, or hotfix flow -> omit the section.

## Brief

```markdown
# Handoff: <one line>
## Intent
## Repo state          (the snapshot fields; `## Repo state: not a git repo` when so)
## Decisions           (bullets; rejected alternatives marked `rejected:`)
## Open questions
## Skills loaded       (frontmatter `name` of every skill whose SKILL.md body is in context - a `<skill>` block or a tool result on a `*/SKILL.md` path; `## Skills loaded: none` when there are none)
## Process state       (only per the rule above)
```

Write it, print the path and the brief.