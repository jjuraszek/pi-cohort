# Drop pi-web-access / remove researcher Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Remove the `researcher` builtin and every `pi-web-access` reference from shipped code/docs; narrow `context-builder` to read explicitly-referenced URLs via the `fetch` tool from `pi-essentials`; remove `/parallel-research`.

**Architecture:** Builtin agents load by directory scan of `agents/`; prompt commands auto-register from `package.json` `pi.prompts` -> `./prompts`. Deleting `agents/researcher.md` and `prompts/parallel-research.md` removes the builtin and the `/parallel-research` command with no registration list to edit. Runtime tool classification lives in two private collections: `READ_ONLY_BUILTIN_TOOLS` (`completion-guard.ts`) and the `readOnlyAgent` regex (`acceptance.ts`).

**Tech Stack:** TypeScript (node `--experimental-strip-types --test`), Markdown agents/prompts/docs.

**Spec:** `doc/specs/2026-06-15-drop-pi-web-access-remove-researcher.md`

---

## Files

**Delete:**
- `agents/researcher.md`
- `prompts/parallel-research.md`

**Modify:**
- `src/runs/shared/completion-guard.ts` (READ_ONLY_BUILTIN_TOOLS set)
- `test/unit/completion-guard.test.ts` (add fetch/web-tool classification assertions)
- `src/runs/shared/acceptance.ts` (`readOnlyAgent` regex)
- `test/unit/foreground-tool-call-compaction.test.ts` (rename fetch_content -> fetch, single-url)
- `agents/context-builder.md` (tools line + drop web-research bullet + add fetch-only rule)
- `prompts/parallel-handoff-plan.md`
- `prompts/parallel-context-build.md`
- `prompts/gather-context-and-clarify.md`
- `README.md`
- `skills/pi-cohort/SKILL.md`
- `CHANGELOG.md`

All work happens on the `drop-web-access` worktree branch (the spec already lives there).

---

## Wave 1 — Independent edits

Parallel-safe: Tasks 1-6 own pairwise-disjoint files (see each Files block). No task depends on another in this wave; unit tests load no markdown, and the full-suite/grep gate runs in Wave 2.

### Task 1: Reclassify `fetch` as read-only, drop web tools (completion-guard)

**TDD scenario:** Modifying tested code — write the new failing assertions first, then change the set.

**Files:**
- Modify: `src/runs/shared/completion-guard.ts:57-67`
- Test: `test/unit/completion-guard.test.ts`

- [ ] **Step 1: Add failing assertions.** In `test/unit/completion-guard.test.ts`, find the test that contains the `expectsImplementationMutation("researcher", ...)` lines (around line 90; leave those two lines unchanged — they exercise `RESEARCH_AGENT_PATTERNS`, which is kept). Add a new `test(...)` block at the end of the file's top-level tests:

  ```ts
  test("fetch counts as a read-only builtin tool; web tools no longer do", () => {
  	assert.equal(
  		evaluateCompletionMutationGuard({
  			agent: "worker",
  			task: "Implement the feature",
  			tools: ["fetch"],
  			messages: [],
  		}).expectedMutation,
  		false,
  	);
  	assert.equal(
  		evaluateCompletionMutationGuard({
  			agent: "worker",
  			task: "Implement the feature",
  			tools: ["web_search"],
  			messages: [],
  		}).expectedMutation,
  		true,
  	);
  });
  ```

  `evaluateCompletionMutationGuard` is already imported at the top of this test file.

- [ ] **Step 2: Run test, confirm failure**

  Run: `env -u PI_CODING_AGENT_DIR node --experimental-strip-types --test test/unit/completion-guard.test.ts`
  Expected: FAIL — `fetch` is not yet in the set (expectedMutation true, want false) and `web_search` is still in the set (expectedMutation false, want true).

