# toolsPrepend/toolsAppend and MCP Removal

## Status

Draft for review.

## Context

`pi-cohort` builtin and custom agents can define explicit `tools` allowlists. Users can currently replace a builtin agent's tool list with `subagents.agentOverrides.<name>.tools`, or clear the explicit allowlist with `tools: false`. There is no supported way to add a few tools while preserving the agent's existing list.

That makes extension-oriented adoption brittle. For example, enabling navigator tools for orientation agents requires duplicating the full current tool list for each agent. When builtin definitions evolve, those copied override lists drift.

The same tool path also carries MCP-specific compatibility code. `pi-cohort` parses `mcp:` pseudo-tool entries into `mcpDirectTools`, resolves adapter cache/config state, and passes `MCP_DIRECT_TOOLS` to child runs. Pi does not support MCP natively, and this repo should not carry private compatibility glue for a separate adapter. The MCP support should be removed hard rather than deprecated.

`pi-web-access` is intentionally out of scope for this change. Existing web tool references remain unchanged.

## Goals

- Add generic additive tool overrides for both builtin and custom agents.
- Preserve existing full replacement and clearing behavior for `tools`.
- Keep override precedence unchanged: project override wins over user override.
- Remove all MCP-specific implementation, docs, and tests from this repo.
- Fail clearly when stale `mcp:` configuration is encountered.
- Verify removal with a ripgrep over `src`/`test` for the removed MCP compatibility identifiers.

## Non-goals

- No changes to `pi-web-access`, `web_search`, or `web_fetch` behavior.
- No list interpolation syntax such as `$base` or `{tools}`.
- No user+project additive layering; the winning override remains the only applied override.
- No runtime tool mutation through Pi extension APIs.
- No bundled navigator-specific or agent-browser-specific behavior.

## Design

### Override schema

Add two optional fields to `subagents.agentOverrides.<name>`:

```json
{
  "toolsPrepend": ["navigator_locate", "navigator_slice"],
  "toolsAppend": ["some_other_tool"]
}
```

Both fields accept arrays of strings. Empty strings are silently dropped (trimmed and filtered), matching current `parseOverrideStringArrayOrFalse` behavior; non-string entries throw a field-specific error. These fields are generic; they are not tied to navigator or any specific extension.

The existing `tools` field keeps its current meaning:

- `tools: ["read", "bash"]` replaces the agent's effective explicit tool list.
- `tools: false` clears the agent's explicit tool list.
- omitted `tools` preserves the agent's current explicit tool list.

`toolsPrepend` and `toolsAppend` compose around that effective list:

```text
toolsPrepend + effectiveTools + toolsAppend
```

Deduplication operates over the entire concatenated list in left-to-right order: the first occurrence of a tool name is kept, later occurrences are dropped. This lets `toolsPrepend` intentionally move an already-present tool earlier in the final list.

Composition is applied at override-application time inside `applyBuiltinOverride` and `applyCustomAgentOverride`, not at run construction time. The resolved tools list is stored on `AgentConfig` and passed through `buildPiArgs` unchanged.

### Builtin and custom agents

The additive fields apply to both builtin and custom agents.

For builtin agents, the winning override may replace, clear, prepend, append, or combine those operations. The override metadata should continue recording the original base config as it does today.

For custom agents, the two field families behave differently:

| Field | Custom-agent behavior |
|---|---|
| `tools` (array or `false`) | Non-destructive: applies only when frontmatter `tools` is unset. Frontmatter `tools` continues to win when present. |
| `toolsPrepend` / `toolsAppend` | Always compose around the resolved effective tools, whether or not frontmatter `tools` is set. |

A custom agent with `tools:` frontmatter can still receive additional tools through `toolsPrepend` or `toolsAppend` without copying the whole frontmatter list.

The current custom-agent override guard treats tools as unset when both `tools` and `mcpDirectTools` are undefined (`agents.ts`). After MCP removal, this guard becomes `agent.tools === undefined`; this is the intended new threshold. Additive fields compose regardless of this guard.

