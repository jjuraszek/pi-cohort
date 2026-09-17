# pi-cohort

Pi extension that lets Pi delegate work to focused child agents: code review, scouting, implementation, parallel audits, saved chains, and background/async jobs. Published to npm as `pi-cohort` (`pi install npm:pi-cohort`), plain semver.

<!-- agents-core:begin v5 - shared across pi-quiver/pi-cohort/pi-gauntlet/pi-condense. Edit AGENTS.core.md, then: node scripts/check-agents-core.mjs --fix -->
## Ground Truth Before Reasoning

User instructions outrank skill and AGENTS.md guidance; on conflict, follow the user. Configured gates (design approval, ship verification) still run; a user instruction that already names the gated action satisfies its confirmation.

Never guess Pi's API, message shapes, config, or values - read the source. The pi runtime is the **`@earendil-works`** namespace (matches the host pi install), not `@mariozechner`; its shipped `.d.ts` is API truth. Third-party APIs: never state a signature, config key, flag, or version-specific behavior from memory - verify in current docs (Context7 `resolve-library-id` then `query-docs`). If the source contradicts your assumption, the source wins; if it is missing, say so and ask - do not fabricate. Check the request's premise before acting: if the source contradicts it, say so once with evidence, then follow the user's decision.

The same rule applies to state you set up yourself. Before asserting that a job, publish, CI run, or process is in some state, run the command that shows it in this turn (`gh run view`, `npm view`, `git status`). A summary of what you started is a plan, not an observation.

## Authorization

An instruction that names an action and its parameters is the approval for that action ("release patch", "close #12 with a comment") - do it, then report. Ask only when a parameter is ambiguous or a safety check fails; say what failed, don't fix it silently. Once the design is settled, finish the authorized work before asking - the user approves a concrete result. Reversible, read-only, and already-authorized actions need no permission. Agent-initiated writes to a tracker or to files outside the repo keep their gate.

## Communication Style

Human-read text is elevator talk: three beats, each a whole sentence - what happened, what it means for the reader, what you need from them. Show, don't reference: one concrete example (a value, a before/after line, a quoted sentence) instead of any path, SHA, or id; identifiers go behind a link labelled in plain words ("the merge commit", not `abc1234`) that sits on the claim it supports. Paths inline only in PR bodies, because the reviewer opens them. Short means fewer sentences, never fewer verbs: "the validation rejects nil names" is as long as "some name handling was tightened" and says something checkable.

| Regime | Surfaces | Format |
|---|---|---|
| Human-read | chat, commit messages, PR/issue bodies and comments, review feedback, tracker and Slack comments | three beats; whole sentences; one example; links as provenance trailing the claim; end on the ask |
| LLM-read | AGENTS.md, README, CHANGELOG, specs, plans, skill/agent/prompt files, non-obvious-why code comments | tables, headings, exact references (file, SHA, value), code blocks; density still binds; optimize for unambiguous retrieval |

The regimes differ in where exactness is carried, not how much: human-read text puts it in the example and links the reference; LLM-read text puts it in the reference itself.

Human-read rules:

- **Start with the substance.** No intent classification, phase/routing announcements, tool/subagent preamble, status narration, pleasantries. Output outcomes, decisions needing input, verification results, blockers.
- **Whole sentences, no scaffolding.** No Options/Recommendation/TL;DR templates, no headings on a short body, no checkbox lists that restate prose. Bullets are for genuinely parallel items, never a substitute for a sentence.
- **Active voice, named actor, no hedging.** "The validation rejects nil names", not "nil names should now be rejected". One term per concept.
- **Restate, never point.** Never point at tool outputs, finding numbers, plan rows, or earlier turns the reader didn't see - restate in one sentence. Delete every link and the reply must still stand; a link is provenance, never the content.
- **State what you did or will do.** No padding with what you won't do, what stays unchanged, or alternatives nobody asked about. No closing summaries. Evidence is a sentence with an example ("unit tests pass: 212 tests, 0 failures"), not a pasted transcript.
- **PR bodies describe the change, not its validation:** no test counts, lint status, or command outcomes - CI holds that evidence.
- **ASCII punctuation everywhere** (chat, comments, commits, docs, code): `-` not em-dash, `...` not the ellipsis glyph, straight quotes; non-ASCII only for a justified visual mark.

## Code & Documentation Discipline

