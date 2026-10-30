import { Document, isMap, isSeq, parseDocument } from "yaml"

/**
 * A Markdown note with YAML frontmatter. The frontmatter stays a yaml Document so that comments, key order and keys
 * Mathesis does not know survive a read-modify-write cycle.
 */
export interface Note {
  doc: Document
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function parseNote(text: string): Note {
  const match = FRONTMATTER.exec(text)
  if (!match) return { doc: new Document({}), body: text }
  const doc = parseDocument(match[1] ?? "")
  if (doc.errors.length > 0) throw new Error(`Invalid frontmatter: ${doc.errors[0]!.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  if (!isMap(doc.contents)) throw new Error("Frontmatter must be a YAML mapping")
  return { doc, body: text.slice(match[0].length) }
}

export function serializeNote(note: Note): string {
  const yaml = note.doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd()
  const body = note.body.replace(/^\n+/, "")
  return `---\n${yaml}\n---\n\n${body.endsWith("\n") || body === "" ? body : body + "\n"}`
}

export function newNote(): Note {
  return { doc: new Document({}), body: "" }
}

export function getData(note: Note): Record<string, unknown> {
  const data = note.doc.toJS() as unknown
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
}

/** Sets a top-level key. `flow` writes a mapping or sequence on one line, e.g. `srs: { due: ..., reps: 3 }`. */
export function setField(note: Note, key: string, value: unknown, options: { flow?: boolean } = {}) {
  if (value === undefined) {
    note.doc.delete(key)
    return
  }
  const node = note.doc.createNode(value)
  if (options.flow && (isMap(node) || isSeq(node))) node.flow = true
  note.doc.set(key, node)
}

interface Section {
  heading: string
  start: number
  end: number
}

function sections(body: string): Section[] {
  const result: Section[] = []
  const regex = /^## +(.+?)[ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(body))) {
    if (result.length > 0) result[result.length - 1]!.end = match.index
    result.push({ heading: match[1]!, start: match.index, end: body.length })
  }
  return result
}

/** Returns the text under `## heading` (trimmed), or undefined when the section is missing. */
export function getSection(body: string, heading: string): string | undefined {
  const section = sections(body).find((s) => s.heading.toLowerCase() === heading.toLowerCase())
  if (!section) return undefined
  return body.slice(section.start, section.end).replace(/^## +.+\n?/, "").trim()
}

/**
 * Replaces the text under `## heading`, keeping every other section and any text before the first heading.
 * A missing section is appended at the end.
 */
export function setSection(body: string, heading: string, content: string): string {
  const block = `## ${heading}\n${content.trim() ? content.trim() + "\n" : ""}`
  const section = sections(body).find((s) => s.heading.toLowerCase() === heading.toLowerCase())
  if (!section) {
    const base = body.trimEnd()
    return `${base ? base + "\n\n" : ""}${block}`
  }
  const before = body.slice(0, section.start)
  const after = body.slice(section.end)
  return `${before}${block}${after ? "\n" + after.replace(/^\n+/, "") : ""}`
}

/** Parses a Markdown bullet list into its items. */
export function listItems(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => !!item)
}
