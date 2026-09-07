# Skills and companions

How agent system prompts pick up skills, the bundled orchestration skill, the
optional prompt shortcuts, and the optional companion package. Back to
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
- **Safety boundaries**: child agents must not run subagents unless their resolved builtin tools explicitly include `subagent`, and must stop on unapproved decisions
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

When a child needs an unapproved decision, it must stop with `BLOCKED: <decision needed>` as the first line, followed by `Done: <complete>` and `Remaining: <left>`. The parent receives an ordinary failed result; sequential chains stop at that step, parallel siblings keep their results, and follow-up is a fresh dispatch after the parent or human decides.

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
