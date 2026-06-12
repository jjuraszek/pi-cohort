# pi-subagents (jjuraszek fork)

Pi extension. Lets Pi delegate work to focused child agents: code review, scouting, implementation, parallel audits, saved chains, background/async jobs, intercom-coordinated multi-agent workflows.

This repo **originated as a fork of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** but **no longer tracks upstream** — it is a standalone semver project with no upstream remote, rebase, or `-jj.<n>` suffix. It is consumed by Pi via git **tag** pins, not npm. See [Release model](#release-model).

## Communication Style

Same rules as the parent `~/.pi/agent*/AGENTS.md`. Applies to chat, commit messages, PR descriptions, code review, any artifact authored here.

- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `CHANGELOG.md`, skill bodies, agent personas, spec docs, code comments where the *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers — validate at the boundary once.
- **Delete dead code, don't comment it out.** Branch from the deletion commit if reversibility matters.
- **Comments only when the *why* is non-obvious.** No docstrings on self-evident params/returns. No banner/separator comments. Don't reference the current task or PR — that belongs in the commit message.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.

## Release model

Consumed via **git tag pins** in pi `settings.json`, e.g.
`"git:github.com/jjuraszek/pi-subagents@v0.27.0"`. There is **no npm publish**
in the loop — do not run `npm publish`. There is **no upstream remote**: this is
a standalone repo, released with plain semver.

### Tag scheme

`v<major>.<minor>.<patch>` — plain semver. `package.json` `version` mirrors the
tag without the leading `v` (`0.27.0`).

### Running a release

Use the `release` skill (`.agents/skills/release/scripts/release.sh`):

```bash
bash .agents/skills/release/scripts/release.sh minor      # X.Y.Z -> X.Y+1.0
bash .agents/skills/release/scripts/release.sh patch      # X.Y.Z -> X.Y.Z+1
bash .agents/skills/release/scripts/release.sh major      # X.Y.Z -> X+1.0.0
bash .agents/skills/release/scripts/release.sh current    # tag package.json as-is
bash .agents/skills/release/scripts/release.sh --dry-run minor
```

The script bumps `package.json`, commits `Release <version>`, creates+pushes the
`v<version>` tag to `origin`, then rewrites every `~/.pi/agent*/settings.json`
pin of `git:github.com/jjuraszek/pi-subagents@<ref>` to the new tag. Consuming
project repos (e.g. a repo's own `.pi/settings.json`) are **not** touched — bump
those pins by hand. See the skill for flags (`--dry-run`, `--no-update-pins`)
and failure handling.

## Behaviors we own

Divergences from the fork origin that are now part of this codebase:

| Behavior | Where |
|---|---|
| `agentOverrides` applied to user/project custom agents | `src/agents/agents.ts` |
| flat discovery + explicit precedence + skip `SKILL.md` | `src/agents/agents.ts` |
| `toolsPrepend` / `toolsAppend` additive override fields | `src/agents/agents.ts` |

Flat discovery is the single source of truth for persona precedence. It lives in `resolveUserAgentDirs()` / `preferredUserAgentDir()` (`src/agents/agents.ts`) plus the `listFilesFlat` / `isAgentFileName` / `isChainFileName` helpers. Precedence (lowest→highest): `builtin < ~/.agents < <PI_CODING_AGENT_DIR>/agents < <repo>/.agents < <repo>/.pi/agents`. Reads are flat (top-level only); `SKILL.md` and `*.chain.md` are never agents. `PI_CODING_AGENT_DIR` relocates the pi profile root but is **not** a discovery sandbox.

## Testing

- `npm run test:unit` (node `--test` with type-stripping), `npm run test:integration`, `npm run test:all`.
- **Unit tests that exercise user-scope discovery set `HOME`/`USERPROFILE` to a temp dir.** A configured `PI_CODING_AGENT_DIR` (present in any real pi harness shell) overrides `HOME` and makes ~17 user-scope tests fail spuriously. Run with it cleared:

  ```bash
  env -u PI_CODING_AGENT_DIR npm run test:unit
  ```

- No `tsc` ships in this repo; type-stripping at test time is the typecheck.

## Routing

| Want to … | Read |
|---|---|
| Install, configure, slash commands, agent/chain authoring | [`README.md`](README.md) |
| What changed across versions | [`CHANGELOG.md`](CHANGELOG.md) |
| Agent/chain discovery, overrides, scopes | `src/agents/agents.ts` |
| Run a release | `.agents/skills/release/SKILL.md` |
| Implementation of a runtime behavior | the matching `src/**/*.ts` directly |
