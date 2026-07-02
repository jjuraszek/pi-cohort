# Drop pi-web-access: remove `researcher`, de-web `context-builder`

## Context

pi-cohort ships a `researcher` builtin whose core function only works with the
third-party `pi-web-access` extension and the external search APIs behind it
(`web_search`, `fetch_content`, `get_search_content`). A focused subagent engine
should not ship a "batteries included" builtin that actually requires batteries
bought elsewhere. The engine already exposes generic web retrieval via the
`fetch` tool (from the sibling `pi-essentials` package) and lets users author
their own web-capable custom agent.

This spec removes every `pi-web-access` reference and tool from shipped code and
docs, deletes the `researcher` builtin, and narrows `context-builder` to a single
"read an explicitly-referenced URL" capability via `fetch`. Open-web search moves
out of scope entirely.

## Decisions (locked with user)

- **Delete `researcher`** builtin. Web-specific, depends on `pi-web-access` +
  third-party APIs, unused in the user's `~/repos/`. Custom web agents can be
  authored outside this engine.
- **`context-builder` stays**, repointed off `web_search` -> `fetch`:
  - Keep: "read or fetch an explicitly referenced URL/issue/PR/plan/doc."
  - Drop: open-web research ("conduct web research when the task depends on
    external APIs/libraries/current best practices").
  - **HTTP reads go through `fetch` only** - never via `bash` + `curl`/`wget`.
    `context-builder` retains `bash` for local inspection, but it must not use it
    to reach the network. If `fetch` is unavailable, it states the URL is
    unreadable and continues with local context (it does not shell out to fetch).
- **`/parallel-research` removed entirely** (command + prompt). `prompts/parallel-handoff-plan.md`
  and other prompts that name `researcher` get repointed to `context-builder`
  (external-reference pass using `fetch` for known URLs); hard `web_search`
  mentions become `fetch`.
- **Open-web *discovery* is removed, not replaced.** `researcher`'s ability to
  find unknown sources via search has no `fetch`-based analog (`fetch` reads a URL
  you already have). Prompts must not imply discovery still happens; they read
  explicitly-referenced URLs only.
- **README** gains an "Optional pi-essentials companion" section (modeled on the
  existing pi-intercom section) documenting that `fetch` comes from `pi-essentials`
  (`pi install git:github.com/jjuraszek/pi-essentials@v0.2.0`) and that
  `context-builder` degrades to local-only context when it is absent.
- `RESEARCH_AGENT_PATTERNS` in `completion-guard.ts` is **kept** - it is generic
  intent classification (`/research(?:er)?/`), not a `pi-web-access` reference. It
  classifies research-style *custom* agents as non-mutating and is independent of
  the deleted builtin.
- **`fetch` is read-only for classification purposes.** Verified against
  `pi-essentials` `fetch.ts`: it writes only to `os.tmpdir()` (spill-to-file for
  large/binary bodies), never the workspace. Adding it to
  `READ_ONLY_BUILTIN_TOOLS` is correct - it mutates no project state, same
  rationale under which the web tools previously sat in that set.

## Out of scope

- `pi-intercom` and its bridge - untouched; high-value optional companion.
- Core npm deps (`pi-tui`, `jiti`, `typebox`) - separate concern.
- Adding any open-web-search replacement capability - explicitly not provided.
- Historical `CHANGELOG.md` entries and prior `doc/specs/*` that mention the
  removed names - immutable artifacts, left as-is (see Edge cases).
- Broader README npm-vs-git install-pin cleanup beyond the web-access swap.

## Change inventory (by file)

Anchors are quoted strings, not line numbers (line numbers drift). Each "remove"
must leave no orphan blank line or dangling list marker.

### Agents

| File | Change |
|---|---|
| `agents/researcher.md` | **Delete.** Builtins load by directory scan (`loadAgentsFromDir` over `agents/`); no enumeration list to edit. |
| `agents/context-builder.md` | Front-matter tools `read, grep, find, ls, bash, write, web_search, intercom` -> `read, grep, find, ls, bash, write, fetch, intercom`. **Delete** the bullet beginning "Conduct web research when the task depends on external APIs". The preceding bullet ("If a referenced URL, issue, PR, plan, design doc, or local file is part of the request, read or fetch it") stays - now served by `fetch`. |

### Runtime

| File | Change |
|---|---|
| `src/runs/shared/completion-guard.ts` | In `READ_ONLY_BUILTIN_TOOLS` (currently includes `"web_search"`, `"fetch_content"`, `"get_search_content"`): remove those three, add `"fetch"`. Leave `RESEARCH_AGENT_PATTERNS` unchanged. |
| `src/runs/shared/acceptance.ts` | `readOnlyAgent` regex `/\b(?:reviewer\|scout\|context-builder\|researcher\|analyst)\b/` -> drop `researcher`: `/\b(?:reviewer\|scout\|context-builder\|analyst)\b/`. |

### Prompts

| File | Change |
|---|---|
| `prompts/parallel-research.md` | **Delete.** Removes `/parallel-research` (auto-registered from `package.json` `pi.prompts`). |
| `prompts/parallel-handoff-plan.md` | Remove the `researcher` parallel-group member. Final parallel group = the two `context-builder` passes (codebase-context pass + external-reference pass) plus the existing implementation-strategy pass, which **stays** (it is local planning, not web research). Rename the "External reference researcher" role block to an external-reference `context-builder` pass. Replace both "Conduct web research ... Use `web_search` if it is available" lines with "read explicitly-referenced URLs/sources with the `fetch` tool" - sources you already have, **not** open-web discovery. Front-matter description "Parallel research/context builders ..." reworded to drop "research". |
| `prompts/parallel-context-build.md` | Replace "current docs or primary sources through `web_search`" with "referenced URLs/sources via the `fetch` tool". |
| `prompts/gather-context-and-clarify.md` | Remove the "Use `researcher` when external docs ..." guidance; keep `scout`. Optionally note `context-builder` + `fetch` for referenced URLs. |

### Tests

| File | Change |
|---|---|
| `test/unit/completion-guard.test.ts` | The two `expectsImplementationMutation("researcher", ...)` assertions (~"Research the API behavior" / "Research this and patch the bug") exercise `RESEARCH_AGENT_PATTERNS`, which is being kept. Keep them as-is - they assert the generic pattern, not the deleted builtin, and `"researcher"` still matches `/research(?:er)?/`. No change required unless we also want a `READ_ONLY_BUILTIN_TOOLS` test asserting `fetch` is read-only and the web tools are gone (recommended addition). |
| `test/unit/foreground-tool-call-compaction.test.ts` | Test "formats fetch_content urls clearly" uses `fetch_content` with a multi-URL fixture. `pi-essentials` `fetch` takes a **single `url`** (verified: `fetch.ts` schema is `Type.Object({ url: Type.String() })`, no `urls[]`). Rename the test to `fetch`, set the fixture to a single-`url` call, and update the asserted preview to the single-URL form - do not carry the old multi-url example forward. |

### Docs

| File | Change |
|---|---|
| `README.md` | Remove the `researcher` builtin-table row; remove the "researcher before you trust external facts" clause from the rule-of-thumb; remove the `/parallel-research` slash-command row; **delete** the `pi-web-access` install/notes block. **Add** an `## Optional pi-essentials companion` section immediately after the existing `## Optional pi-intercom companion` section (mirror its structure): one line that `context-builder`'s `fetch` tool comes from `pi-essentials`, the install pin `pi install git:github.com/jjuraszek/pi-essentials@v0.2.0`, and the graceful-degradation note (absent -> local-only context). Reword "retrieval budgets for researchers" to drop the researcher noun. After edits, verify no triple-blank-line gaps remain where blocks were removed. |
| `skills/pi-cohort/SKILL.md` | Repoint every `researcher` mention to `context-builder` (+`fetch`) or `scout`; remove the `researcher` agent-table row; remove all `/parallel-research` references **including the prompt-shortcuts paragraph row** (the one leftover the prior pass missed). Mechanical but sizable - grep `researcher` and `parallel-research` and resolve each hit; reword any "retrieval budgets for researchers"-style phrasing. |
| `CHANGELOG.md` | Add one `[Unreleased]` entry: removed `researcher` builtin, `/parallel-research`, and all `pi-web-access` references; `context-builder` now uses `fetch` from `pi-essentials`. Do not rewrite historical entries. |

## Edge cases

- **`fetch` listed in tools but `pi-essentials` not installed.** `context-builder`
  passes its tools verbatim to pi via `--tools`; this follows the exact precedent
  `web_search` set (an optional-extension tool named unconditionally). The agent
  must degrade to local-only context, not hard-fail. Verification step (below)
  confirms pi-core tolerates an unknown `--tools` entry; if it does not, the
  fallback is to gate `fetch` behind the same "if available" wording the old web
  bullet used instead of listing it outright.
- **Custom agent still literally named `researcher`.** `RESEARCH_AGENT_PATTERNS`
  (kept) still matches it as research-style/non-mutating; that is intended and
  unrelated to the deleted builtin. The acceptance `readOnlyAgent` regex no longer
  lists `researcher`, so a `researcher`-named custom agent loses only that one
  read-only classification path and falls through to normal classification - an
  accepted, minor behavior change.
- **Historical artifacts.** `CHANGELOG.md` history and prior `doc/specs/*` mention
  the removed names. These are immutable and intentionally untouched; the "remove
  every reference" goal scopes to shipped code, agents, prompts, README, and the
  live SKILL.

## Testing / verification

- **Blocking pre-check:** confirm pi-core accepts an unknown `--tools` entry
  (it did for `web_search`). If intolerant, fall back to "if available" wording.
- `env -u PI_CODING_AGENT_DIR npm run test:unit` (per repo AGENTS.md).
- `npm run test:all` before any release.
- Grep gates (run **after** `agents/researcher.md` is deleted, so `agents/` shows
  zero hits; must be empty for shipped surfaces; `CHANGELOG.md` history excepted):
  - `rg -n "web_search|fetch_content|get_search_content|pi-web-access" src agents prompts README.md skills`
  - `rg -ln "researcher" --glob '!CHANGELOG.md' --glob '!doc/specs/*' .` lists nothing under `src/`, `agents/`, `prompts/`, `README.md`, `skills/`.
  - `rg -n "parallel-research" --glob '!CHANGELOG.md' --glob '!doc/specs/*' .` empty.
- Manual: `/parallel-research` absent from the command list; `context-builder`
  loads with `fetch` in its tools and produces a handoff when offline.

## Open questions

None blocking design. The single gating item is the pi-core unknown-`--tools`
tolerance check above; if it fails, the fallback (conditional "if available"
wording) is already specified.