- [ ] **Step 3: Edit the set.** In `src/runs/shared/completion-guard.ts`, change `READ_ONLY_BUILTIN_TOOLS` (lines 57-67):

  ```ts
  const READ_ONLY_BUILTIN_TOOLS = new Set([
  	"read",
  	"grep",
  	"find",
  	"ls",
  	"fetch",
  	"intercom",
  	"contact_supervisor",
  ]);
  ```

  (Removes `"web_search"`, `"fetch_content"`, `"get_search_content"`; adds `"fetch"`. `RESEARCH_AGENT_PATTERNS` untouched.)

- [ ] **Step 4: Run test, confirm pass**

  Run: `env -u PI_CODING_AGENT_DIR node --experimental-strip-types --test test/unit/completion-guard.test.ts`
  Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

  ```bash
  git add src/runs/shared/completion-guard.ts test/unit/completion-guard.test.ts
  git commit -m "Classify fetch as read-only builtin tool, drop web_search/fetch_content/get_search_content"
  ```

### Task 2: Drop `researcher` from acceptance read-only regex

**TDD scenario:** Modifying tested code — run existing suite first; the change is a single-token regex edit with no test currently asserting `researcher`.

**Files:**
- Modify: `src/runs/shared/acceptance.ts:76`
- Test: `test/unit/acceptance.test.ts` (existing, run-only)

- [ ] **Step 1: Run existing acceptance tests, confirm green baseline**

  Run: `env -u PI_CODING_AGENT_DIR node --experimental-strip-types --test test/unit/acceptance.test.ts`
  Expected: PASS.

- [ ] **Step 2: Edit the regex.** In `src/runs/shared/acceptance.ts` line 76, change:

  ```ts
  	const readOnlyAgent = /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent);
  ```
  to:
  ```ts
  	const readOnlyAgent = /\b(?:reviewer|scout|context-builder|analyst)\b/.test(agent);
  ```

- [ ] **Step 3: Run acceptance tests, confirm still green**

  Run: `env -u PI_CODING_AGENT_DIR node --experimental-strip-types --test test/unit/acceptance.test.ts`
  Expected: PASS (no test asserts `researcher`; `context-builder`/`scout`/`reviewer`/`analyst` paths unchanged).

- [ ] **Step 4: Commit**

  ```bash
  git add src/runs/shared/acceptance.ts
  git commit -m "Drop researcher from acceptance read-only-agent regex"
  ```

### Task 3: Rename foreground preview test to `fetch` single-url

**TDD scenario:** Test-only edit — `extractToolArgsPreview` (`src/shared/utils.ts`) already handles a single `args.url` string before the `urls[]` branch, so no implementation change is needed; the test fixture migrates to the real `fetch` arg shape.

**Files:**
- Modify: `test/unit/foreground-tool-call-compaction.test.ts:63-70`

- [ ] **Step 1: Replace the test block.** Change lines 63-70:

  ```ts
  	it("formats fetch_content urls clearly", () => {
  		assert.equal(
  			extractToolArgsPreview({
  				urls: ["https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging", "https://example.com/backup"],
  			}),
  			"https://developer.chrome.com/docs/extensions/develop/conc...",
  		);
  	});
  ```
  to:
  ```ts
  	it("formats fetch url clearly", () => {
  		assert.equal(
  			extractToolArgsPreview({
  				url: "https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging",
  			}),
  			"https://developer.chrome.com/docs/extensions/develop/conc...",
  		);
  	});
  ```

  The expected string is unchanged: `extractToolArgsPreview` truncates a >60-char `url` to `slice(0,57)+"..."`, identical to the old `urls[0]` path.

- [ ] **Step 2: Run test, confirm pass**

  Run: `env -u PI_CODING_AGENT_DIR node --experimental-strip-types --test test/unit/foreground-tool-call-compaction.test.ts`
  Expected: PASS.

- [ ] **Step 3: Commit**

  ```bash
  git add test/unit/foreground-tool-call-compaction.test.ts
  git commit -m "Rename foreground preview test to fetch single-url shape"
  ```

### Task 4: Agents — delete `researcher`, de-web `context-builder`

