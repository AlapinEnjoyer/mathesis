import { randomUUID } from "node:crypto"
import { access, chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { readSrs, type Srs } from "../srs/fsrs.ts"
import {
  getData,
  getSection,
  mergeField,
  newNote,
  parseNote,
  serializeNote,
  setField,
  setSection,
  splitList,
  type Note,
} from "./note.ts"

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ASKED_BEFORE_LIMIT = 10

export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug.length <= max) return slug || "untitled"
  // Cut at a word end, unless that would drop most of the slug.
  const cut = slug.slice(0, max + 1)
  const end = cut.lastIndexOf("-")
  return (end >= max / 2 ? cut.slice(0, end) : slug.slice(0, max)).replace(/-+$/g, "") || "untitled"
}

/** Words that say how the learner asks, not what about: left out of topic ids made from a goal. */
const GOAL_FILLER = new Set(
  "a an the i me my we our you your to for of in on at by with and or about how what why when is are be it this that these those would like want wish need please can could help learn learning understand understanding know see get have has study according".split(" "),
)

/** A topic id from the learner's goal: the content words, cut at a word end. */
export function topicSlug(goal: string, max = 40): string {
  const words = slugify(goal, Number.MAX_SAFE_INTEGER).split("-")
  const content = words.filter((word) => !GOAL_FILLER.has(word))
  return slugify((content.length ? content : words).join(" "), max)
}

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && SLUG.test(value)
}

function assertSlug(value: string, what: string) {
  if (!isSlug(value)) throw new Error(`Invalid ${what} "${value}": use lowercase letters, digits and single hyphens`)
}

/** The learner's local calendar date (YYYY-MM-DD). */
export function today(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A frontmatter value that should be a list of slugs; a single slug written by hand also counts. */
function slugList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return list.filter(isSlug)
}

export type IdeaKind = "proposition" | "chain" | "misconception"

export interface Idea {
  id: string
  topic?: string
  kind: IdeaKind
  requires: string[]
  /** For misconception cards: the ideas the wrong model corrupts. */
  about: string[]
  created?: string
  source?: string
  srs?: Srs
  claim: string
  why: string
  misconceptions: string
  askedBefore: string[]
}

export interface IdeaPatch {
  id: string
  topic?: string
  kind?: IdeaKind
  /** Added to the existing `requires` (never removes what the learner wrote). */
  requires?: string[]
  about?: string[]
  source?: string
  claim?: string
  why?: string
  misconceptions?: string
  /** Initial or new FSRS state, written in the same write as the rest. */
  srs?: Srs
  /** Overwrite Claim and Why even when they already have text. Default: only fill empty sections. */
  replace?: boolean
}

export interface Topic {
  id: string
  goal: string
  created?: string
  data: Record<string, unknown>
  assessment?: string
  plan?: string
  ideas: string[]
}

export interface TopicPatch {
  goal?: string
  /** Extra frontmatter keys, e.g. the stored plan. */
  fields?: Record<string, unknown>
  /** Markdown sections to replace, by heading. */
  sections?: Record<string, string>
  addIdeas?: string[]
}

export interface ListError {
  file: string
  message: string
}

const ideaLabel = (id: string) => id.replace(/-/g, " ")
/** The links line Mathesis writes. A line the learner changed no longer matches and is left alone. */
const BUILDS_ON_OWNED = /^Builds on: \[[^\]\n]+\]\(\.\/[a-z0-9-]+\.md\)(?:, \[[^\]\n]+\]\(\.\/[a-z0-9-]+\.md\))*$/m
const BUILDS_ON_ANY = /^Builds on:/m

function withBuildsOn(why: string, linked: string[]): string {
  if (BUILDS_ON_ANY.test(why) && !BUILDS_ON_OWNED.test(why)) return why
  const text = why.replace(BUILDS_ON_OWNED, "").trim()
  if (linked.length === 0) return text
  const links = linked.map((id) => `[${ideaLabel(id)}](./${id}.md)`).join(", ")
  return `${text ? text + "\n\n" : ""}Builds on: ${links}`
}

/** The vault folder: plain Markdown notes plus an append-only review log. */
export class Vault {
  private locks = new Map<string, Promise<unknown>>()

  constructor(readonly root: string) {}

