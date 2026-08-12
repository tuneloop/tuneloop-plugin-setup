import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { repoName } from './git.js'
import type { SessionBundle } from './bundle.js'

export function defaultOpencodeRoots(): string[] {
  return [join(homedir(), '.local', 'share', 'opencode')]
}

export function findOpencodeDb(roots?: string[]): string | null {
  for (const root of roots ?? defaultOpencodeRoots()) {
    const p = join(root, 'opencode.db')
    if (existsSync(p)) return p
  }
  return null
}

interface RawSession {
  id: string
  parent_id: string | null
  directory: string
  title: string
  agent: string | null
  model: string | null
  version: string
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_updated: number
  branch: string | null
}

export interface OpencodeBundle {
  dbPath: string
  bundles: SessionBundle[]
}

export async function collectOpencodeBundles(opts?: { dbPath?: string }): Promise<OpencodeBundle | null> {
  const dbPath = opts?.dbPath ?? findOpencodeDb()
  if (!dbPath) return null

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const bundles: SessionBundle[] = []
  try {
    db.exec('PRAGMA query_only = true')

    const sessions = db.prepare(
      'SELECT s.id, s.parent_id, s.directory, s.title, s.agent, s.model, s.version, ' +
        's.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, ' +
        's.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated, ' +
        'w.branch AS branch ' +
        'FROM session s LEFT JOIN workspace w ON w.id = s.workspace_id ' +
        'ORDER BY s.time_created ASC',
    ).all() as unknown as RawSession[]

    const stmtMessages = db.prepare(
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    const stmtParts = db.prepare(
      'SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )

    const repoCache = new Map<string, string | null>()

    for (const session of sessions) {
      const messages = stmtMessages.all(session.id)
      const parts = stmtParts.all(session.id)

      // Resolve repo name from the session's working directory.
      const cwd = session.directory || null
      if (cwd && !repoCache.has(cwd)) {
        repoCache.set(cwd, await repoName(cwd))
      }

      const payload = {
        session,
        messages,
        parts,
        repo: cwd ? repoCache.get(cwd) ?? null : null,
      }

      bundles.push({
        bundleVersion: 1,
        sessionKey: session.id,
        primary: 'session.json',
        files: [{ name: 'session.json', content: JSON.stringify(payload) }],
      })
    }
  } finally {
    db.close()
  }

  return { dbPath, bundles }
}
