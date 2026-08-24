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
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Codex's home, honoring `CODEX_HOME` exactly as Codex itself does. Shared by
 * the installer and backfill so both resolve the same location — otherwise a
 * custom `CODEX_HOME` installs live hooks in one place while backfill scans
 * another.
 */
export function codexHome(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
}

/** The flat rollout store Codex writes every thread into. */
export function codexSessionsRoot(): string {
  return join(codexHome(), 'sessions')
}

/** Read at most this many bytes from a transcript head. The session-meta line
 * sits at the very top, so we never slurp a multi-MB transcript to group it. */
const HEADER_BYTES = 64 * 1024

/** Read only the first `bytes` of a file — a bounded alternative to
 * `readFile(...).slice(...)`, which reads the whole file into memory first. */
async function readHead(path: string, bytes = HEADER_BYTES): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Map with bounded concurrency, so a session sweep never opens thousands of
 * file handles at once (the unbounded `Promise.all` this replaces spiked IO). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

const READ_CONCURRENCY = 8

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
    head = await readHead(path)
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
  const threads = await mapLimit(paths, READ_CONCURRENCY, readCodexThread)
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

/**
 * The full session plan for a just-ended root Codex transcript: the root as
 * `primary`, its sub-agent siblings as `extras`, and the root's id as
 * `sessionKey`.
 *
 * A `SessionEnd` hook hands over only the root thread, but the server groups a
 * session's files into one upload bundle — so a live upload must carry the
 * sub-agents as `extras` (as `backfill` does) or their spend, tool calls, and
 * transcript content are lost until a later backfill. `groupCodexSessions`
 * relates flat thread files by content ids; we only supply the candidates. A
 * sub-agent starts during the parent, so it lives in the root's `YYYY/MM/DD`
 * directory or a later one — never earlier — which is what bounds the scan to
 * the days since the session began (one day for the overwhelming common case).
 */
export async function codexSessionPlan(rootPath: string): Promise<CodexSession> {
  const candidates = await candidateSiblings(rootPath)
  const groups = await groupCodexSessions(candidates.length ? candidates : [rootPath])
  const ours = groups.find((g) => g.primary === rootPath)
  return ours ?? { primary: rootPath, extras: [], sessionKey: null }
}

/** The root's day directory plus every later one, for the `<sessions>/YYYY/MM/DD`
 * layout; falls back to just the root's directory for anything unexpected. */
async function candidateSiblings(rootPath: string): Promise<string[]> {
  const dayDir = dirname(rootPath)
  const dd = basename(dayDir)
  const mm = basename(dirname(dayDir))
  const yyyy = basename(dirname(dirname(dayDir)))
  if (!/^\d{4}$/.test(yyyy) || !/^\d\d$/.test(mm) || !/^\d\d$/.test(dd)) return jsonlIn(dayDir)

  const root = dirname(dirname(dirname(dayDir)))
  const rootKey = `${yyyy}/${mm}/${dd}`
  const days: string[] = []
  for (const y of await dirsIn(root)) {
    if (y < yyyy) continue
    for (const m of await dirsIn(join(root, y)))
      for (const d of await dirsIn(join(root, y, m))) if (`${y}/${m}/${d}` >= rootKey) days.push(join(root, y, m, d))
  }
  const files: string[] = []
  for (const day of days.sort()) files.push(...(await jsonlIn(day)))
  return files
}

async function dirsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function jsonlIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n))
  } catch {
    return []
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
