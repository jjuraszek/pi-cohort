# Handoff brief template

The fixed contract `/handoff` emits and a consumer (pi-gauntlet's resume flow, or a human pasting into a fresh session) parses. Section names and order are fixed; a consumer keys on headings, never on prose.

```markdown
# Handoff: <one line>
## Intent
## Repo state
## Decisions
## Open questions
## Skills loaded
## Process state
```

| Section | Content | Presence |
|---|---|---|
| `## Intent` | what the work is for, in the producer's words | always |
| `## Repo state` | one field per line: `toplevel`, `worktree: yes <path>` or `worktree: no`, `branch` (`detached` when none), `HEAD`, `base`, `dirty: <git status --porcelain>` or `dirty: clean`, `diff-stat`, `test cmd`; when `worktree: yes <path>` every field describes that worktree (the path is absolute); when `worktree: no` the fields describe the primary checkout at the session cwd; `base: unknown` when no remote resolves (then `diff-stat: unavailable`); any field `unavailable` when its command failed; `## Repo state: not a git repo` when so | always |
| `## Decisions` | bullets; rejected alternatives marked `rejected:` | always |
| `## Open questions` | bullets | always |
| `## Skills loaded` | frontmatter `name` of every skill whose SKILL.md body is in the producer's context (a `<skill>` block or a tool result on a `*/SKILL.md` path); `## Skills loaded: none` when there are none | always |
| `## Process state` | `phase_tracker status` and `plan_tracker status` output verbatim (both tracker tools must exist; one tracker or all phases pending -> section omitted); `Active task: <task name>` (`none` when no plan or no active task); the line `Gate history not restored - re-validate before advancing.` | only when both tracker tools exist and a phase is `in_progress` |

A run-worktree candidate the producer named but the scout rejected (its `open-question` line) appears as an `## Open questions` bullet naming the path; the grammar of `## Repo state` does not change.

## Consumer rules

- `## Process state` absent -> plain handoff. Start your own process from `## Intent`; nothing is restored.
- `## Process state` present with `No plan active.` -> phase-only state. Restore no plan.
- `## Skills loaded` names skills; loading them is the consumer's job.
- How a gauntlet flow re-enters from this brief is pi-gauntlet's design (pi-gauntlet#31), not this template's.
