# Persona discovery walks to git root and aggregates

## Problem

Persona/chain discovery and skill discovery use different root-resolution
strategies, so project-root personas vanish when a subagent is invoked from a
subdirectory.

- **Skills (pi core):** scan `.agents/skills/` in cwd plus every ancestor up to
  the git root, aggregated.
- **Personas/chains (pi-cohort):** `findNearestProjectRoot(cwd)` stops at the
  **first** ancestor containing `.pi` or `.agents`, reads that one level flat,
  with no walk-up.

### Failure mode

A service subdirectory with its own `.agents/` (skills only) plus a
`.pi -> ../.pi` symlink anchors discovery at the subdir. Personas defined only in
the **repo-root** `.agents/` are missed. The `.pi` symlink still surfaces
install-scope personas, which masks the gap: the agent is missing when invoked
from the subdir but present when invoked from the repo root.

## Goal

Make project persona/chain discovery (and the project `.pi/settings.json`
overrides that modify it) walk from cwd up to the git root and aggregate every
level, mirroring the skill loader. Nearest level wins on name collisions,
consistent with how the rest of discovery already resolves precedence.

Out of scope: changing user-scope discovery (`~/.agents`,
`$PI_CODING_AGENT_DIR/agents`), changing skill discovery, or altering the
within-level `.agents` vs `.pi/agents` ordering.

## Decisions

| Question | Decision |
|---|---|
| Walk boundary | Git root, detected by filesystem `.git` walk (no `git` subprocess). |
| Settings `.pi/settings.json` | Reads merge across levels (nearest wins per key); writes target nearest root. |
| Precedence across levels | Nearest wins; any project level outranks all user levels. |
| Chains | Symmetric with agents - same walk + aggregate + dedup. |
| No git repo found | Fall back to today's single-nearest-root behavior (no walk). |
| Version bump | Minor (`1.3.0 -> 1.4.0`). Behavior-additive. |

## Architecture overview

Three functions currently anchor project discovery to a single root:

- `findNearestProjectRoot(cwd)` - first ancestor with `.pi` or `.agents`, then
  stops.
- `resolveNearestProjectAgentDirs(cwd)` / `resolveNearestProjectChainDirs(cwd)` -
  turn that one root into `{ readDirs: [<root>/.agents, <root>/.pi/agents],
  preferredDir }`.
- `getProjectAgentSettingsPath(cwd)` - the single `.pi/settings.json` consulted
  for `agentOverrides` / `disableBuiltins`.

The change introduces a **git-root-bounded walk** shared by all three. A new
helper enumerates every project level from cwd up to and including the git root.
The existing `Map`-based, insertion-order collision logic in `discoverAgents` /
`discoverChains` / `discoverAgentsAll` is unchanged - we only lengthen the
`readDirs` list it consumes, ordered **farthest-first** so the nearest level is
inserted last and wins. Settings gains a parallel **merge** across the same
levels, while **writes** still target the nearest root.

`realpath` dedup collapses symlinked levels: a subdir `.pi -> ../.pi` symlink
resolves to the same directory and is not double-counted. User-scope dirs are
untouched; any project level still outranks all user levels.

## Components

All in `src/agents/agents.ts`.

### New

- **`findGitRoot(startDir): string | null`** - walk ancestors looking for a
  `.git` entry, treating a `.git` **file or directory** as the marker (file form
  supports worktrees and submodules; presence is sufficient - contents are not
  validated). Returns the `realpathSync`-resolved directory containing it, or
  `null`. Pure filesystem, no subprocess. Bounded loop terminating on
  parent-equals-self; never walks above filesystem root.