  get ideasDir() {
    return join(this.root, "ideas")
  }
  get topicsDir() {
    return join(this.root, "topics")
  }
  get sessionsDir() {
    return join(this.root, "sessions")
  }
  get logPath() {
    return join(this.root, "log", "reviews.jsonl")
  }

  ideaPath(id: string) {
    assertSlug(id, "idea id")
    return join(this.ideasDir, `${id}.md`)
  }

  topicPath(id: string) {
    assertSlug(id, "topic id")
    return join(this.topicsDir, `${id}.md`)
  }

  async ensure() {
    await Promise.all(
      [this.ideasDir, this.topicsDir, this.sessionsDir, dirname(this.logPath)].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    )
  }

  async hasIdea(id: string): Promise<boolean> {
    try {
      await access(this.ideaPath(id))
      return true
    } catch {
      return false
    }
  }

  /**
   * Serializes read-modify-write cycles on one file inside this process. Two opencode processes writing the same
   * note at the same moment can still lose one update (see docs/decisions.md).
   */
  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(fn)
    this.locks.set(path, run)
    try {
      return await run
    } finally {
      if (this.locks.get(path) === run) this.locks.delete(path)
    }
  }

  private async readNote(path: string): Promise<Note | undefined> {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    return parseNote(text)
  }

  /** Atomic write (temporary file + rename). A symlinked note is written through to its target; the mode is kept. */
  private async writeNote(path: string, note: Note) {
    let target = path
    let mode: number | undefined
    try {
      target = await realpath(path)
      mode = (await stat(target)).mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(dirname(target), { recursive: true })
    const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, serializeNote(note), "utf8")
      if (mode !== undefined) await chmod(tmp, mode)
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }

  private async updateNote(path: string, edit: (note: Note, exists: boolean) => void | Promise<void>): Promise<Note> {
    return this.withLock(path, async () => {
      const existing = await this.readNote(path)
      const note = existing ?? newNote()
      await edit(note, !!existing)
      await this.writeNote(path, note)
      return note
    })
  }

  // Ideas

  async readIdea(id: string): Promise<Idea | undefined> {
    const note = await this.readNote(this.ideaPath(id))
    return note ? toIdea(id, note) : undefined
  }

  /** All idea notes. Notes that cannot be read, or whose file name is not a slug, are reported in `errors`. */
  async listIdeas(): Promise<{ ideas: Idea[]; errors: ListError[] }> {
    const ideas: Idea[] = []
    const errors: ListError[] = []
    for (const file of await listMarkdown(this.ideasDir)) {
      const id = file.slice(0, -3)
      if (!isSlug(id)) {
        errors.push({ file: `ideas/${file}`, message: "file name is not a slug (a-z, 0-9, hyphens); not used" })
        continue
      }
      try {
        const idea = await this.readIdea(id)
        if (idea) ideas.push(idea)
      } catch (error) {
        errors.push({ file: `ideas/${file}`, message: (error as Error).message })
      }
    }
    return { ideas, errors }
  }

  /**
   * Creates or updates an idea note. On an existing note, `requires` and `about` are merged, Claim and Why are only
   * filled when empty (unless `replace`), and unknown frontmatter keys, other sections and the learner's own text
   * stay as they are. "Builds on" links only point at ideas that have a note, so every link resolves.
   */
  async upsertIdea(patch: IdeaPatch, now: Date): Promise<{ idea: Idea; created: boolean }> {
    for (const id of [...(patch.requires ?? []), ...(patch.about ?? [])]) assertSlug(id, "linked idea id")
    let created = false
    const note = await this.updateNote(this.ideaPath(patch.id), async (note, exists) => {
      created = !exists
      const data = getData(note)
      const requires = [...new Set([...slugList(data.requires), ...(patch.requires ?? [])])].filter((id) => id !== patch.id)
      const about = [...new Set([...slugList(data.about), ...(patch.about ?? [])])].filter((id) => id !== patch.id)
      if (!exists) {
        setField(note, "id", patch.id)
        setField(note, "topic", patch.topic)
        setField(note, "kind", patch.kind ?? "proposition")
        setField(note, "requires", requires, { flow: true })
        if (about.length) setField(note, "about", about, { flow: true })
        setField(note, "created", today(now))
        setField(note, "source", patch.source)
        note.body = ["Claim", "Why", "Known misconceptions", "Asked before"].map((h) => `## ${h}\n`).join("\n")
      } else {
        if (patch.topic !== undefined && !note.doc.has("topic")) setField(note, "topic", patch.topic)
        if (patch.kind !== undefined && !note.doc.has("kind")) setField(note, "kind", patch.kind)
        if (patch.requires?.length) setField(note, "requires", requires, { flow: true })
        if (patch.about?.length) setField(note, "about", about, { flow: true })
      }
      if (patch.srs) mergeField(note, "srs", { ...patch.srs })

      const fill = (heading: string, value: string | undefined) => {
        if (value === undefined) return
        if (patch.replace || !(getSection(note.body, heading) ?? "").trim()) note.body = setSection(note.body, heading, value)
      }
      fill("Claim", patch.claim)
      const currentWhy = getSection(note.body, "Why") ?? ""
      const why = patch.why !== undefined && (patch.replace || !currentWhy.replace(BUILDS_ON_OWNED, "").trim()) ? patch.why : currentWhy
      const linked: string[] = []
      for (const id of requires) if (await this.hasIdea(id)) linked.push(id)
      const nextWhy = withBuildsOn(why, linked)
      if (nextWhy !== currentWhy) note.body = setSection(note.body, "Why", nextWhy)
      if (patch.misconceptions !== undefined) {
        const current = (getSection(note.body, "Known misconceptions") ?? "").trim()
        const addition = patch.misconceptions.trim()
        if (addition && !current.includes(addition)) {
          note.body = setSection(note.body, "Known misconceptions", current ? `${current}\n${addition}` : addition)
        }
      }
    })
    return { idea: toIdea(patch.id, note), created }
  }

  /**
   * Reads, changes and writes a card's FSRS state as one step under the note's lock, so two reviews of the same card
   * cannot overwrite each other. `change` may return undefined to leave the card as it is.
   */
  async updateSrs(id: string, change: (srs: Srs | undefined, idea: Idea) => Srs | undefined): Promise<{ before?: Srs; after?: Srs }> {
    const path = this.ideaPath(id)
    return this.withLock(path, async () => {
      const note = await this.readNote(path)
      if (!note) throw new Error(`Unknown idea "${id}"`)
      const idea = toIdea(id, note)
      const after = change(idea.srs, idea)
      if (after) {
        mergeField(note, "srs", { ...after })
        await this.writeNote(path, note)
      }
      return { ...(idea.srs ? { before: idea.srs } : {}), ...(after ? { after } : {}) }
    })
  }

  /** Writes FSRS state key by key, so unknown keys and comments inside `srs` survive. */
  async setSrs(id: string, srs: Srs): Promise<void> {
    await this.updateExisting(id, (note) => mergeField(note, "srs", { ...srs }))
  }

  /**
   * Records a question stem so later reviews avoid the same wording. Keeps the newest `limit` stems and any
   * non-list text the learner wrote in the section.
   */
  async addAskedBefore(id: string, stem: string, limit = ASKED_BEFORE_LIMIT): Promise<void> {
    const clean = stem.replace(/\s+/g, " ").trim()
    if (!clean) return
    await this.updateExisting(id, (note) => {
      const { items, other } = splitList(getSection(note.body, "Asked before"))
      const next = [...items.filter((item) => item !== clean), clean].slice(-limit)
      note.body = setSection(note.body, "Asked before", [...other, ...next.map((item) => `- ${item}`)].join("\n"))
    })
  }

  private async updateExisting(id: string, edit: (note: Note) => void) {
    const path = this.ideaPath(id)
    await this.withLock(path, async () => {
      const note = await this.readNote(path)
      if (!note) throw new Error(`Unknown idea "${id}"`)
      edit(note)
      await this.writeNote(path, note)
    })
  }

  // Topics

  async readTopic(id: string): Promise<Topic | undefined> {
    const note = await this.readNote(this.topicPath(id))
    return note ? toTopic(id, note) : undefined
  }

  async listTopics(): Promise<{ topics: Topic[]; errors: ListError[] }> {
    const topics: Topic[] = []
    const errors: ListError[] = []
    for (const file of await listMarkdown(this.topicsDir)) {
      const id = file.slice(0, -3)
      if (!isSlug(id)) {
        errors.push({ file: `topics/${file}`, message: "file name is not a slug (a-z, 0-9, hyphens); not used" })
        continue
      }
      try {
        const topic = await this.readTopic(id)
        if (topic) topics.push(topic)
      } catch (error) {
        errors.push({ file: `topics/${file}`, message: (error as Error).message })
      }
    }
    return { topics, errors }
  }

  async updateTopic(id: string, patch: TopicPatch, now: Date): Promise<Topic> {
    const note = await this.updateNote(this.topicPath(id), (note, exists) => {
      if (!exists) {
        setField(note, "id", id)
        setField(note, "created", today(now))
        note.body = ["Goal", "Assessment", "Plan", "Ideas"].map((h) => `## ${h}\n`).join("\n")
        note.body = setSection(note.body, "Goal", patch.goal ?? id)
      } else if (patch.goal !== undefined) {
        note.body = setSection(note.body, "Goal", patch.goal)
      }
      for (const [key, value] of Object.entries(patch.fields ?? {})) setField(note, key, value)
      for (const [heading, content] of Object.entries(patch.sections ?? {})) {
        note.body = setSection(note.body, heading, content)
      }
      if (patch.addIdeas?.length) {
        const lines = (getSection(note.body, "Ideas") ?? "").split("\n").filter((line) => line.trim())
        for (const ideaId of patch.addIdeas) {
          assertSlug(ideaId, "idea id")
          if (!lines.some((line) => line.includes(`(../ideas/${ideaId}.md)`))) {
            lines.push(`- [${ideaLabel(ideaId)}](../ideas/${ideaId}.md)`)
          }
        }
        note.body = setSection(note.body, "Ideas", lines.join("\n"))
      }
    })
    return toTopic(id, note)
  }

  // Sessions

  sessionNotePath(date: string, topic: string, kind: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid session date "${date}"`)
    assertSlug(topic, "topic id")
    assertSlug(kind, "session kind")
    return join(this.sessionsDir, `${date}-${topic}-${kind}.md`)
  }

  /** Appends a Markdown block to the session note of that day, topic and kind; creates it on first use. */
  async appendSession(header: { sessionID: string; topic: string; kind: string; date: string }, block: string) {
    const path = this.sessionNotePath(header.date, header.topic, header.kind)
    await this.updateNote(path, (note, exists) => {
      if (!exists) {
        setField(note, "topic", header.topic)
        setField(note, "kind", header.kind)
        setField(note, "date", header.date)
        setField(note, "sessions", [header.sessionID], { flow: true })
        note.body = `# ${ideaLabel(header.topic)}: ${header.kind} (${header.date})\n`
      } else {
        const sessions = getData(note).sessions
        const list = Array.isArray(sessions) ? sessions : []
        if (!list.includes(header.sessionID)) setField(note, "sessions", [...list, header.sessionID], { flow: true })
      }
      note.body = `${note.body.trimEnd()}\n\n${block.trim()}\n`
    })
    return path
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".md") && !file.startsWith(".")).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