Project settings continue to take precedence over user settings. If a project override exists for an agent, the user override for that agent is ignored entirely, including additive fields.

### MCP removal

Remove MCP-specific support from the codebase rather than preserving a compatibility path.

Implementation should remove:

- `mcpDirectTools` from agent and override config types.
- `mcp:` splitting/parsing behavior, including the separate `parseTools` in `agent-management.ts` (create/update) and its serialization/detail re-join.
- direct MCP allowlist resolution and cache/config lookup code.
- `MCP_DIRECT_TOOLS` child-process environment plumbing in `pi-args.ts`, including the unconditional `__none__` sentinel branch emitted on every child run. No replacement env var is needed.
- MCP-specific tests, docs, README sections, and changelog entries that describe current behavior.

Stale `mcp:` entries should fail fast with a clear error that MCP direct tools are no longer supported, wherever agent `tools` or override tool fields are parsed - including agent frontmatter, settings overrides, and the `agent-management.ts` create/update path. This is preferable to treating `mcp:foo` as an ordinary tool name, because silent acceptance would fail later in a child run with less context.

### Runtime behavior

Child run argument construction should receive only the final `tools` list and any extension paths. Tool names remain normal Pi tool names. Path-like tool entries remain handled by the existing generic extension-path logic.

No child process should receive MCP-specific environment variables. No runtime code should inspect MCP adapter config, cache files, or naming rules.

## Edge cases

- `toolsPrepend` with a tool already in the base list moves that tool to the front because first occurrence wins during dedupe.
- `toolsAppend` with a tool already in the base list has no effect on order.
- `tools: false` plus additive fields produces only the additive tool list.
- `tools: false` without additive fields clears the explicit allowlist as it does today.
- `toolsPrepend: []` and `toolsAppend: []` are valid no-ops if existing validation conventions allow empty arrays for string-list fields; otherwise they should follow the existing array validation standard in this file.
- Unknown non-MCP tool names are not validated at discovery time; existing Pi startup/tool allowlist behavior remains responsible for unavailable normal tools.
- `mcp:` entries are rejected wherever agent `tools` or override tool fields are parsed.

## Testing

Unit tests should cover:

- builtin override prepends tools while preserving base tools.
- builtin override appends tools while preserving base tools.
- prepend/append combine with `tools` replacement in the expected order.
- prepend/append combine with `tools: false` in the expected order.
- duplicate tools dedupe by first occurrence.
- custom-agent overrides can prepend/append to custom frontmatter tools.
- custom-agent `tools` override applies only when frontmatter `tools` is unset; frontmatter `tools` wins when present.
- malformed `toolsPrepend` / `toolsAppend` values report field-specific override errors.
- project override wins with no additive layering: user override `toolsPrepend: ["u-tool"]` and project override `toolsAppend: ["p-tool"]` for the same agent resolve to only the project override applied (`p-tool` present, `u-tool` absent).
- stale `mcp:` entries in frontmatter, settings overrides, or the agent-management create/update path fail with a clear unsupported-MCP message.

Verification commands:

```bash
env -u PI_CODING_AGENT_DIR npm run test:unit
rg -n "mcpDirectTools|MCP_DIRECT_TOOLS|resolveMcpDirectTools|mcp-direct-tool-allowlist|mcpDirect" src test
```

The `rg` command targets the removed compatibility identifiers only and is scoped to `src`/`test`, so it does not match the `mcp:` literal in the fail-fast error message or its test strings. It should return no matches once removal is complete.

## Documentation

Update `README.md` to document `toolsPrepend` and `toolsAppend` alongside `tools`. The docs should show additive usage for extension tools without naming navigator as a built-in dependency.

Remove MCP-specific documentation. The README should no longer describe `mcp:` tool entries, direct MCP tools, adapter requirements, or MCP limitations.

Update `CHANGELOG.md` with an unreleased entry describing the new additive override fields and the hard removal of MCP direct-tool compatibility.
