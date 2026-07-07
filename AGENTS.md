# pi-cohort (jjuraszek fork)

Pi extension. Lets Pi delegate work to focused child agents: code review, scouting, implementation, parallel audits, saved chains, background/async jobs, intercom-coordinated multi-agent workflows.

This repo **originated as a fork of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** but **no longer tracks upstream** - it is a standalone semver project with no upstream remote. It is published to npm and installed with `pi install npm:pi-cohort`. See [Release model](#release-model).

<!-- agents-core:begin v1 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Communication Style

Same rules as the parent `~/.pi/agent*/AGENTS.md`. Applies to chat, commit messages, PR/issue comments, code review, and any artifact authored in this repo.

- **Human, terse, but sharp and precise.** Applies everywhere: interactive session, issue/PR comments, `.md` files. Terse is not vague - keep it exact.
- **Suppress process narration.** No intent classification, phase announcements, tool/subagent preamble, status updates, pleasantries. Start with substance.
- **Output instead:** outcomes, decisions needing input, verification results, blockers.
- **Bullets over prose. Short paragraphs.** No wall-of-text, no tutorial tone unless asked.
- **Show an example when it clarifies a complex point** - a small before/after or a concrete ref beats a paragraph. Examples disambiguate, they don't pad.
- **End on the ask, not a summary.** Diffs/outputs speak for themselves.
- **Match the recipient's register** in human-facing artifacts (issues, PRs, chat).
- **Prefer ASCII.** `-` not em/en-dashes, `...` not the ellipsis glyph, straight quotes. Non-ASCII only for a justified visual mark.

LLM-readable artifacts (`AGENTS.md`, `README.md`, `CHANGELOG.md`, skill bodies, agent personas, spec docs, code comments where the *why* is non-obvious) stay structured: tables, headings, explicit field references, code blocks. Optimize for retrieval over readability.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **Docs are a contract.** Dense, current, no preamble. If a sentence doesn't help a future reader act, cut it - this applies to documentation as much as code.
- **No belt-and-suspenders.** Don't validate / null-check / guard the same thing at multiple layers - validate at the boundary once.
- **Delete dead code, don't comment it out.** Branch from the deletion commit if reversibility matters.
- **Comments only when the *why* is non-obvious.** No docstrings on self-evident params/returns. No banner/separator comments. Don't reference the current task or PR - that belongs in the commit message.
- **Markdown tables use compact `|---|` separators.** Never padded columns.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.

## Ticket convention

Every GitHub issue follows **Context -> Problem -> Idea (how to address) -> Acceptance Criteria**, then the idea is **roasted by 2 subagents and the consolidated roast is posted as a comment** before the issue is ready. A roast that kills or shrinks the idea is a success - file only what survives.

## Ground Truth Before Reasoning

Never guess Pi's API, message shapes, config, or values - read the source; the source wins; if it is missing, say so and ask, don't fabricate. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner` - treat its shipped `.d.ts` as API truth. Repo-specific source pointers, if any, follow.

<!-- agents-core:end v1 -->

## Part of one platform (cross-repo synergy)

This repo is one of four sibling pi extensions - **pi-quiver** (capabilities),
**pi-cohort** (coordination), **pi-condense** (context economy), **pi-gauntlet**
(process) - that compose into one governed agent workflow. They ship and version
independently, but documentation is deliberately cross-referential: a concept is
explained in its owning repo and *linked* from the others, never duplicated.

- Only hard runtime dependency: pi-gauntlet -> pi-cohort (`subagent()`). Not an
  npm/peer dependency - pinned in pi-gauntlet's README and its consumers'
  `settings.json#packages`.
- Real runtime coupling: pi-condense emits `cost:external`; pi-cohort aggregates
  it into `Σ$` (see `doc/observability.md`). Naming is one-directional -
  pi-condense names pi-cohort's channel; pi-cohort names no producer.
- pi-quiver is an independent toolbox; no code coupling.

When editing docs here, if a claim belongs to a sibling's concern, link the
sibling's doc rather than restating it. When a change alters a cross-repo
contract (dispatch shape, cost channel, settings keys), update the sibling's
docs in the same logical change and note it in both CHANGELOGs.

## Release model

Published to **npm** as `pi-cohort`; installed with `pi install npm:pi-cohort`.
The `pi-package` keyword lists it on the pi.dev packages gallery automatically.
Plain semver, no upstream remote.

Release is **tag-triggered and CI-executed**:

1. The `release` skill (driven by `release.sh`) proposes the semver level, bumps
   `package.json`, commits `Release <version>`, runs `npm run test:all` as a
   pre-flight, creates the annotated `v<version>` tag, pushes `main` + tag, then
   monitors CI and verifies npm + pi.dev. **No local `npm publish`.**
2. Pushing a `v[0-9]+.[0-9]+.[0-9]+` tag triggers
   `.github/workflows/release.yml`, which installs, verifies the tag matches
   `package.json`, runs `npm run test:all`, and runs
   `npm publish --provenance --access public` via npm OIDC trusted publishing.
   `.github/workflows/test.yml` runs the suite on every push + PR.

The release machinery (`release.sh`, `test.yml`, `release.yml`) is intentionally
kept near-identical to pi-gauntlet's; `release.sh` differs only in its CONFIG
header (package name, repo slug, former name, test command).

### Tag scheme

`v<major>.<minor>.<patch>` - plain semver. `package.json` `version` mirrors the
tag without the leading `v`.

### Running a release

Use the `release` skill (`.agents/skills/release/scripts/release.sh`):

```bash
bash .agents/skills/release/scripts/release.sh propose     # advisory bump level from git log
bash .agents/skills/release/scripts/release.sh minor       # X.Y.Z -> X.Y+1.0, bump+test+tag+push+verify
bash .agents/skills/release/scripts/release.sh patch       # X.Y.Z -> X.Y.Z+1
bash .agents/skills/release/scripts/release.sh major       # X.Y.Z -> X+1.0.0
bash .agents/skills/release/scripts/release.sh current     # tag package.json as-is
bash .agents/skills/release/scripts/release.sh --dry-run minor
bash .agents/skills/release/scripts/release.sh verify       # monitor CI, poll npm + pi.dev
bash .agents/skills/release/scripts/release.sh sync-presets # report ~/.pi + parent-tree pins (--apply to rewrite)
```

### One-off npm setup

OIDC trusted publishing must be registered once on npmjs.com for the `pi-cohort`
package (Settings -> Trusted Publishing -> GitHub Actions publisher for repo
`jjuraszek/pi-cohort`, workflow `release.yml`). Until it exists, the publish
step cannot authenticate.

## Behaviors we own

Divergences from the fork origin that are now part of this codebase:

| Behavior | Where |
|---|---|
| `agentOverrides` applied to user/project custom agents | `src/agents/agents.ts` |
| flat discovery + explicit precedence + skip `SKILL.md` | `src/agents/agents.ts` |
| `toolsPrepend` / `toolsAppend` additive override fields | `src/agents/agents.ts` |
| git-root-bounded walk + multi-level aggregation for personas/chains/settings | `src/agents/agents.ts` |

Flat discovery is the single source of truth for persona precedence. It lives in `resolveUserAgentDirs()` / `preferredUserAgentDir()` (`src/agents/agents.ts`) plus the `listFilesFlat` / `isAgentFileName` / `isChainFileName` helpers, and the multi-level walk helpers `findGitRoot` / `enumerateProjectLevels` / `dedupeByRealPath` / `readMergedProjectSubagentSettings`.

Project persona/chain discovery walks from cwd up to the git root (detected by a `.git` file or directory; no subprocess) and aggregates every level via `enumerateProjectLevels()`. The marker predicate is `.pi` OR `.agents` - the same as `findNearestProjectRoot` - so a level carrying only `.pi/settings.json` or only `.pi/chains` still participates. `dedupeByRealPath` collapses symlinked `.pi` levels on the expanded read-dir list, catching symlinks that survive the per-level realpath dedup in `enumerateProjectLevels` (a nearest `.pi` symlinked to a farther real `.pi` yields distinct level dirs but identical `<level>/.pi/agents` paths). When no git root is found, discovery falls back to the single nearest project root.

Precedence (lowest->highest):

```
builtin
  < ~/.agents
  < <PI_CODING_AGENT_DIR>/agents
  < [farthest project level]/.agents
  < [farthest project level]/.pi/agents
  < ...
  < [nearest project level]/.agents
  < [nearest project level]/.pi/agents   (highest)
```

Any project level outranks all user levels. Among project levels, nearest wins. Within one level, `.pi/agents` beats `.agents`. Chains aggregate `<level>/.pi/chains` across the same walk with the same nearest-wins rule.

Project `.pi/settings.json` `agentOverrides` and `disableBuiltins` merge across all walked levels via `readMergedProjectSubagentSettings` (farthest-first, nearest overwrites). `agentOverrides` merge is whole-object replacement per agent name - disjoint fields do not compose across levels. Override/create **writes** target the nearest project root's `.pi/settings.json` (intentional read-merge / nearest-write asymmetry). Note: a builtin override's displayed source path (`override.path`) always points at the nearest project settings file even when the winning value came from a farther level - attribution is nearest-by-design; there is no per-override provenance tracking.

Reads are flat (top-level only); `SKILL.md` and `*.chain.md` are never agents. `PI_CODING_AGENT_DIR` relocates the pi profile root but is **not** a discovery sandbox.

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
| Change the shared AGENTS core (style / discipline / ticket / ground-truth) | edit [`AGENTS.core.md`](AGENTS.core.md), run `node scripts/check-agents-core.mjs --fix`, copy both files to sibling repos |
