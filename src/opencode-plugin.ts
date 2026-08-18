// Tuneloop plugin for OpenCode — bundled from src (tsup) so it reuses the shared
// git/skills/machine-id modules instead of hand-inlined duplicates. Server URL and
// token are baked in at generation time (see generate/opencode.ts). Ships as a
// single self-contained .js; `bun:sqlite` stays external (Bun provides it).
//
// NOTE: server/token are referenced ONLY as these string constants (never
// interpolated into a template literal), so after bundling they remain replaceable
// string literals for the generator's placeholder substitution.
const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { gitConfigEmail, repoContext } from './git.js'
import { machineId } from './machine-id.js'
import { collectSkills, uploadSkills } from './skills.js'

const CLIENT_VERSION = '0.1.0'

async function send(body: Buffer, format: string, cwd: string | null, sessionKey: string | null, sourcePath: string | null): Promise<void> {
  const contentHash = createHash('sha256').update(body).digest('hex')
  const gz = gzipSync(body)
  const repo = await repoContext(cwd ?? undefined)
  const email = (await gitConfigEmail()) ?? null
  const gitAuthorEmail = (await gitConfigEmail(cwd ?? undefined)) ?? null

  const meta = {
    format,
    contentHash,
    bytes: body.length,
    userEmail: email,
    machineId: machineId(),
    gitRemote: repo.remote,
    gitBranch: repo.branch,
    repo: repo.repo,
    gitAuthorEmail,
    gitToplevel: repo.toplevel,
    // Checkout roots, so the server can map a file edited outside gitToplevel.
    gitWorktrees: repo.worktrees,
    cwd,
    sourcePath,
    sessionKey: sessionKey ?? null,
    fileCount: 1,
    clientVersion: CLIENT_VERSION,
  }

  const form = new FormData()
  form.set('meta', JSON.stringify(meta))
  form.set('transcript', new Blob([gz], { type: 'application/gzip' }), 'transcript.gz')

  const res = await fetch(TUNELOOP_SERVER + '/api/ingest/transcript', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TUNELOOP_TOKEN },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error('upload rejected: ' + res.status + ' ' + text.slice(0, 200))
  }
}

function findDb(): string | null {
  // OpenCode keeps its data under $XDG_DATA_HOME (default ~/.local/share).
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const p = join(dataHome, 'opencode', 'opencode.db')
  return existsSync(p) ? p : null
}

async function uploadSession(sessionId: string): Promise<void> {
  let cwd: string | null = null

  // Transcript upload — best-effort and INDEPENDENT of the skills report below, so a
  // rejected transcript (e.g. a server that doesn't accept the opencode-raw format)
  // OR a missing database can't suppress the skills inventory.
  const dbPath = findDb()
  if (dbPath) {
    const db = new Database(dbPath, { readonly: true })
    try {
      db.run('PRAGMA query_only = true')
      const session = db
        .query(
          'SELECT s.id, s.parent_id, s.directory, s.title, s.agent, s.model, s.version, ' +
            's.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, ' +
            's.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated, ' +
            'w.branch AS branch ' +
            'FROM session s LEFT JOIN workspace w ON w.id = s.workspace_id WHERE s.id = ?',
        )
        .get(sessionId) as Record<string, unknown> | undefined
      if (session) {
        cwd = (session.directory as string) || null
        const messages = db.query('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(sessionId)
        const parts = db.query('SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC').all(sessionId)
        const bundle = { bundleVersion: 1, sessionKey: session.id, primary: 'session.json', files: [{ name: 'session.json', content: JSON.stringify({ session, messages, parts }) }] }
        const body = Buffer.from(JSON.stringify(bundle), 'utf8')
        try {
          await send(body, 'opencode-raw', cwd, session.id as string, dbPath)
        } catch {
          /* transcript upload is best-effort */
        }
      }
    } finally {
      db.close()
    }
  }

  // Installed-skill inventory (OpenCode scope), independent + best-effort.
  try {
    const email = (await gitConfigEmail()) ?? null
    const locations = await collectSkills('opencode', cwd ?? undefined)
    await uploadSkills(TUNELOOP_SERVER, TUNELOOP_TOKEN, email, locations)
  } catch {
    /* skills report is strictly best-effort */
  }
}

const plugin = async () => {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === 'session.status' && event.properties?.status?.type === 'idle' && event.properties?.sessionID) {
        const id: string = event.properties.sessionID
        clearTimeout(pending.get(id))
        pending.set(
          id,
          setTimeout(() => {
            pending.delete(id)
            uploadSession(id).catch(() => {})
          }, 10_000),
        )
      }
    },
  }
}

// File-based plugins require id + server as the default export.
export default { id: 'tuneloop', server: plugin }
