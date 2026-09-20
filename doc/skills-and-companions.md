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

What the bundled skill covers - only what the `subagent` tool description and schema leave open:
- **Fresh vs fork**: when a branched thread earns its cost and when a reviewer must not see the parent's reasoning
- **Acceptance levels**: the evidence each level requires and how `auto` infers a level
- **Per-task overrides**: `reads`, `outputMode`, `outputSchema`, `skill`, `cwd`, `acceptance` and where outputs land
- **Control actions**: `status`, `interrupt`, `resume`, attention thresholds
- **Config fields**: `reference/config-fields.md` for agent and chain management config

Review and delivery workflows live in pi-gauntlet; pi-cohort ships delegation primitives.

## Optional shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt | Use it for |
|---|---|
| `/investigate <request> [--out path]` | Parallel read-only recon and premise check before planning or brainstorming; writes a brief with cited findings, questions with recommendations, and verified findings from a second read-only wave. |
| `/handoff [--out path]` | A fixed-template brief for continuing in a fresh session: intent, decisions, repo/worktree state, skills loaded, and gauntlet process state when present. Contract: [doc/handoff-template.md](handoff-template.md). |

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