**TDD scenario:** Trivial change — markdown agent files; verified by Wave 2 grep gate + agent-load smoke check.

**Files:**
- Delete: `agents/researcher.md`
- Modify: `agents/context-builder.md:4,20-21`

- [ ] **Step 1: Delete the builtin**

  ```bash
  git rm agents/researcher.md
  ```

- [ ] **Step 2: Edit `context-builder` tools line.** In `agents/context-builder.md` line 4, change:

  ```
  tools: read, grep, find, ls, bash, write, web_search, intercom
  ```
  to:
  ```
  tools: read, grep, find, ls, bash, write, fetch, intercom
  ```

- [ ] **Step 3: Replace the web-research bullet.** Delete line 21 (the `Conduct web research ...` bullet) entirely. Then replace the preceding bullet (line 20) so the URL bullet states the fetch-only constraint. Change:

  ```
  - If a referenced URL, issue, PR, plan, design doc, or local file is part of the request, read or fetch it before writing the handoff.
  - Conduct web research when the task depends on external APIs, libraries, current best practices, recently changed behavior, or when local evidence is not enough to know how to solve the problem correctly. Use `web_search` if it is available; otherwise use whatever equivalent research capability is available.
  ```
  to:
  ```
  - If a referenced URL, issue, PR, plan, design doc, or local file is part of the request, read or fetch it before writing the handoff. Read HTTP(S) URLs only with the `fetch` tool; never shell out via `bash` (`curl`/`wget`). If `fetch` is unavailable, state that the URL is unreadable and continue with local context.
  ```

  (No open-web discovery. Leave the rest of the file unchanged; confirm no orphan blank line remains where line 21 was.)

- [ ] **Step 4: Verify**

  Run: `rg -n "web_search|fetch_content|get_search_content" agents/ ; ls agents/researcher.md 2>&1`
  Expected: no `web_search`/`fetch_content`/`get_search_content` hits; `ls` reports `researcher.md` not found.

- [ ] **Step 5: Commit**

  ```bash
  git add agents/context-builder.md
  git commit -m "Delete researcher builtin; switch context-builder to fetch-only URL reads"
  ```

  (`git rm` already staged the deletion.)

### Task 5: Prompts — remove `/parallel-research`, de-web the rest

**TDD scenario:** Trivial change — prompt markdown; verified by Wave 2 grep gate.

**Files:**
- Delete: `prompts/parallel-research.md`
- Modify: `prompts/parallel-handoff-plan.md`, `prompts/parallel-context-build.md`, `prompts/gather-context-and-clarify.md`

- [ ] **Step 1: Delete the command prompt**

  ```bash
  git rm prompts/parallel-research.md
  ```

- [ ] **Step 2: Edit `prompts/parallel-handoff-plan.md`.** Apply these exact replacements:

  - Front-matter description (line 2):
    `description: Parallel research/context builders into an implementation handoff plan`
    ->
    `description: Parallel context builders into an implementation handoff plan`
  - First-step parallel group (lines 16-18):
    ```
       - `researcher`, when the request includes external references, APIs, libraries, docs, current best practices, or prompt-guidance research.
       - `context-builder` for local codebase context.
       - Add a second `context-builder` only when the scope is large enough to benefit from a separate implementation-strategy pass.
    ```
    ->
    ```
       - `context-builder` for an external-reference pass, when the request links a URL/issue/PR/doc/repo to study; it reads those referenced sources with the `fetch` tool.
       - `context-builder` for local codebase context.
       - Add a third `context-builder` only when the scope is large enough to benefit from a separate implementation-strategy pass.
    ```
  - Role block heading + body (lines 34-38):
    ```
    External reference researcher:
    - Study linked projects, docs, issues, examples, source code, or prompt guidance.
    - Identify the behavior, API, implementation files, constraints, and transferable ideas.
    - Conduct web research if needed. Use `web_search` if it is available; otherwise use whatever equivalent research capability is available.
    - Return source links, repo paths, key evidence, risks, and what matters for this implementation.
    ```
    ->
    ```
    External-reference context-builder:
    - Study the linked projects, docs, issues, examples, or source code named in the request.
    - Identify the behavior, API, implementation files, constraints, and transferable ideas.
    - Read referenced URLs/sources with the `fetch` tool. This reads sources you were given; it does not perform open-web discovery.
    - Return source links, repo paths, key evidence, risks, and what matters for this implementation.
    ```

