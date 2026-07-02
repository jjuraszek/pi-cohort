---
name: release
description: Creates a release for jjuraszek/pi-cohort. Use when asked to release, bump the version, or cut a tag. This package is consumed via git tag pins (git:github.com/jjuraszek/pi-cohort@vX.Y.Z); there is no npm publish step.
---

# Release

Use this skill when asked to release this package.

## Repository-specific release model

This package is consumed via **git tag pins** in pi `settings.json` (e.g.
`"git:github.com/jjuraszek/pi-cohort@v0.27.0"`), not via npm. A release here means:

1. set the version in `package.json`
2. create the release commit (non-`current` modes) and the matching `v<version>` git tag
3. push `main` and the tag to `origin`
4. rewrite every `~/.pi/agent*/settings.json` that pins this repo so its `@<old-ref>` becomes `@v<version>` (done by the helper script)

There is no CI publish workflow. **Do not run `npm publish`** — nothing consumes the npm package.

This repo originated as a fork of `nicobailon/pi-subagents` but **no longer
tracks upstream**. It is a standalone semver project; there is no upstream
remote, rebase, or `-jj.<n>` suffix. See [AGENTS.md](../../../AGENTS.md)
"Release model".

## Tag scheme

`v<major>.<minor>.<patch>` — plain semver. `package.json` `version` mirrors the
tag without the leading `v`.

## Modes

| Mode | When | Effect |
|---|---|---|
| `current` | version already hand-set in a feature commit | tags the version in `package.json` as-is, no bump, no extra commit |
| `patch` | backward-compatible fix | bumps `X.Y.Z -> X.Y.Z+1`, commits `Release <version>`, tags |
| `minor` | backward-compatible feature | bumps `X.Y.Z -> X.Y+1.0`, commits, tags |
| `major` | breaking change | bumps `X.Y.Z -> X+1.0.0`, commits, tags |

Any pre-release suffix on the current version is dropped on bump
(`0.26.0-jj.2` + `minor` -> `0.27.0`).

## Safety checks before releasing

- working tree is clean (for `current`, commit your feature work first — `current` tags HEAD as-is)
- releasing from `main`
- local `main` can fast-forward from `origin/main`
- the target `v<version>` tag does not already exist (script enforces this)

If any check fails, stop and explain why.

## Preferred execution path

```bash
bash .agents/skills/release/scripts/release.sh minor
bash .agents/skills/release/scripts/release.sh patch
bash .agents/skills/release/scripts/release.sh current
```

Validation run (no side effects):

```bash
bash .agents/skills/release/scripts/release.sh --dry-run minor
```

Release without touching settings.json pins (rare):

```bash
bash .agents/skills/release/scripts/release.sh --no-update-pins current
```

## What the helper script does

1. resolves repo root from the script path; reads `package.json` version
2. computes the next version per mode (semver bump, dropping any pre-release suffix)
3. fails if the target tag already exists
4. `--dry-run`: prints the plan (incl. which settings.json pins would change) and exits
5. otherwise: verifies `main` + clean tree, (non-`current`) bumps + commits, runs `npm run build/check --if-present`, creates annotated tag, pushes `main` + tag
6. rewrites `~/.pi/agent*/settings.json` pins of `git:github.com/jjuraszek/pi-cohort@<ref>` to the new tag (unless `--no-update-pins`)

Project repos that pin this package (e.g. a consuming repo's `.pi/settings.json`)
are **not** touched by the script — bump those pins by hand.
