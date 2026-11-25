# shared

## issue-tracker

- tracker: github
- repo: jjuraszek/pi-cohort
- refs: `#N` in commit bodies and CHANGELOG entries; `(#N)` trailing in CHANGELOG bullets

Write-gate carve-out: a user instruction that names the write ("close #12 with a comment", "comment the changelog on #12") is the confirmation - execute, then report. Agent-initiated bodies and comments keep the package confirm gate. Status changes (`gh issue close/reopen`) are announced, not gated.

## cleanup

- close ticket: gh issue close <issue> --comment "Delivered in <pr>, merged <merge-sha>."
- release: /skill:release

# gauntlet

## ship

`/skill:release` is the only ship path; there is no PR gate on `main`. A user instruction naming the level (`release patch`) authorizes the whole run - `release.sh <level>` through `verify` - with no proposal step and no re-confirmation. Follow-ups bundled in the same instruction (close a ticket, post the CHANGELOG section as a comment) run after `verify` prints the version.