- [ ] **Step 3: Edit `prompts/parallel-context-build.md` line 37.** Change:
  ```
  - External API/library work: include current docs or primary sources through `web_search` when needed.
  ```
  to:
  ```
  - External API/library work: when the request references a URL or source, read it with the `fetch` tool.
  ```

- [ ] **Step 4: Edit `prompts/gather-context-and-clarify.md` line 7.** Change:
  ```
  Use `scout` to inspect the relevant local files, existing patterns, constraints, tests, and likely integration points. Use `researcher` when external docs, recent sources, ecosystem context, or primary evidence would improve the answer.
  ```
  to:
  ```
  Use `scout` to inspect the relevant local files, existing patterns, constraints, tests, and likely integration points. When the request references a URL/issue/PR/doc, use `context-builder` to read it with the `fetch` tool.
  ```

- [ ] **Step 5: Verify**

  Run: `rg -n "researcher|web_search|parallel-research" prompts/`
  Expected: no hits.

- [ ] **Step 6: Commit**

  ```bash
  git add prompts/parallel-handoff-plan.md prompts/parallel-context-build.md prompts/gather-context-and-clarify.md
  git commit -m "Remove /parallel-research; repoint prompts to context-builder + fetch"
  ```

### Task 6: Docs — README, SKILL, CHANGELOG

**TDD scenario:** Trivial change — docs; verified by Wave 2 grep gate.

**Files:**
- Modify: `README.md`, `skills/pi-cohort/SKILL.md`, `CHANGELOG.md`

- [ ] **Step 1: README — builtin table row (line 108).** Delete the entire `| `researcher` | Web/docs research ... |` table row.

- [ ] **Step 2: README — rule of thumb (line 116).** Change:
  ```
  A simple rule of thumb: use `scout` before you understand the code, `researcher` before you trust external facts, `planner` before a bigger change, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.
  ```
  to:
  ```
  A simple rule of thumb: use `scout` before you understand the code, `planner` before a bigger change, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.
  ```

- [ ] **Step 3: README — slash-command table (line 194).** Delete the entire `| `/parallel-research` | Combine `researcher` and `scout` ... |` row.

- [ ] **Step 4: README — replace the pi-web-access block (lines 381-384) with a pi-essentials companion section.** Change:
  ```
  The `researcher` builtin uses `web_search`, `fetch_content`, and `get_search_content`; those require [pi-web-access](https://github.com/nicobailon/pi-web-access):

  ```bash
  pi install npm:pi-web-access
  ```
  ```
  to:
  ```
  `context-builder`'s `fetch` tool comes from `pi-essentials`. Install it only if you want `context-builder` to read referenced URLs:

  ```bash
  pi install git:github.com/jjuraszek/pi-essentials@v0.2.0
  ```

  Without `pi-essentials`, `context-builder` degrades to local-only context: it cannot read referenced URLs but still gathers codebase context and writes the handoff.
  ```

- [ ] **Step 5: README — retrieval-budget line (line 657).** Change:
  ```
  - **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for researchers
  ```
  to:
  ```
  - **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for context gathering
  ```

  Also in the line-656 recipe list, change `parallel research, parallel context-build` to `parallel context-build` (drop the now-removed `/parallel-research` recipe from the prose list).

