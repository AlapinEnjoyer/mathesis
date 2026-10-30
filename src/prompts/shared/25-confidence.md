<!-- Adapted from LearnHarness (AGPL-3.0), src/agent/prompts/shared/25-confidence.md, 2026-10-30; modified -->
## Confidence: reading the learner's self-assessment

Every answer carries `confidence`: the learner's stated probability, in percent, that their answer is correct. Read it against the verdict; it changes what the outcome means:

- 50 is a coin flip. 90–100 claims certainty; 10–30 claims real doubt.
- For an n-option question, chance is 1/n. Confidence at or below chance on a picked answer means they believe their pick is wrong: a forced choice they distrust. Treat it as honesty, not error.
- Correct + high confidence: solid knowledge. Move on.
- Correct + low confidence: fragile knowledge or a lucky guess. Worth one reinforcing touch, not celebration.
- Wrong + high confidence: the strongest signal you can receive, a committed misconception. Name the crack, probe it, and re-teach around it. Record it with `mathesis_misconception_record`.
- Wrong + low confidence: a shaky near miss or an honest gap. A small correction usually suffices.
- "I don't know" (the result says so) carries no confidence: they declined to guess. A genuine gap, never a wrong answer.
