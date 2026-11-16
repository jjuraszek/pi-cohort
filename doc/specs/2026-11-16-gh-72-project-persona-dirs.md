# Project settings add persona directories that outrank the defaults

**Ticket:** [#72](https://github.com/jjuraszek/pi-cohort/issues/72)
**Goal:** A project lists extra persona directories under `subagents.agentDirs` in `.pi/settings.json`; pi-cohort lists and dispatches the personas in them with project precedence, above that level's `.pi/agents` and `.agents`, and everything that loads today still loads.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-16
**Source bases:** pi-cohort `a1bee83` (8.2.0); installed pi-gauntlet and the sibling `pi-gauntlet` checkout's `bin/install-agents.mjs`, read-only.
**Predecessor:** `doc/specs/2026-06-27-persona-discovery-walk-to-git-root.md`, the `resolveNearestProjectAgentDirs` clause under "Modified" only.

## Problem

Ticket #72, "Override project persona directories with one path or an array". A project used with both pi and Claude Code keeps one set of agent definitions, for example in `.claude/agents`. pi-cohort reads project personas only from `.agents` and `.pi/agents` at each level from the git root down to cwd (`src/agents/agents.ts:1121-1134`), so the project must keep a copy that drifts or a symlink its checkout rules or platform may not support. The ticket's example: a Markdown definition with `name` and `description` frontmatter stored only in `.claude/agents/example.md` is not discovered.

The ticket's Idea asks for a setting that replaces the default project persona directories. The agreed design adds directories instead; see `Framing:` below.

### Request, verbatim

1. `#72 build in persona or other extension persona like ../pi-gauntlet/ still works as they were. this is about project additional personas dirs. repo personas should always shadow buildin, right?`
2. `there is already simillar mechanism. I think we should allow this under subagents key for settings.json, right?`
3. Framing reply: `B, pure extra just make sure configured dirs takes precedence`
4. Cut-question reply: `B, what is config key and where to define it?`
5. Approach reply: `A, agentDirs should be under subagents object right?`
6. Design round 1 reply: `approve`
7. Design round 2 reply: `approve`

### Framing

Framing: pivoted to additive persona directories - replacement hides pi-gauntlet personas that a project install copies into `<repo>/.pi/agents`, and leaves project `create` writing to a directory discovery no longer reads; the ticket names no case that needs the defaults switched off.

The framing question offered: A) as framed - the configured list replaces `.agents` and `.pi/agents`; B) add - configured directories are read on top of the defaults and win name clashes; C) ship no setting and document a symlink. The user chose B.

The approach question offered: A) per level - configured beats that level's defaults, a nearer level still wins; B) configured beats every default at every level; C) A plus user-level directories from the profile file. The user chose A.

### Claims checked