function toIdea(id: string, note: Note): Idea {
  const data = getData(note)
  const kind = (["proposition", "chain", "misconception"] as const).find((k) => k === data.kind) ?? "proposition"
  const srs = readSrs(data.srs)
  return {
    id,
    ...(typeof data.topic === "string" ? { topic: data.topic } : {}),
    kind,
    requires: slugList(data.requires),
    about: slugList(data.about),
    ...(data.created !== undefined ? { created: String(data.created) } : {}),
    ...(typeof data.source === "string" ? { source: data.source } : {}),
    ...(srs ? { srs } : {}),
    claim: getSection(note.body, "Claim") ?? "",
    why: getSection(note.body, "Why") ?? "",
    misconceptions: getSection(note.body, "Known misconceptions") ?? "",
    askedBefore: splitList(getSection(note.body, "Asked before")).items,
  }
}

function toTopic(id: string, note: Note): Topic {
  const data = getData(note)
  const ideas = [...(getSection(note.body, "Ideas") ?? "").matchAll(/\(\.\.\/ideas\/([a-z0-9-]+)\.md\)/g)]
    .map((m) => m[1]!)
    .filter(isSlug)
  const plan = getSection(note.body, "Plan")
  const assessment = getSection(note.body, "Assessment")
  // The Goal section is what the learner sees and edits; the frontmatter `goal` is only a fallback.
  const goal = getSection(note.body, "Goal") || (typeof data.goal === "string" ? data.goal : id)
  return {
    id,
    goal,
    ...(data.created !== undefined ? { created: String(data.created) } : {}),
    data,
    ...(assessment ? { assessment } : {}),
    ...(plan ? { plan } : {}),
    ideas,
  }
}
