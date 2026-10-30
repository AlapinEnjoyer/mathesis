import { Document, isMap, isSeq, parseDocument } from "yaml"

/**
 * A Markdown note with YAML frontmatter. The frontmatter stays a yaml Document so that comments, key order and keys
 * Mathesis does not know survive a read-modify-write cycle. The body is kept with `\n` line endings; a byte-order
 * mark and CRLF line endings of the original file are restored on write.
 */
export interface Note {
  doc: Document
  body: string
  bom?: boolean
  crlf?: boolean
}

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/

export function parseNote(text: string): Note {
  const bom = text.startsWith("﻿")
  const crlf = /\r\n/.test(text)
  const normalized = (bom ? text.slice(1) : text).replace(/\r\n/g, "\n")
  const style = { ...(bom ? { bom } : {}), ...(crlf ? { crlf } : {}) }
  const match = FRONTMATTER.exec(normalized)
  if (!match) return { doc: new Document({}), body: normalized, ...style }
  const doc = parseDocument(match[1] ?? "")
  if (doc.errors.length > 0) throw new Error(`Invalid frontmatter: ${doc.errors[0]!.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  if (!isMap(doc.contents)) throw new Error("Frontmatter must be a YAML mapping")
  return { doc, body: normalized.slice(match[0].length), ...style }
}

export function serializeNote(note: Note): string {
  const yaml = note.doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd()
  const body = note.body.replace(/^\n+/, "")
  const text = `---\n${yaml}\n---\n\n${body.endsWith("\n") || body === "" ? body : body + "\n"}`
  return `${note.bom ? "﻿" : ""}${note.crlf ? text.replace(/\n/g, "\r\n") : text}`
}

export function newNote(): Note {
  return { doc: new Document({}), body: "" }
}

export function getData(note: Note): Record<string, unknown> {
  const data = note.doc.toJS() as unknown
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
}

/** Sets a top-level key. `flow` writes a mapping or sequence on one line, e.g. `srs: {due: ..., reps: 3}`. */
export function setField(note: Note, key: string, value: unknown, options: { flow?: boolean } = {}) {
  if (value === undefined) {
    note.doc.delete(key)
    return
  }
  const node = note.doc.createNode(value)
  if (options.flow && (isMap(node) || isSeq(node))) node.flow = true
  note.doc.set(key, node)
}

/**
 * Updates the keys of a mapping field one by one, so that keys Mathesis does not know and comments inside it
 * survive. Creates the field (as a flow mapping) when it is missing or not a mapping.
 */
export function mergeField(note: Note, key: string, values: Record<string, unknown>) {
  const current = note.doc.get(key, true)
  if (!isMap(current)) {
    setField(note, key, values, { flow: true })
    return
  }
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) current.delete(k)
    else current.set(k, note.doc.createNode(v))
  }
}

interface Section {
  heading: string
  start: number
  end: number
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** Tracks fenced code blocks line by line: returns true while inside a fence (including its delimiter lines). */
function fenceTracker() {
  let fence: string | undefined
  return (line: string): boolean => {
    const match = FENCE.exec(line)
    if (!match) return !!fence
    const marker = match[1]!
    if (!fence) {
      fence = marker
      return true
    }
    if (marker[0] === fence[0] && marker.length >= fence.length && !match[2]!.trim()) fence = undefined
    return true
  }
}

/** `## Heading` lines outside fenced code blocks. Closing hashes (`## Claim ##`) are ignored. */
function sections(body: string): Section[] {
  const result: Section[] = []
  const inFence = fenceTracker()
  let offset = 0
  for (const line of body.split("\n")) {
    if (!inFence(line)) {
      const heading = /^## +(.+?)(?:\s+#+)?\s*$/.exec(line)
      if (heading) {
        if (result.length > 0) result[result.length - 1]!.end = offset
        result.push({ heading: heading[1]!.trim(), start: offset, end: body.length })
      }
    }
    offset += line.length + 1
  }
  return result
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Returns the text under `## heading` (trimmed), or undefined when the section is missing. */
export function getSection(body: string, heading: string): string | undefined {
  const section = sections(body).find((s) => same(s.heading, heading))
  if (!section) return undefined
  return body.slice(section.start, section.end).replace(/^## .*\n?/, "").trim()
}

/** Level-1 and level-2 headings in written content would split the note on the next read; demote them. */
function demoteHeadings(content: string): string {
  const inFence = fenceTracker()
  return content
    .split("\n")
    .map((line) => (!inFence(line) && /^#{1,2} /.test(line) ? `###${line.replace(/^#+/, "")}` : line))
    .join("\n")
}

/**
 * Replaces the text under `## heading`, keeping every other section and any text before the first heading.
 * A missing section is appended at the end. When the heading occurs twice, the first one is edited.
 */
export function setSection(body: string, heading: string, content: string): string {
  const text = demoteHeadings(content.trim())
  const block = `## ${heading}\n${text ? text + "\n" : ""}`
  const section = sections(body).find((s) => same(s.heading, heading))
  if (!section) {
    const base = body.trimEnd()
    return `${base ? base + "\n\n" : ""}${block}`
  }
  const before = body.slice(0, section.start)
  const after = body.slice(section.end)
  return `${before}${block}${after ? "\n" + after.replace(/^\n+/, "") : ""}`
}

/** Splits a section into its bullet items and every other line (text the learner wrote). */
export function splitList(text: string | undefined): { items: string[]; other: string[] } {
  const items: string[] = []
  const other: string[] = []
  for (const line of (text ?? "").split("\n")) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim()
    if (item) items.push(item)
    else if (line.trim()) other.push(line)
  }
  return { items, other }
}

/** Parses a Markdown bullet list into its items. */
export function listItems(text: string | undefined): string[] {
  return splitList(text).items
}