| Claim | Source | Lookup | Result |
|---|---|---|---|
| Repo personas shadow builtin | request 1 | `src/agents/agent-selection.ts:3-22` | Held. `mergeAgentsForScope` sets builtin, then user, then project into one `Map`; project wins by name for `agentScope` `both` and `project`. `agentScope: "user"` excludes project personas by design. |
| Builtin personas keep working | request 1, AC 3 | `src/agents/agents.ts:1148-1163` | Held. Builtins load from `BUILTIN_AGENTS_DIR`, independent of the project directory resolver. |
| Other-extension personas (pi-gauntlet) keep working | request 1 | sibling `pi-gauntlet` `bin/install-agents.mjs:5-19, 79-88`; listing of the profile `agents` directory | Held for a user install (symlinks in `<profile>/agents`, user scope). Corrected for a project install under replacement: the installer copies personas into `<repo>/.pi/agents`, one of the two directories AC 2 replaces. The additive design keeps both install modes working. |
| A similar mechanism exists | request 2 | `src/agents/agents.ts:135-150, 489-594`; `doc/configuration.md:3-15`; `src/agents/skills.ts:187-208` | Held. `settings.json#subagents` is the only namespace pi-cohort reads; `disableBuiltins` and `agentOverrides` already live there and merge project-only across walked levels. The nearest path-list precedent is Pi's top-level `skills` array (`collectSettingsSkillPaths`): additive, `~/` expanded, relative entries resolved against the settings file's directory. |
| No persona-directory key exists yet | ticket | `rg 'agentDirs\|personaDirs' src doc README.md`; `EXTENSION_SETTING_TYPES` at `src/agents/agents.ts:135-150` | Held. No hit. |
| The key sits inside the `subagents` object | requests 2 and 5 | `src/agents/agents.ts:489-493` | Held. `readSubagentSettings` reads only `settings.subagents`; a top-level `agentDirs` is never seen. |
| "The project settings file" is one file | AC 5 | `src/agents/agents.ts:279-301, 547-577` | Corrected. `readMergedProjectSubagentSettings` reads `.pi/settings.json` at every level from the git root to cwd and returns merged values without the defining file; each level's entries resolve against that level's `.pi` directory before the merge loses it. |
| Discovery can read the setting where it resolves directories | implicit | `src/agents/agents.ts:1150-1156, 1200-1207` | Corrected. `discoverAgents` and `discoverAgentsAll` call `resolveNearestProjectAgentDirs(cwd)` before reading settings, and the resolver takes only `cwd`. |
| Project `create` writes where discovery reads | implicit | `src/agents/agent-management.ts:521-524`; `src/agents/agents.ts:1132-1133` | Held under the additive design: the create target is the nearest level's `.pi/agents`, which discovery still reads. Broken under replacement. |
| Update and delete write the loaded file | implicit | `src/agents/agent-management.ts:616, 681` | Held. Both write `target.filePath`, so a persona loaded from a configured directory is edited or deleted there. |
| Missing directories are tolerated | implicit | `src/agents/agents.ts:1121-1134` | Held. The resolver pushes a candidate only when `isDirectory` is true. |
| Wrong-typed keys have a drop-with-warning precedent | implicit | `src/agents/agents.ts:519-529`; `doc/configuration.md:13` | Held. Wrong-typed extension keys are dropped with `console.warn` naming file and key; other keys stay. |
| README names discovery directories or individual keys | implicit | `README.md:242-252`; `rg '\.pi/agents\|\.agents' README.md` | Corrected. Its Configuration section routes to `doc/configuration.md` and names no discovery directory; it names one key, `forwardParentFlags` (`README.md:252`), and tells users to set `subagents` options in the profile or a project file (`README.md:244`). README needs no edit: `doc/configuration.md` carries the `agentDirs` project-only exception. |
| A test covers the top-level `skills` path list | implicit | `rg` over `test/unit/skills-fallback.test.ts` | Corrected. Its cases cover packages, not `skills` path entries; the helper extraction adds a case. |
| Sibling docs list pi-cohort's `subagents` keys | AGENTS.md cross-repo rule | `rg '16 keys\|agentOverrides'` over the sibling `pi-gauntlet` README and `doc/` | Held. None lists the key set; no sibling doc changes. |
| Discovery gates project settings on project trust | implicit | `rg -i trust src/agents/agents.ts` | Held: no hit. Configured directories load under the same conditions as `.pi/agents`. |
| Ticket rows carry no workflow-stage proof | pi-gauntlet `shape-ticket` AC integrity gate | the gate table against the 10 rows | Held. All rows are behaviors or a documentation outcome. |
| Claude Code agent files load unchanged | ticket Context | none - this repo has no `.claude/agents` sample; the ticket puts conversion out of scope | Not checked. The design covers only definitions that already meet pi-cohort's format. Files in configured directories are read with pi-cohort frontmatter semantics (`src/agents/agents.ts:907-985`): a file without `name` or `description`, or with an invalid `package`, is skipped; any other frontmatter, including `model` and `tools` values pi-cohort does not know, loads as-is; an invalid `settings` value or an `mcp:` tool entry throws and aborts discovery. |

### Ticket notes carried