- [ ] **Step 6: SKILL.md — resolve every hit.** In `skills/pi-cohort/SKILL.md`, apply:
  - Line 44: delete the `/parallel-research` bullet entirely.
  - Line 158: delete the `| `researcher` | Web research brief generator | ... |` agent-table row.
  - Lines 591, 682: remove `/parallel-research` from the prompt-shortcut lists (and its mapping bullet at 682).
  - Lines 64, 87, 95, 107, 274, 305, 684, 707, 770: repoint `researcher` to `context-builder` reading referenced sources via `fetch` (for the chain-example lines 95, 274, 770, change the agent to `context-builder` and reword the task to "read the referenced source with fetch" rather than open-web research). Line 305/625 list `researchers` among async roles — drop that noun from the enumeration.
  - Line 185: change "Tell a researcher the retrieval budget" to "Tell a context-builder the retrieval budget".
  - After editing, `rg -n "researcher|parallel-research|web_search" skills/pi-cohort/SKILL.md` must return nothing.

- [ ] **Step 7: CHANGELOG.md — add one `[Unreleased]` entry.** Under the existing `## [Unreleased]` header (line 3), insert:
  ```
  ### Removed
  - `researcher` builtin agent and the `/parallel-research` prompt command.
  - All `pi-web-access` references (`web_search`, `fetch_content`, `get_search_content`).

  ### Changed
  - `context-builder` now reads referenced URLs with the `fetch` tool from `pi-essentials` (no open-web search). It degrades to local-only context when `pi-essentials` is absent.
  ```

- [ ] **Step 8: Verify + commit**

  Run: `rg -n "researcher|pi-web-access|web_search|fetch_content|get_search_content|parallel-research" README.md skills/pi-cohort/SKILL.md`
  Expected: no hits.
  ```bash
  git add README.md skills/pi-cohort/SKILL.md CHANGELOG.md
  git commit -m "Docs: remove researcher/pi-web-access, document pi-essentials fetch companion"
  ```

---

## Wave 2 — Verification

Depends on Wave 1: runs the full suite and repo-wide grep gates after every edit lands.

### Task 7: Full verification

**TDD scenario:** Verification only — no source edits.

**Files:** none (read-only checks)

- [ ] **Step 1: Unit + integration suite**

  Run: `env -u PI_CODING_AGENT_DIR npm run test:all`
  Expected: all green. (`env -u PI_CODING_AGENT_DIR` per repo AGENTS.md to avoid spurious user-scope discovery failures.)

- [ ] **Step 2: Grep gates (shipped surfaces clean; CHANGELOG/doc history excepted)**

  ```bash
  rg -n "web_search|fetch_content|get_search_content|pi-web-access" src agents prompts README.md skills
  rg -ln "researcher" --glob '!CHANGELOG.md' --glob '!doc/specs/*' --glob '!doc/plans/*' .
  rg -n "parallel-research" --glob '!CHANGELOG.md' --glob '!doc/specs/*' --glob '!doc/plans/*' .
  ```
  Expected: first and third return nothing; second lists nothing under `src/`, `agents/`, `prompts/`, `README.md`, `skills/`.

- [ ] **Step 3: pi-core `--tools` tolerance check (blocking pre-check from spec).** Confirm pi tolerates an unknown `--tools` entry when `pi-essentials` is not installed (precedent: `web_search` was listed the same way). If pi rejects it, fall back to gating `fetch` behind "if available" wording in `agents/context-builder.md` instead of listing it outright, and note the deviation.

  Run: `rg -n "unknown|ignore|filter|allow" $(rg -ln "\-\-tools|buildToolsArg|tools" src/runs/shared/pi-args.ts | head -1) | head`
  Expected: confirm tools list is passed through verbatim (consistent with the prior `web_search` behavior); document the result.

- [ ] **Step 4: Agent-load smoke check**

  Run: `ls agents/ | rg -i "research" || echo "researcher gone"` and confirm `context-builder.md` lists `fetch`.
  Expected: `researcher gone`; `rg -n "^tools:" agents/context-builder.md` shows `fetch`, not `web_search`.

---

## Open Questions

None. The single conditional is Step 3 of Task 7 (pi-core unknown-`--tools` tolerance); the spec already specifies the fallback ("if available" wording) if pi rejects the entry.
