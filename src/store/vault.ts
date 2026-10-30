import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { readSrs, type Srs } from "../srs/fsrs.ts"
import { getData, getSection, listItems, newNote, parseNote, serializeNote, setField, setSection, type Note } from "./note.ts"

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ASKED_BEFORE_LIMIT = 10

export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, max).replace(/-+$/g, "") || "untitled"
}

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && SLUG.test(value)
}

function assertSlug(value: string, what: string) {
  if (!isSlug(value)) throw new Error(`Invalid ${what} "${value}": use lowercase letters, digits and single hyphens`)
}

export const today = (now: Date) => now.toISOString().slice(0, 10)

export type IdeaKind = "proposition" | "chain" | "misconception"

export interface Idea {
  id: string
  topic?: string
  kind: IdeaKind
  requires: string[]
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
  requires?: string[]
  source?: string
  claim?: string
  why?: string
  misconceptions?: string
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
  /** Extra frontmatter keys, e.g. the structured probe assessment. */
  fields?: Record<string, unknown>
  /** Markdown sections to replace, by heading. */
  sections?: Record<string, string>
  addIdeas?: string[]
}

const BUILDS_ON = /^Builds on: .*$/m
const ideaLabel = (id: string) => id.replace(/-/g, " ")

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

  /** Serializes read-modify-write cycles on one file inside this process. */
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

  private async writeNote(path: string, note: Note) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, serializeNote(note), "utf8")
      await rename(tmp, path)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }

  private async updateNote(path: string, edit: (note: Note, exists: boolean) => void): Promise<Note> {
    return this.withLock(path, async () => {
      const existing = await this.readNote(path)
      const note = existing ?? newNote()
      edit(note, !!existing)
      await this.writeNote(path, note)
      return note
    })
  }

  // Ideas

  async readIdea(id: string): Promise<Idea | undefined> {
    const note = await this.readNote(this.ideaPath(id))
    return note ? toIdea(id, note) : undefined
  }

  /** All idea notes. Notes that cannot be parsed are reported in `errors`, not thrown. */
  async listIdeas(): Promise<{ ideas: Idea[]; errors: { file: string; message: string }[] }> {
    const ideas: Idea[] = []
    const errors: { file: string; message: string }[] = []
    let files: string[]
    try {
      files = await readdir(this.ideasDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ideas, errors }
      throw error
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".md")) continue
      const id = file.slice(0, -3)
      if (!isSlug(id)) continue
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
   * Creates or updates an idea note. Only the given fields change; unknown frontmatter keys, other sections and the
   * learner's own text stay as they are.
   */
  async upsertIdea(patch: IdeaPatch, now: Date): Promise<{ idea: Idea; created: boolean }> {
    for (const id of patch.requires ?? []) assertSlug(id, "required idea id")
    let created = false
    const note = await this.updateNote(this.ideaPath(patch.id), (note, exists) => {
      created = !exists
      if (!exists) {
        setField(note, "id", patch.id)
        setField(note, "topic", patch.topic)
        setField(note, "kind", patch.kind ?? "proposition")
        setField(note, "requires", patch.requires ?? [], { flow: true })
        setField(note, "created", today(now))
        setField(note, "source", patch.source)
        note.body = ["Claim", "Why", "Known misconceptions", "Asked before"].map((h) => `## ${h}\n`).join("\n")
      } else {
        if (patch.topic !== undefined && !note.doc.has("topic")) setField(note, "topic", patch.topic)
        if (patch.kind !== undefined) setField(note, "kind", patch.kind)
        if (patch.requires !== undefined) setField(note, "requires", patch.requires, { flow: true })
      }
      if (patch.claim !== undefined) note.body = setSection(note.body, "Claim", patch.claim)
      const requires = patch.requires ?? (getData(note).requires as string[] | undefined) ?? []
      if (patch.why !== undefined || patch.requires !== undefined) {
        const why = patch.why ?? getSection(note.body, "Why") ?? ""
        note.body = setSection(note.body, "Why", withBuildsOn(why, requires))
      }
      if (patch.misconceptions !== undefined) {
        note.body = setSection(note.body, "Known misconceptions", patch.misconceptions)
      }
    })
    return { idea: toIdea(patch.id, note), created }
  }

  async setSrs(id: string, srs: Srs): Promise<void> {
    await this.updateExisting(id, (note) => setField(note, "srs", srs, { flow: true }))
  }

  /** Records a question stem so later reviews avoid the same wording. Keeps the newest `limit` stems. */
  async addAskedBefore(id: string, stem: string, limit = ASKED_BEFORE_LIMIT): Promise<void> {
    const clean = stem.replace(/\s+/g, " ").trim()
    if (!clean) return
    await this.updateExisting(id, (note) => {
      const items = listItems(getSection(note.body, "Asked before")).filter((item) => item !== clean)
      items.push(clean)
      note.body = setSection(
        note.body,
        "Asked before",
        items
          .slice(-limit)
          .map((item) => `- ${item}`)
          .join("\n"),
      )
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

  async listTopics(): Promise<Topic[]> {
    let files: string[]
    try {
      files = await readdir(this.topicsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const topics: Topic[] = []
    for (const file of files.sort()) {
      const id = file.endsWith(".md") ? file.slice(0, -3) : ""
      if (!isSlug(id)) continue
      try {
        const topic = await this.readTopic(id)
        if (topic) topics.push(topic)
      } catch {
        // a note the learner broke by hand; skip it
      }
    }
    return topics
  }

  async updateTopic(id: string, patch: TopicPatch, now: Date): Promise<Topic> {
    const note = await this.updateNote(this.topicPath(id), (note, exists) => {
      if (!exists) {
        setField(note, "id", id)
        setField(note, "goal", patch.goal ?? id)
        setField(note, "created", today(now))
        note.body = ["Goal", "Assessment", "Plan", "Ideas"].map((h) => `## ${h}\n`).join("\n")
        note.body = setSection(note.body, "Goal", patch.goal ?? id)
      } else if (patch.goal !== undefined) {
        setField(note, "goal", patch.goal)
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
          const link = `[${ideaLabel(ideaId)}](../ideas/${ideaId}.md)`
          if (!lines.some((line) => line.includes(`(../ideas/${ideaId}.md)`))) lines.push(`- ${link}`)
        }
        note.body = setSection(note.body, "Ideas", lines.join("\n"))
      }
    })
    return toTopic(id, note)
  }

  // Sessions

  sessionNotePath(date: string, topic: string, kind: string) {
    assertSlug(topic, "topic id")
    assertSlug(kind, "session kind")
    return join(this.sessionsDir, `${date}-${topic}-${kind}.md`)
  }

  /** Appends a Markdown block to a session note, creating it with frontmatter on first use. */
  async appendSession(
    path: string,
    header: { sessionID: string; topic: string; kind: string; date: string },
    block: string,
  ): Promise<void> {
    await this.updateNote(path, (note, exists) => {
      if (!exists) {
        setField(note, "topic", header.topic)
        setField(note, "kind", header.kind)
        setField(note, "date", header.date)
        setField(note, "sessions", [header.sessionID], { flow: true })
        note.body = `# ${ideaLabel(header.topic)}: ${header.kind} (${header.date})\n`
      } else {
        const sessions = (getData(note).sessions as unknown[] | undefined) ?? []
        if (!sessions.includes(header.sessionID)) {
          setField(note, "sessions", [...sessions, header.sessionID], { flow: true })
        }
      }
      note.body = `${note.body.trimEnd()}\n\n${block.trim()}\n`
    })
  }
}

function withBuildsOn(why: string, requires: string[]): string {
  const text = why.replace(BUILDS_ON, "").trim()
  if (requires.length === 0) return text
  const links = requires.map((id) => `[${ideaLabel(id)}](./${id}.md)`).join(", ")
  return `${text ? text + "\n\n" : ""}Builds on: ${links}`
}

function toIdea(id: string, note: Note): Idea {
  const data = getData(note)
  const kind = (["proposition", "chain", "misconception"] as const).find((k) => k === data.kind) ?? "proposition"
  const requires = Array.isArray(data.requires) ? data.requires.filter(isSlug) : []
  const srs = readSrs(data.srs)
  return {
    id,
    ...(typeof data.topic === "string" ? { topic: data.topic } : {}),
    kind,
    requires,
    ...(data.created !== undefined ? { created: String(data.created) } : {}),
    ...(typeof data.source === "string" ? { source: data.source } : {}),
    ...(srs ? { srs } : {}),
    claim: getSection(note.body, "Claim") ?? "",
    why: getSection(note.body, "Why") ?? "",
    misconceptions: getSection(note.body, "Known misconceptions") ?? "",
    askedBefore: listItems(getSection(note.body, "Asked before")),
  }
}

function toTopic(id: string, note: Note): Topic {
  const data = getData(note)
  const ideas = [...(getSection(note.body, "Ideas") ?? "").matchAll(/\(\.\.\/ideas\/([a-z0-9-]+)\.md\)/g)]
    .map((m) => m[1]!)
    .filter(isSlug)
  const plan = getSection(note.body, "Plan")
  const assessment = getSection(note.body, "Assessment")
  return {
    id,
    goal: typeof data.goal === "string" ? data.goal : (getSection(note.body, "Goal") ?? id),
    ...(data.created !== undefined ? { created: String(data.created) } : {}),
    data,
    ...(assessment ? { assessment } : {}),
    ...(plan ? { plan } : {}),
    ideas,
  }
}