- Reporter note (comment 6917843823), verbatim: `Original discovery criterion before removing the out-of-scope skills/helper-prompts clause: - [ ] After a new compatible definition is added to that directory, a fresh session discovers it without a per-agent configuration entry or changes to skills or helper prompts.` The reporter marks the skills and helper-prompts clause as removed; this change touches no skill or helper prompt.
- Ticket "Out of scope / Follow-up": automatic conversion of Claude Code agent files, changes to chain, skill or prompt discovery, and consumer-specific installation changes.

## Acceptance criteria

Ticket #72, Acceptance Criteria, rows verbatim:

- [ ] The project persona-directory setting accepts a single string path or an array of string paths; a string and a one-element array containing that string discover the same personas.
  in-scope
- [ ] When the setting is present, configured directories replace the default project `.agents` and `.pi/agents` search locations, with no implicit fallback to those locations. An empty array disables project-directory discovery.
  deviates: configured directories add to the default project locations and outrank them; an empty array adds nothing
- [ ] The setting leaves bundled and user-level persona discovery unchanged, including when its value is an empty array. Bundled personas need no explicit directory entry. Existing overrides and disable settings retain their behavior.
  in-scope
- [ ] With a compatible agent definition stored only in a configured directory outside the default locations, pi-cohort lists and dispatches that agent from the original file without creating a copy or symlink.
  in-scope
- [ ] Relative directory paths resolve against the directory containing the project settings file, independent of the launch directory; `../.claude/agents` in `.pi/settings.json` selects the same definitions from the repository root or a nested working directory.
  in-scope
- [ ] After a new definition meeting pi-cohort's format requirements is added to that directory, a fresh session discovers it without a per-agent discovery entry.
  in-scope
- [ ] Dispatching a definition from the configured directory preserves existing model and thinking resolution: frontmatter values win, and name-keyed overrides fill unset values, as for agents in default locations.
  in-scope
- [ ] When the setting is absent, discovery returns the same agents and resolves duplicate names with the same precedence as before.
  in-scope
- [ ] When two configured directories contain the same persona name, the later array entry wins in both listing and dispatch. Configured personas retain project-scope precedence over bundled and user-level personas.
  in-scope
- [ ] The user-facing configuration and discovery documentation shows both single-path and array examples, including `.claude/agents`, and states project-only replacement, unchanged bundled and user-level discovery, absent-setting and empty-array behavior, settings-file-relative paths, and later-entry-wins precedence.
  deviates: the docs state additive behavior in place of project-only replacement

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-72-project-persona-dirs
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (`release.sh <level>`) per overrides `## Release`
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7, AC 8, AC 9, AC 10
design: owns `src/agents/agents.ts`, `src/agents/skills.ts`, `src/shared/utils.ts`, `test/unit/agents.agent-dirs.test.ts`, `test/unit/skills-fallback.test.ts`, `doc/configuration.md`, `doc/agents-and-chains.md`, `AGENTS.md`, `CHANGELOG.md`; personas in directories named by a project level's `subagents.agentDirs` are listed and dispatched as project personas above that level's defaults.

## Design

### Setting

| Property | Value |
|---|---|
| Key | `subagents.agentDirs`, inside the `subagents` object |
| Type | a string, or an array of strings; a string is a one-entry array |
| Where it is read | each project level's `<level>/.pi/settings.json`, for every level `enumerateProjectLevels(cwd)` returns (git root down to cwd; outside git, the nearest marked ancestor) |
| Where it is ignored | the profile `settings.json`: discovery never consumes the profile file's value; a valid value there adds nothing, and an invalid one gets the invalid-`agentDirs` warning and adds nothing |
| Entry resolution | each entry is trimmed first; then a `~/` prefix expands to the home directory; an absolute path passes through; anything else resolves against the directory holding the settings file (`<level>/.pi`) |
| Absent or `[]` | adds no directory |
| Across levels | every walked level contributes its own list, resolved against its own `<level>/.pi`; the lists accumulate, so a nearer level's `[]` or different list does not clear a farther level's entries |

Example, in `<repo>/.pi/settings.json`; the entry reads `<repo>/.claude/agents` from any cwd inside the repo:

```json
{ "subagents": { "agentDirs": ["../.claude/agents"] } }
```

The single-path form is `"agentDirs": "../.claude/agents"`.

"The project settings file" in AC 5 means each walked level's own `.pi/settings.json`; an entry always resolves against the file that defines it.

`agentDirs` is a discovery key like `disableBuiltins`: it is not added to `EXTENSION_SETTING_TYPES` and `resolveExtensionConfig` does not return it. Unlike `disableBuiltins` it is not a nearest-wins key and is not consumed from the profile.

### Precedence

Each level contributes directories in this read order; the consuming maps are last-writer-wins, so a later directory wins a name clash:

1. `<level>/.agents`
2. `<level>/.pi/agents`
3. that level's `agentDirs` entries, in array order

Levels are concatenated farthest-first, as today. The result:

| Clash | Winner |
|---|---|
| Two entries of one level's `agentDirs` | the later entry |
| A configured directory vs the same level's `.pi/agents` or `.agents` | the configured directory |
| Any directory of a nearer level vs any directory of a farther level, configured or default | the nearer level |
| Any project persona vs a user or builtin persona | the project persona (`mergeAgentsForScope`, unchanged) |

Personas from configured directories have source `project`. `agentScope: "user"` excludes them like any project persona.

### Data flow

