/**
 * Grouping Codex transcripts into logical sessions (for backfill).
 *
 * Claude Code co-locates a session's files — the parent owns a directory, and
 * everything beneath it belongs to that session — so the layout *is* the
 * grouping. Codex writes every thread as a flat file in `~/.codex/sessions`,
 * related only by ids inside the content. There is no layout to read.
 *
 * So this reads the two fields that carry the relationship (`isSubagent` /
 * `forkedFromId`): a sub-agent folds into its root ancestor, while a `/fork`
 * carries a parent id but is its own top-level session.
 *
 * A head-scan, not a parse: this runs over every Codex transcript a developer
 * owns and needs only the session-meta line near the top. It mirrors what
 * `sessionKeyOf` already does for Claude Code.
 */
import { readFile } from 'node:fs/promises'

export interface CodexThread {
  path: string
  id: string | null
  /** True when this thread is a sub-agent, which folds into its parent. */
  isSubagent: boolean
  /** Parent thread id, if any. Present on forks too — only sub-agents fold. */
  parentId: string | null
}

/** Read the grouping fields from a Codex transcript's session-meta line. */
export async function readCodexThread(path: string): Promise<CodexThread> {
  let head: string
  try {
    head = (await readFile(path, 'utf8')).slice(0, 64 * 1024)
  } catch {
    return { path, id: null, isSubagent: false, parentId: null }
  }
  for (const line of head.split('\n').slice(0, 10)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // truncated final line of the slice
    }
    if (!parsed || typeof parsed !== 'object') continue
    const outer = parsed as Record<string, unknown>
    const payload = (outer.payload && typeof outer.payload === 'object' ? outer.payload : outer) as Record<string, unknown>
    if (!('id' in payload) && !('thread_source' in payload)) continue

    const source = obj(payload.source)
    const spawn = obj(obj(source.subagent).thread_spawn)
    return {
      path,
      id: str(payload.id),
      isSubagent: payload.thread_source === 'subagent',
      parentId: str(payload.forked_from_id) ?? str(payload.parent_thread_id) ?? str(spawn.parent_thread_id),
    }
  }
  return { path, id: null, isSubagent: false, parentId: null }
}

export interface CodexSession {
  /** The root thread's file — the bundle's primary. */
  primary: string
  /** Sub-agent thread files that fold into it. */
  extras: string[]
  sessionKey: string | null
}

/**
 * Fold Codex transcripts into logical sessions.
 *
 * Walk a sub-agent's parent chain to its root ancestor, guarding against cycles
 * and self-references. A sub-agent whose parent is not among the given files
 * stays on its own — the same fallback taken when a parent file is absent.
 */
export async function groupCodexSessions(paths: string[]): Promise<CodexSession[]> {
  const threads = await Promise.all(paths.map(readCodexThread))
  const byId = new Map<string, CodexThread>()
  for (const t of threads) if (t.id) byId.set(t.id, t)

  const rootOf = (t: CodexThread): CodexThread => {
    if (!t.isSubagent) return t
    const seen = new Set<string>()
    let cur = t
    while (cur.parentId && cur.id && !seen.has(cur.id)) {
      seen.add(cur.id)
      const parent = byId.get(cur.parentId)
      // Absent parent, or a thread that names itself — stop and treat the
      // current thread as its own root.
      if (!parent || parent === cur) break
      cur = parent
    }
    return cur
  }

  const groups = new Map<string, { primary: CodexThread; extras: string[] }>()
  for (const t of threads) {
    const root = rootOf(t)
    const key = root.path
    const group = groups.get(key) ?? { primary: root, extras: [] }
    if (t.path !== root.path) group.extras.push(t.path)
    groups.set(key, group)
  }

  return [...groups.values()].map((g) => ({
    primary: g.primary.path,
    extras: g.extras.sort(),
    sessionKey: g.primary.id,
  }))
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