- **`enumerateProjectLevels(cwd): string[]`** - from `cwd` up to and including
  `findGitRoot(cwd)`, collect each ancestor directory that contains `.pi` **or**
  `.agents` - the **same predicate** as `findNearestProjectRoot`, so a level
  carrying only `.pi/settings.json` or only `.pi/chains` (no `.agents`/
  `.pi/agents`) is still enumerated and never silently dropped. Returns
  `realpathSync`-resolved absolute paths, ordered **farthest-first**. If
  `findGitRoot` returns `null`, return at most the single
  `findNearestProjectRoot(cwd)` (today's behavior). All internal path comparisons
  use resolved paths.
- **`readMergedProjectSubagentSettings(cwd)`** - for each level (farthest-first)
  read its `.pi/settings.json`, folding into an accumulator. Each per-level read
  is wrapped in **try/catch** (see error table: `readSubagentSettings` ->
  `readSettingsFileStrict` **throws** on read/parse error) so one malformed file
  warns and is skipped rather than aborting the merge. Fold rules: `agentOverrides`
  merged **per agent name** as **whole-object replacement** - the nearest level's
  entry for a given name replaces the farther level's entry entirely (disjoint
  fields across levels do **not** compose); `disableBuiltins` taken from the
  nearest level that **defines** it (no union; a nearer `false` overrides a
  farther `true` - nearest-defined value is taken as-is regardless of polarity).

### Modified

- **`resolveNearestProjectAgentDirs`** - build `readDirs` by expanding each level
  into `[<level>/.agents, <level>/.pi/agents]` (preserving the existing
  within-level order: `.agents` then `.pi/agents`), concatenated farthest-level
  -> nearest-level. `preferredDir` = nearest level's `.pi/agents` (unchanged
  write/create target).
- **`resolveNearestProjectChainDirs`** - build `readDirs` by expanding each level
  into `[<level>/.pi/chains]` (chains live under `.pi/chains`, **not** the agent
  dirs - confirmed at `agents.ts` `resolveNearestProjectChainDirs`), concatenated
  farthest-level -> nearest-level. `preferredDir` = nearest level's `.pi/chains`.
- **realpath dedup** applies to the **expanded `readDirs` list** (concrete
  directory paths), not just level dirs: each path is `realpathSync`-resolved and
  duplicates collapsed preserving the **last (nearest)** occurrence. Level-only
  dedup is insufficient - a symlinked `.pi` (`svc/.pi -> ../.pi`) leaves distinct
  level realpaths but identical `<level>/.pi/agents` realpaths.
- **Callers that read project settings** switch to
  `readMergedProjectSubagentSettings`.

### Unchanged

`discoverAgents`, `discoverChains`, `discoverAgentsAll`, `listFilesFlat`,
`isAgentFileName`, `isChainFileName`, all user-dir resolution
(`resolveUserAgentDirs`, `preferredUserAgentDir`), and the write paths
`saveBuiltinAgentOverride` / `removeBuiltinAgentOverride` (they keep using
`getProjectAgentSettingsPath(cwd)` -> nearest root).

## Precedence ladder

Lowest -> highest:

```
builtin
  < ~/.agents
  < $PI_CODING_AGENT_DIR/agents
  < [farthest ancestor]/.agents
  < [farthest ancestor]/.pi/agents
  < ...
  < [nearest/cwd]/.agents
  < [nearest/cwd]/.pi/agents          (highest)
```

Any project level outranks all user levels. Among project levels, nearest wins.
Within one level, `.pi/agents` beats `.agents`. The same ordering drives the
settings merge.

## Data flow

For a `subagent` invocation in cwd `repo/svc/api`:

```
discoverAgents(cwd)
  -> resolveNearestProjectAgentDirs(cwd)
       -> enumerateProjectLevels(cwd):
            findGitRoot(cwd) = repo/
            levels with .pi|.agents, farthest-first:
              [ repo/, repo/svc/, repo/svc/api/ ]   (only those that exist)
       -> readDirs (farthest -> nearest), realpath-dedup on concrete paths
          (repo/svc/api/.pi/agents -> repo/.pi/agents collapses if symlinked):
            repo/.agents, repo/.pi/agents,
            repo/svc/.agents, repo/svc/.pi/agents,
            repo/svc/api/.agents, repo/svc/api/.pi/agents
       -> preferredDir = repo/svc/api/.pi/agents (nearest)
  -> Map fill: user dirs first, then readDirs in order;
     later insert overwrites -> nearest .pi/agents wins
```

