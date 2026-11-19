# Investigation report

Print the report itself, without a preamble or code fence. Use the headings below in order. Separate sections with a blank line; give each one short paragraph or one list, never both.

| Heading | Include | What to say |
|---|---|---|
| `## What I found` | Always | Lead with the findings that change what the reader does. Give each a concrete value or before/after from the brief. State a corrected assumption as the fact. For a failed child or a call that did not run, name what went unchecked. When design fit is `not assessed`, say that whether the request fits the current design is unknown. |
| `## Where it clashes with the current design` | Only when `## Design fit` contains a `- clash:` line | Take the most consequential clash: contrast what the request asks for with the decision already in place. Give the count of other clashes; leave their details in the brief. |
| `## What it means for your request` | Always | Say whether the request can go ahead as asked, needs to change or cannot be judged yet. Give the reason. |
| `## What you need to decide` | Always | List up to three open questions from the brief. Give each its recommended answer and a because-clause. When more remain, add their count as the last list item. With no open questions, use one sentence saying no decision is needed and what happens next. |

End with `Full investigation: <absolute path to brief.md>` on its own line. Use the actual path supplied with the brief, without backticks. Put nothing after it.

Write for a reader who has neither the code nor the brief open. Describe each part of the system by what it does before naming it. Keep literal names the user typed, except paths: describe a file by its role. Keep all paths, line numbers, agent names and citations out of the body. Ground every sentence in a fact in the brief or its practical consequence. State what is unknown as unknown.

| Brief shorthand | Report wording |
|---|---|
| premise | What the request assumes |
| Confirmed / Contradicted / Unverified | What the evidence shows instead of a label; what we still do not know |
| wave | The checks that ran together; name what they checked |
| scout | What the search of the code found |
| reviewer | Which assumption the evidence supported or ruled out |
| context-builder | What the linked material says |
| call site | The place that starts the action |
| fixture | Sample data |
| convention | The way the team already handles this |

Use at most 180 words from the first heading through the line before `Full investigation:`, headings included. Over budget, cut lower-impact findings from `What I found` first. Keep each required section and the recommendation and reason for each listed question.

Example (shape only; take facts and path from the actual brief):

```markdown
## What I found

Readers have two days to collect a reserved book before the library offers it to the next person.

## Where it clashes with the current design

The request would give readers a week. The library set a two-day limit to keep the waiting list moving.

## What it means for your request

A reminder can fit within the current pickup window. A week-long hold needs a change to the lending policy.

## What you need to decide

- Extend the hold or remind readers sooner? Send the reminder sooner, because it gives readers notice without delaying the next person in line.

Full investigation: /tmp/library-holds/brief.md
```
