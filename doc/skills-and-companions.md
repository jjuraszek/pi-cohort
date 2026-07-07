# Skills and companions

How agent system prompts pick up skills, the bundled orchestration skill, the
optional prompt shortcuts, and the two optional companion packages. Back to
[README](../README.md).

## Skills

Skills are `SKILL.md` files injected into an agent's system prompt.

Discovery uses project-first precedence:

1. `.pi/skills/{name}/SKILL.md`
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. `.pi/settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "scout", task: "..." }
{ agent: "scout", task: "...", skill: "tmux, safe-bash" }
{ agent: "scout", task: "...", skill: false }
```

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

Injected skills use this shape:

```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

Missing skills do not fail execution. The result summary shows a warning.

## Bundled skill

The package bundles a `pi-cohort` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: child subagents never receive it, and their context is explicitly filtered to strip parent-only orchestration instructions.

What the bundled skill covers:
- **Delegation patterns**: when to launch which agent, whether to use single, parallel, chain, or async mode, and whether to use fresh or forked context
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel review, review-loop, parallel context-build, parallel handoff-plan, gather-context-and-clarify, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for context gathering
- **Safety boundaries**: child agents must not run subagents unless their resolved builtin tools explicitly include `subagent`, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and prompt shortcuts encode the same workflows in user-facing form.

## Optional shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|---|---|
| `/parallel-review` | Launch fresh-context reviewers with distinct angles, then synthesize what to fix. |
| `/review-loop` | Run parent-controlled worker, reviewer, and fix-worker cycles until clean or capped. |
| `/parallel-context-build` | Run `context-builder` agents in parallel to produce planning handoff context and meta-prompts. |
| `/parallel-handoff-plan` | Combine an external-reference `context-builder` pass and a local `context-builder` pass into an implementation handoff plan and meta-prompt. |
| `/gather-context-and-clarify` | Scout and gather context first, then ask the user the clarification questions that matter. |
| `/parallel-cleanup` | Run review-only cleanup passes after implementation. |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now after reviewers return.

## Optional pi-intercom companion

`pi-cohort` works without `pi-intercom`. Install `pi-intercom` only if you want child agents to talk back to the parent Pi session while they are running.

```bash
pi install npm:pi-intercom
```

Most users do not call `intercom` directly. After `pi-intercom` is installed, `pi-cohort` can automatically give child agents a private coordination channel back to the parent session. The bridge recognizes the normal `pi install npm:pi-intercom` package install as well as legacy local extension checkouts.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for blocking decisions or clarification, and `reason: "progress_update"` for short non-blocking updates when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. With the intercom bridge active, parent-side `pi-cohort` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent `subagent` run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets, full child summaries, and compact nested child summaries under the parent child that launched them.

If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run:

```text
/cohort-doctor
```

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in [configuration.md](configuration.md#intercombridge).

## Optional pi-essentials companion

`pi-cohort` works without `pi-essentials`. Install `pi-essentials` only if you want `context-builder` to read referenced URLs (issues, PRs, docs, specs) as part of its handoff.

```bash
pi install git:github.com/jjuraszek/pi-essentials@v0.2.0
```

Without `pi-essentials`, `context-builder` degrades to local-only context: it cannot read referenced URLs but still gathers codebase context and writes the handoff.

## Prompt-template integration

`pi-cohort` works standalone through natural language, the `subagent` tool, slash commands, and the packaged prompt shortcuts above. If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), you can also wrap subagent delegation in your own reusable prompt templates.

Example:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to `browser-screenshoter` with `/tmp/screenshots` as cwd, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

For more reusable workflows on top of subagents, including `/chain-prompts` and compare-style prompts such as `/best-of-n`, install `pi-prompt-template-model` separately and copy the examples you want into `~/.pi/agent/prompts/`.
