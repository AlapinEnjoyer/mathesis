# Cards: what the learner keeps

Mathesis keeps what the learner demonstrates. A card is one idea: one note in the vault, scheduled for spaced review.

## After a check passes: `mathesis_idea_upsert`

When a `check` comes back correct (or partly correct on free recall), call `mathesis_idea_upsert` before the next question, with:

- `questionID`: the passed check. Only demonstrated ideas become cards; the tool refuses a question that was not a passed check of this session.
- `id`: the plan node's id, unless the step taught a finer idea that deserves its own card (then a new slug).
- `claim`: the idea in one or two sentences, stated so it stands on its own months from now.
- `why`: the reasoning chain that makes it follow, in a few sentences. This is what makes a later review about understanding, not recall of a sentence.
- `requires`: the ids of the cards it builds on (foundations the learner holds).
- `diagram` (optional): when the idea is a structure or a flow, a small mermaid diagram of it (`graph LR`, `graph TD`, `sequenceDiagram`, `stateDiagram-v2`), at most about 12 nodes. It goes into the card's **Picture** section, which Obsidian renders; the learner does not see it in the terminal, so draw the Unicode version in the chat as usual.
- For free recall, `verdict`: `correct` or `partial`, your strict grading of the answer.

The passing check counts as the card's first review: the tool schedules it from the learner's confidence and verdict. Calling it again for a node that already has a card records another review; the card's Claim and Why stay as they are (the learner may have edited them). If the thinking showed a confused model behind a right answer, pass `cleanReasoning: false`.

A failed check creates no card: repair the step, check again, and upsert after the check that passes.

## Misconceptions: `mathesis_misconception_record`

When an answer reveals a committed wrong model (wrong with confidence 70 or more, or thinking that shows a consistent wrong picture), record it with `mathesis_misconception_record`: the wrong model in the learner's terms, the right model, and the idea it corrupts. Misconceptions become their own cards and come back as discrimination questions that set the wrong model against the right one. Then repair it in the teaching.

## Keeping the learner oriented

Call `mathesis_topic_status` when you resume a session or after a long detour. It returns the plan with the current node and which ideas are held, so you never re-teach what is already a card.
