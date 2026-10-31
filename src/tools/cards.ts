import { dueLabel, type Runtime } from "../runtime.ts"
import { endOfDay } from "../srs/fsrs.ts"
import { today, type Idea } from "../store/vault.ts"

export const firstLine = (value: string) => value.split("\n").find((line) => line.trim())?.trim() ?? ""

/** A local calendar date for people ("2026-11-04"). */
export const localDay = (value: string | Date) => today(new Date(value))

/** Everything an agent needs to write a new question about a card: claim, why, the wrong model, foundations, stems. */
export async function cardDetail(rt: Runtime, idea: Idea, options: { askedBefore?: number } = {}): Promise<string[]> {
  const misconception = idea.kind === "misconception"
  const foundations: string[] = []
  for (const id of misconception ? idea.about : idea.requires) {
    const other = await rt.vault.readIdea(id).catch(() => undefined)
    if (other) foundations.push(`- \`${id}\`: ${firstLine(other.claim)}`)
  }
  const stems = idea.askedBefore.slice(-(options.askedBefore ?? idea.askedBefore.length))
  return [
    misconception ? "### The right model" : "### Claim",
    idea.claim || "(empty)",
    ...(idea.why ? ["", "### Why", idea.why] : []),
    // The learner sees the terminal, not this mermaid: redraw it as a Unicode diagram if a question or correction needs it.
    ...(idea.picture.trim() ? ["", "### Picture (mermaid in the note; redraw as a Unicode diagram if you show it)", idea.picture] : []),
    ...(idea.misconceptions ? ["", misconception ? "### The wrong model" : "### Known misconceptions", idea.misconceptions] : []),
    ...(foundations.length ? ["", misconception ? "### Ideas it corrupts" : "### Builds on", ...foundations] : []),
    "",
    "### Asked before (write a NEW question; do not reuse this wording)",
    ...(stems.length ? stems.map((stem) => `- ${stem}`) : ["(nothing yet)"]),
  ]
}

/** "due today", "overdue by 3 d", or "due later today" for a card due within the learner's day. */
export function dueText(idea: Idea, now: Date): string {
  const due = idea.srs ? new Date(idea.srs.due) : undefined
  if (due && due > now && due <= endOfDay(now)) return "due later today"
  return dueLabel(idea, now)
}
