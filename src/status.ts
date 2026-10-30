import { dueLabel, ideaState, topicIdeas, type Runtime } from "./runtime.ts"
import { isDue, parseDate } from "./srs/fsrs.ts"
import { readLog } from "./store/log.ts"

const RECENT_DAYS = 7

/** The learner's overview: due cards per topic, recent lapses, misconceptions, and notes that could not be read. */
export async function status(rt: Runtime): Promise<{ due: number; cards: number; text: string }> {
  const now = rt.now()
  const [{ topics, errors: topicErrors }, { ideas, errors }, { entries }] = await Promise.all([
    rt.vault.listTopics(),
    rt.vault.listIdeas(),
    readLog(rt.vault.logPath),
  ])
  const cards = ideas.filter((idea) => idea.srs)
  const due = cards.filter((idea) => isDue(idea.srs, now))
  const lines: string[] = [`${due.length} of ${cards.length} cards due.`]
  const next = cards
    .map((idea) => parseDate(idea.srs?.due))
    .filter((d): d is Date => !!d && d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0]
  if (!due.length && next) lines.push(`Next review: ${next.toISOString().slice(0, 10)}.`)
  if (topics.length) {
    lines.push("", "Topics:")
    for (const topic of topics) {
      const own = topicIdeas(topic, ideas)
      const ownDue = own.filter((idea) => isDue(idea.srs, now)).length
      lines.push(`  ${topic.goal}: ${own.length} cards${ownDue ? `, ${ownDue} due` : ""}`)
    }
  }
  const since = now.getTime() - RECENT_DAYS * 86_400_000
  const lapses = [
    ...new Set(
      entries
        .filter((e) => e.mode !== "pull" && e.mode !== "practice" && e.rating === "again" && Date.parse(e.ts) >= since)
        .map((e) => e.ideaId),
    ),
  ]
  if (lapses.length) lines.push("", `Lapsed in the last ${RECENT_DAYS} days: ${lapses.join(", ")}`)
  const misconceptions = ideas.filter((idea) => idea.kind === "misconception")
  if (misconceptions.length) {
    lines.push("", "Misconceptions:")
    for (const m of misconceptions) lines.push(`  ${m.id} (${ideaState(m, now)}, ${dueLabel(m, now)})`)
  }
  const problems = [...errors, ...topicErrors]
  if (problems.length) {
    lines.push("", "Notes Mathesis could not read:")
    for (const p of problems) lines.push(`  ${p.file}: ${p.message}`)
  }
  return { due: due.length, cards: cards.length, text: lines.join("\n") }
}