Chains follow the same walk but read `<level>/.pi/chains` only:

```
discoverChains(cwd)
  -> resolveNearestProjectChainDirs(cwd)
       -> readDirs (farthest -> nearest): repo/.pi/chains,
          repo/svc/.pi/chains, repo/svc/api/.pi/chains
       -> preferredDir = repo/svc/api/.pi/chains (nearest)
```

The `Map`-based merge in `discoverAgents` already does user-first, project-after,
last-wins. We feed it a longer, correctly ordered `readDirs`. A root-only agent
(defined just in `repo/.agents`) now appears because `repo/` is enumerated; a
name also defined in `repo/svc/api/.pi/agents` still wins because it is inserted
last.

Settings, same cwd:

```
readMergedProjectSubagentSettings(cwd)
  levels farthest-first: repo/, repo/svc/, repo/svc/api/
  acc.overrides = {}; acc.disableBuiltins = undefined
  for each level: read <level>/.pi/settings.json
    overrides: fold level over acc   (nearest folded last -> wins)
    disableBuiltins: if level defines it, acc = level's value   (nearest wins)
```

Writes diverge intentionally: `saveBuiltinAgentOverride` ->
`getProjectAgentSettingsPath(cwd)` -> `repo/svc/api/.pi/settings.json` (nearest),
even though reads merged from `repo/`. This read-merge / nearest-write asymmetry
is intended: a create/update/delete from a subdir lands at the closest writable
anchor rather than silently far away at the git root.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| No git repo (`findGitRoot` -> `null`) | At most `findNearestProjectRoot(cwd)`; no walk. No regression. |
| `.git` as a file (worktree/submodule) | Presence of a `.git` file or directory is the root marker. Required for this repo's own `.worktrees/` dev. |
| Symlinked `.pi` levels (`svc/.pi -> ../.pi`) | `realpathSync`-dedup on the **expanded concrete read dirs** collapses duplicates (level-only dedup is insufficient - identical `<level>/.pi/agents` realpaths from distinct level realpaths); counted once; dedup preserves nearest occurrence for precedence. |
| Broken symlink / unreadable dir | Existence checks in `findGitRoot` and `enumerateProjectLevels` use try/catch; any `ENOENT`/`EACCES`/`ENOTDIR` skips that candidate silently and continues. Discovery never throws on one bad level. |
| Walk hits filesystem root | Bounded loop, parent-equals-self termination; never infinite-loops, never walks above filesystem root. |
| Malformed `.git` file contents | Presence of the `.git` entry is sufficient; no content validation; `findGitRoot` uses it as the boundary as-is. |
| Malformed `.pi/settings.json` at a level | `readSubagentSettings` -> `readSettingsFileStrict` **throws** on read/parse error (only a non-existent file returns `{}`). `readMergedProjectSubagentSettings` wraps each per-level read in try/catch: warn and skip the bad level, do not abort the merge. |
| Same name across levels | Nearest wins (insertion order). |
| Same name in one level's `.agents` and `.pi/agents` | `.pi/agents` wins (existing within-level order). |
| `agentOverrides` same agent name at multiple levels | Whole-object replacement; nearest level's entry wins entirely, farther fields dropped (no field-level compose). |
| `disableBuiltins` defined at multiple levels | Nearest level that defines it wins outright; no union; a nearer `false` overrides a farther `true`. |
| Chains vs agents read dir | Symmetric walk, but chains read `<level>/.pi/chains` only - never `.agents`/`.pi/agents`. |
| Performance | Walk depth bounded by path depth to git root (typically < 10); per level up to 2 `readdir` + 1 settings read; only on discovery, not per-agent. |