1. `readSubagentSettings(filePath)` parses `subagents.agentDirs`, trims each entry, and resolves each trimmed entry with `resolveSettingsPath(entry, path.dirname(filePath))`. It does this for any file it reads, the profile file included, so an invalid profile value gets the same warning; only project levels are consumed.
2. `readMergedProjectSubagentSettings(cwd)` already reads every level once; in that loop it records each level's resolved list in a map keyed by the level path `enumerateProjectLevels` returned. The lists stay per level and are never merged nearest-wins. No file is read twice.
3. `discoverAgents` and `discoverAgentsAll` read project settings first, then call `resolveNearestProjectAgentDirs(cwd, projectSettings.agentDirsByLevel)`.
4. `resolveNearestProjectAgentDirs` appends each level's configured directories after that level's `.pi/agents`, keeping only paths for which `isDirectory` is true, then applies `dedupeByRealPath` as today. `preferredDir` stays `<nearest level>/.pi/agents`.
5. Loading is unchanged: `loadAgentsFromDir` reads top-level `*.md` only, skips `SKILL.md` and chain files, and requires `name` and `description`. Files in configured directories get pi-cohort frontmatter semantics, including the throws that abort discovery; see [Errors and edge cases](#errors-and-edge-cases). `applyCustomAgentOverrides` runs over the result as today, so frontmatter `model` and `thinking` win and `agentOverrides.<name>` fills unset values.

Moving parts:

- Remove: the inline `~/` / absolute / relative block in `collectSettingsSkillPaths` (`src/agents/skills.ts:201-206`); replace it with a call to `resolveSettingsPath(entry, base)`.
- Add: `export function resolveSettingsPath(entry: string, baseDir: string): string` in `src/shared/utils.ts`, with exactly the behavior of the removed block: it resolves the string it is given and does not trim, so `skills` resolution is unchanged.
- Add: `agentDirs?: string[]` (one file's resolved entries) and `agentDirsByLevel?: Map<string, string[]>` (the merged project result) on `SubagentSettings` in `src/agents/agents.ts`.
- Add: the `agentDirs` parse and validation in `readSubagentSettings`, returned on both of its success paths. It trims each entry before the blank check and passes the trimmed entry to `resolveSettingsPath`.
- Add: the per-level collection in `readMergedProjectSubagentSettings`, returned as `agentDirsByLevel`.
- Add: a second parameter on `resolveNearestProjectAgentDirs(cwd, agentDirsByLevel)` and the append step.
- Add: the settings-before-directories call order in `discoverAgents` and `discoverAgentsAll`. With `scope === "user"`, `discoverAgents` passes no map.
- Update: the precedence comment above `resolveUserAgentDirs` (`src/agents/agents.ts:1064-1089`), which ends at `<nearest project level>/.pi/agents (highest)`: each level's `agentDirs` entries sit after that level's `.pi/agents` and before every nearer level's directories.
- Add: `test/unit/agents.agent-dirs.test.ts`, and one case in `test/unit/skills-fallback.test.ts`.
- Add: the documentation edits in [Documentation impact](#documentation-impact).

### Write paths

- Project `create` writes to the nearest level's `.pi/agents` (`src/agents/agent-management.ts:521-524`), unchanged.
- Update and delete write the file the persona was loaded from (`src/agents/agent-management.ts:616, 681`), unchanged; a persona loaded from `.claude/agents` is edited or deleted there.
- Chain discovery (`resolveNearestProjectChainDirs`) is unchanged.

### Documentation clauses

The docs named in [Documentation impact](#documentation-impact) show a single-path example and an array example, both including `.claude/agents`, and state: configured directories add to `.agents` and `.pi/agents` and outrank them within a level; bundled and user-level discovery are unchanged; an absent key and an empty array add nothing; relative entries resolve against the settings file's directory; a later array entry beats an earlier one; a nearer level beats a farther one; `agentDirs` is consumed only from project `.pi/settings.json` files, never from the profile `settings.json`; every walked project level contributes its own list, resolved against its own settings directory, and a nearer level's `[]` or different list does not clear an ancestor's entries; files in configured directories are read with pi-cohort frontmatter semantics.

### Predecessor scope

supersedes `doc/specs/2026-06-27-persona-discovery-walk-to-git-root.md`, the `resolveNearestProjectAgentDirs` clause under "Modified" only: each level now expands into `.agents`, `.pi/agents`, then its configured directories. The predecessor's walk, level concatenation, settings merge, chain resolver and `.agents`-before-`.pi/agents` order stand.

### Paid or external actions

None. Implementation and verification use the local unit and integration suites only. Approving this spec authorizes no paid or external action.

## Errors and edge cases

| Case | Behavior |
|---|---|
| `agentDirs` is neither a string nor an array of strings, or any entry is blank after trimming | The key is dropped with `console.warn`: `Subagent settings in '<file>' have invalid 'agentDirs'; expected a string or an array of non-empty strings.` The level's other keys still apply. |
| A configured path does not exist or is a file | Skipped silently, like a missing `.pi/agents`. |
| A nonblank entry with surrounding whitespace | Trimmed before resolution: `" ../.claude/agents "` reads the same directory as `"../.claude/agents"`. |
| `~/` or absolute entry | Accepted; its personas are project personas. |
| An entry that resolves to a user root (`~/.agents`, `<PI_CODING_AGENT_DIR>/agents`) or to the builtin directory | Accepted as existing cross-scope loading: the directory also loads as project scope, its personas appear under both scopes, cross-scope entries are not deduplicated, and `disableBuiltins` does not suppress the project copy. |
| The same directory configured at two levels | Loads once, at the nearer level's rank (`dedupeByRealPath`). |
| An entry that resolves to a default directory of its own level | Loads once, at configured rank: `"agents"` (which is `.pi/agents`) changes nothing in effect; `"../.agents"` makes `.agents` beat `.pi/agents` at that level. |
| Any level `readMergedProjectSubagentSettings` skips: malformed JSON, an invalid `disableBuiltins`, or an invalid `agentOverrides` entry | Contributes no configured directories; its `.agents` and `.pi/agents` still load. |
| A nearer level sets `agentDirs` to `[]` or to a different list | The farther level's configured directories still load, at the farther level's rank. |
| An invalid `executionBackend` or a user-only child setting at any level | Aborts resolution as today (`readMergedProjectSubagentSettings` rethrows). |
| Outside git | The nearest marked ancestor's `agentDirs` applies; no other level is read. |
| A nearer level's `.pi/agents` and a farther level's configured directory hold the same name | The nearer level wins. |
| `agentDirs` in the profile `settings.json` | Adds nothing. An invalid value gets the invalid-`agentDirs` warning and adds nothing. |
| A file in a configured directory without `name` or `description`, with an invalid `package`, or inside a subdirectory | Not loaded, as in `.pi/agents`. |
| A file in a configured directory with `name` and `description` and other frontmatter pi-cohort does not know, including `model` and `tools` values | Loaded as-is, as in `.pi/agents`; the values reach dispatch unchanged. |
| A file in a configured directory with `name` and `description` and an invalid `settings` value or an `mcp:` tool entry | Throws and aborts discovery of every persona, builtin and extension personas included, as in `.pi/agents`. The throw is preserved; no skip-with-warning is added. |

## Tests

New cases live in `test/unit/agents.agent-dirs.test.ts`, `describe("project agentDirs setting")`, using the temp `HOME` / `USERPROFILE` / `PI_CODING_AGENT_DIR` setup of `test/unit/agents.discovery-walk.test.ts`. "Listing" is `discoverAgentsAll(cwd)`; "dispatch" is `discoverAgents(cwd, "both")`.

Acceptance rows:

- AC 1: a string and a one-element array return the same personas - `a string and a one-element array discover the same personas`
- AC 2 (as deviated): personas in `.agents`, `.pi/agents` and a configured directory all load, and the configured one wins a shared name - `configured directories load alongside the defaults and win name clashes`
- AC 2 (as deviated): `[]` leaves default project discovery intact - `an empty array adds nothing`
- AC 3: builtin and user personas are still returned with the key set to a path and to `[]` - `bundled and user personas stay discovered with agentDirs set`
- AC 3: `disableBuiltins` and `agentOverrides` give the same result with and without the key - `disableBuiltins and agentOverrides keep their behavior with agentDirs set`
- AC 4: a persona stored only in the configured directory appears in listing and dispatch with `filePath` equal to that file, and `.pi/agents` and `.agents` gain no entry - `a persona only in a configured directory is listed and dispatched from its original file`
- AC 5: `../.claude/agents` in `<repo>/.pi/settings.json` returns the same personas from the repo root and from a nested cwd - `a relative entry resolves against the settings file from any cwd`
- AC 6: a definition written after a first discovery is returned by the next one with no settings change - `a definition added later is discovered without a per-agent entry`
- AC 7: frontmatter `model` and `thinking` survive, and `agentOverrides.<name>` fills them when unset - `frontmatter wins and overrides fill unset model and thinking for a configured persona`
- AC 8: without the key, results are unchanged - `test/unit/agents.discovery-walk.test.ts`, existing cases unmodified
- AC 9: with one name in two configured directories, listing and dispatch both return the later entry's file - `the later array entry wins in listing and dispatch`
- AC 9: a configured persona beats a user and a builtin persona of the same name - `configured personas beat user and bundled personas`
- AC 10: the docs carry the clauses in "Documentation clauses" - none: prose, checked by the conformance review

Design edge and error clauses:

- Invalid value is dropped with the warning and the level's `agentOverrides` still applies (non-string, array holding a non-string, blank entry) - `an invalid agentDirs is dropped with a warning`
- Missing path and file path are skipped - `a missing or non-directory entry is skipped`
- `~/` and absolute entries load with source `project` - `home and absolute entries load as project personas`
- Same directory at two levels loads once at the nearer rank - `a directory configured at two levels loads once at the nearer rank`
- An entry naming `.pi/agents` or `.agents` loads once at configured rank - `an entry naming a default directory loads once at configured rank`
- A nonblank entry with surrounding whitespace resolves like the unpadded entry - `a padded entry is trimmed before it resolves`
- A persona only in a farther level's configured directory is still listed when the nearer level sets `agentDirs` to `[]` and when it sets a different directory - `a nearer level's agentDirs does not clear an ancestor's configured directories`
- A relative entry defined in a nested level's `.pi/settings.json` resolves against that file's directory, not the git root - `a relative entry in a nested settings file resolves against that file's directory`
- An entry naming a user or builtin root also loads as project scope - none: no cross-scope rule is added; the existing loading behavior is accepted as documented
- Malformed settings file: no configured directories, defaults still load - `a malformed level contributes no configured directories`
- Invalid `executionBackend` aborts - none: unchanged rethrow, covered by existing settings tests
- Outside git, the nearest marked ancestor's key applies - `outside git the nearest marked ancestor's agentDirs applies`
- Nearer `.pi/agents` beats a farther configured directory - `a nearer level's default beats a farther level's configured directory`
- Profile key adds nothing, and an invalid profile value gets the warning - `agentDirs in the profile settings adds nothing`
- `agentScope: "user"` excludes configured personas - `user scope excludes configured personas`
- Files without required frontmatter or in subdirectories are not loaded - none: `loadAgentsFromDir` is unchanged and covered by existing discovery tests
- An invalid `settings` value or an `mcp:` tool entry aborts discovery - none: `loadAgentsFromDir` is unchanged; covered by `rejects frontmatter settings that are not one line of JSON` in `test/unit/agent-frontmatter.test.ts` and `rejects custom agent frontmatter tools that contain mcp: entries` in `test/unit/agent-overrides.test.ts`
- `discoverAgentsAll(cwd).projectDir` is the nearest `.pi/agents` with the key set - `the create target stays the nearest .pi/agents`
- Update and delete write the loaded file - none: `agent-management.ts` is unchanged
- Chain discovery is unchanged - none: `resolveNearestProjectChainDirs` is unchanged
- `skills` path entries (`~/`, absolute, relative) resolve as before the helper extraction - `test/unit/skills-fallback.test.ts`, `resolves ~/, absolute and relative skills entries`

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/configuration.md` (operations / tunable parameters: new `agentDirs` section with single-path and array examples including `.claude/agents`; it states that the key is consumed only from project `.pi/settings.json` files, that every walked level contributes its own list instead of the nearest defined value winning, the invalid-value rule, that a level rejected for malformed JSON, an invalid `disableBuiltins` or an invalid `agentOverrides` entry contributes no configured directories while its default directories still load, and that configured files use pi-cohort frontmatter semantics; `agentDirs` is added to the discovery-settings sentence under "Settings source and precedence" as a per-level, project-only key); `doc/agents-and-chains.md` (architecture: "Agents and chains: discovery and precedence" - a configured-directory row in the locations table, the collision bullet, the settings-merge bullet describing `agentDirs` apart from its nearest-wins list, which stays at 16 keys, and the Implementation paragraph's description of the expanded read-dir list; both the collision bullet and the Implementation paragraph place each level's configured directories after that level's defaults and before every nearer level's directories); `CHANGELOG.md` (`## [Unreleased]`, `### Added`, trailing `(#72)`)
- Derived / memory docs invalidated: `AGENTS.md` "Discovery and precedence" (within-level order gains configured directories above `.pi/agents`)

The materiality bar is `reference/documentation-impact.md`. `README.md` needs no edit: its Configuration section names no discovery directory and routes to `doc/configuration.md`, which carries the `agentDirs` project-only exception to README's profile-or-project sentence.

## Out of scope

- Replacing or disabling the default project directories; a switch for it. AC 2 and the replacement clause of AC 10 are recorded as `deviates:`.
- User-level directories from the profile `settings.json`.
- Automatic conversion of Claude Code agent files; any change to the persona file format or to the flat, top-level-only read.
- Chain, skill and prompt discovery; skills and helper prompts.
- Consumer-specific installation changes, including pi-gauntlet's `install-agents.mjs`.
- A configurable project `create` target.
- Gating project settings or configured directories on project trust.
- Deduplicating or filtering a configured entry that names a user or builtin root.
- Skipping, with or without a warning, a configured file whose frontmatter pi-cohort rejects.
- The stale `package-lock.json` version on `main` (`7.6.7` against `package.json` `8.2.0`).

## Open questions

- Whether real Claude Code agent files meet pi-cohort's format was not checked (no sample in this repo). Compatibility with real Claude Code files stays unverified. The design promises discovery of compatible definitions only; an incompatible file gets one of the three unchanged loader outcomes in [Errors and edge cases](#errors-and-edge-cases): skipped, loaded as-is, or a throw that aborts discovery.
