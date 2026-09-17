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

## Run worktree

Before the snapshot dispatch, determine the run worktree from your own transcript and interpolate it into the scout task as `Run worktree: <abs path>` or `Run worktree: none`:

- A flow-level worktree the run created (any `git worktree add <path>` you ran, or a `Worktree ready at <path>` report from `/skill:using-git-worktrees`) or was told to work in (a resume brief's `worktree: yes <path>`, or a user instruction).
- Never inferred from the session cwd; a created or assigned worktree still qualifies when it happens to equal the cwd. Never a per-task worktree from `tasks[].worktree: true` or `worktree: true` dispatches - those are ephemeral.
- Two flow-level worktrees in the transcript: the candidate is the one most recently used by later work (a dispatch `cwd`, a `git -C <path>`, or a `cd <path>`); if that does not distinguish them, the most recent creation or assignment. The other goes into `## Open questions` as `Also seen: <path> - not recorded as the run worktree`.
- No flow-level worktree created or named: `Run worktree: none`.

After the scout returns, copy any `open-question:` line from `repo.md` into `## Open questions` without the `open-question:` prefix; it never appears in `## Repo state`.

## Repo snapshot

```
subagent({ async: false, context: "fresh", tasks: [
  { agent: "scout", cwd: "<cwd>", reads: false, output: "<DIR>/repo.md",
    task: "Read-only; write only to your output path. Run worktree: <abs path|none>. Steps: (1) linked set: git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' - the first line is the primary checkout, the rest are the linked worktrees; a relative candidate resolves against the primary toplevel, not cwd. (2) candidate `none` or line absent -> target is cwd, go to (4). Otherwise if the candidate is relative, prefix it with the primary toplevel (first linked-set line) first; C=$(git -C <candidate> rev-parse --show-toplevel); valid when that succeeds and C equals one of the linked lines exactly (a line after the first; equality with the first, primary line is invalid); anything else (failure, not listed, the primary itself, prunable) is invalid -> target is cwd and emit the open-question line in (5). (3) valid -> target is $C and `worktree: yes $C`. (4) target cwd -> T=$(git rev-parse --show-toplevel); `worktree: yes $T` when $T equals one of the linked lines exactly (a line after the first; the first, primary line gives `worktree: no`), else `worktree: no`. (5) report each field on its own line, `unavailable` when a command fails, every git command as `git -C <target>`: toplevel (git -C <target> rev-parse --show-toplevel); the worktree line from (3) or (4); branch (git -C <target> branch --show-current, `detached` when empty); HEAD SHA; base (origin/HEAD short name, else origin/main or origin/master if present, else `base: unknown`); dirty (git -C <target> status --porcelain, or `clean`); diff-stat (git -C <target> diff --stat <base>...HEAD; `diff-stat: unavailable` when base is unknown); test command (<target>/package.json scripts or <target>/AGENTS.md). Invalid candidate: after the fields add the single line `open-question: producer named <candidate as submitted> as the run worktree; it is not a linked worktree of this repo`. cwd not a git repo -> the single line `not a git repo`, plus the same open-question line if a candidate was submitted." }
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