## Testing approach

Unit tests in `test/unit/` (node `--test`, type-stripping). Run with
`env -u PI_CODING_AGENT_DIR npm run test:unit` - the walk tests build temp
project trees and must not have the preset dir override discovery. New file:
`test/unit/agents.discovery-walk.test.ts`.

| Test | Asserts |
|---|---|
| Root persona visible from subdir | Agent only in `repo/.agents`, cwd `repo/svc/api` -> discovered. The reported-bug regression guard. |
| Nearest-wins collision | Same name in `repo/.agents` and `repo/svc/.pi/agents`, cwd under `svc` -> nearest resolves. |
| Within-level order | Same name in one level's `.agents` and `.pi/agents` -> `.pi/agents` wins. |
| Symlink dedup | `svc/.pi -> ../.pi` -> personas appear once, no double-count, nearest precedence intact. |
| No-git fallback | Temp tree with no `.git` -> only nearest project root read. |
| `.git`-as-file (worktree) | `.git` file at root -> detected as boundary. |
| Chains symmetric | Root-visible-from-subdir + nearest-wins repeated for `*.chain.md`, reading `.pi/chains` (a chain-only level with no `.agents`/`.pi/agents` still participates). |
| Settings-only level | A level with only `.pi/settings.json` (no `.agents`/`.pi/agents`) is enumerated and its overrides merge. |
| Symlink read-dir dedup | `svc/.pi -> ../.pi` -> no duplicate entries in the expanded `readDirs`. |
| Malformed settings mid-walk | A bad `.pi/settings.json` at one level warns and is skipped; merge of other levels still succeeds. |
| Override whole-object replace | Disjoint fields on same override name across levels -> nearest entry wins entirely, farther fields dropped. |
| Settings merge - overrides | Key A at root, key B at subdir -> both present from subdir; key A at both -> nearest value wins. |
| Settings merge - disableBuiltins | Defined only at root -> applies from subdir; defined at both -> nearest wins. |
| Settings write target | `saveBuiltinAgentOverride` from subdir writes to nearest `.pi/settings.json`, not git root. |
| Create/update write target | Create/update an agent from a subdir writes the persona file to the nearest `.pi/agents`, not git root. |
| User-vs-project precedence | Farthest-ancestor project agent outranks same-named `~/.agents` agent. |

Existing discovery tests must stay green unchanged (single-root repos exercise
the same code paths). Type-stripping at test time is the only typecheck (no
`tsc`).

## Documentation impact

- **`AGENTS.md`** (repo root) - the "Behaviors we own" table and the
  flat-discovery paragraph currently say `findNearestProjectRoot ... reads that
  one level flat` and describe the single-root ladder. Update to: git-root
  bounded walk, multi-level aggregation, new precedence ladder, realpath dedup,
  settings read-merge vs nearest-write asymmetry. Add `findGitRoot`,
  `enumerateProjectLevels`, `readMergedProjectSubagentSettings` to the discovery
  source-of-truth note.
- **`README.md`** - agent/chain discovery + precedence section: document
  walk-to-git-root, nearest-wins across levels, no-git fallback, settings merge.
  User-facing register, concise.
- **`CHANGELOG.md`** - one entry under a new `1.4.0` heading: persona/chain
  discovery walks to git root and aggregates every `.agents` + `.pi/agents`
  (nearest wins); project `.pi/settings.json` overrides merge across levels
  (nearest wins), writes still target nearest root. Note behavior-additive but
  consumers should read before bumping a pinned tag.
- **Code comment** - one inline comment at the write path explaining the
  read-merge / nearest-write asymmetry (the *why* is non-obvious).
- **Spec doc** - this file.

## Open questions

None. All design decisions resolved during brainstorming (see Decisions table).