- **Code is a liability.** Add only what the task requires. No premature abstractions, no helpers for hypothetical reuse, no fallbacks for branches that can't happen, no commented-out alternatives.
- **No new machinery if not essential.** Reuse an existing field, channel, or code path (plus a small discriminant if needed) over a new sibling construct; new machinery must earn its place by being impossible or misleading to express with what exists.
- **No belt-and-suspenders.** Validate a thing once, at the boundary that owns it - not at every layer.
- **Delete dead code, don't comment it out.** When a change supersedes code, remove the old path in the same commit. Branch from the deletion commit if reversibility matters.
- **Comments are stock, not flow.** Record the durable why, never task context, tickets, or callers. Good: `// output is never empty for a real dispatch`. Bad: `// #12: gate on this so the classifier doesn't no-op`. No docstrings on self-evident params/returns, no banner comments.
- **Surface, don't auto-fix.** A bug fix doesn't drag in surrounding cleanup; mention adjacent issues separately.
- **Docs are a current contract, present tense.** No "upcoming"/"pending" in a current-state guide - planned work lives in `doc/specs/`, `doc/plans/`, or the ticket; history lives in `CHANGELOG.md` and commit bodies, never in AGENTS.md or a guide. Doc updates ride with the commit that makes them stale. Editing a doc puts the smallest unit you touch - bullet, row, heading block - in scope: its paths resolve, its commands match the source, its framing is present tense; stale content outside that unit: flag, don't fix.
- **AGENTS.md is always-on essentials plus routing, not the manual.** Route detail to `doc/` or `README.md` and link it; add an inline pointer only when critical or high-frequency. README and AGENTS.md stay in sync where they overlap.
- **Markdown tables use compact `|---|` separators.** Never padded columns.

## Ticket convention

Creating a ticket or repairing its title/body/metadata happens only via `/skill:shape-ticket` - it enforces the Context -> Problem -> Idea -> Acceptance Criteria template, an AC integrity gate, and a cheap council roast applied to the body before the single human-gated write (no roast comments); a user instruction naming the ticket's body counts as that gate. Status transitions and comments are exempt - plain tracker CLI.

<!-- agents-core:end v5 -->

## Part of one platform

One of four sibling pi extensions - **pi-quiver** (capabilities), **pi-cohort** (coordination), **pi-condense** (context economy), **pi-gauntlet** (process). They ship and version independently; a concept is explained in its owning repo and linked from the others, never duplicated.

- Only hard runtime dependency: pi-gauntlet -> pi-cohort (`subagent()`). Not an npm/peer dependency - pinned in pi-gauntlet's README and its consumers' `settings.json#packages`.
- Runtime coupling: pi-condense emits `cost:external`; pi-cohort aggregates it into `Σ$` ([`doc/observability.md`](doc/observability.md)). pi-condense names pi-cohort's channel; pi-cohort names no producer.
- pi-quiver: no code coupling.

A change that alters a cross-repo contract (dispatch shape, cost channel, settings keys) updates the sibling's docs in the same logical change and lands in both CHANGELOGs.

## Discovery and precedence

Flat discovery in `src/agents/agents.ts` is the single source of truth for persona and chain precedence: builtin < `~/.agents` < `<PI_CODING_AGENT_DIR>/agents` < project levels walked from the git root down to cwd, nearest level wins, `.pi/agents` beats `.agents` within a level. `SKILL.md` and `*.chain.md` are never agents. Full rules, override fields, settings merge: [`doc/agents-and-chains.md`](doc/agents-and-chains.md#agents-and-chains-discovery-and-precedence).

## Testing

- `npm run test:unit` (node `--test` with type-stripping), `npm run test:integration`, `npm run test:all`. No `tsc` ships here; type-stripping at test time is the typecheck. CI (`.github/workflows/test.yml`) runs `test:all` on every push and PR.
- Unit tests that exercise user-scope discovery set `HOME`/`USERPROFILE` to a temp dir. A configured `PI_CODING_AGENT_DIR` (present in any real pi harness shell) overrides `HOME` and fails ~17 of them spuriously: `env -u PI_CODING_AGENT_DIR npm run test:unit`.

## Release

`/skill:release` owns the flow: `release.sh <level>` promotes `## [Unreleased]` in `CHANGELOG.md`, bumps `package.json`, commits `Release X.Y.Z`, tests, tags `vX.Y.Z`, pushes; CI publishes via OIDC. A user instruction naming the level is the approval. Mechanics and safety checks: [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md).

## Routing

| Want to ... | Read |
|---|---|
| Install, configure, slash commands, agent/chain authoring | [`README.md`](README.md) |
| What changed across versions | [`CHANGELOG.md`](CHANGELOG.md) |
| Agent/chain discovery, overrides, scopes | [`doc/agents-and-chains.md`](doc/agents-and-chains.md) |
| Cost aggregation, `cost:external` | [`doc/observability.md`](doc/observability.md) |
| Consume or produce a handoff brief | [`doc/handoff-template.md`](doc/handoff-template.md) |
| pi-gauntlet skill overrides for this repo | [`.pi/gauntlet-overrides.md`](.pi/gauntlet-overrides.md) |
| Run a release | [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md) |
| Change the shared AGENTS core | edit [`AGENTS.core.md`](AGENTS.core.md), `node scripts/check-agents-core.mjs --fix`, copy both files to the siblings, `--fix` there |
