/**
 * Collect the shell-edit events the pre/post Bash hooks spooled for a session
 * (see shell-edit-entry.ts) into one `shell-edits.json` sidecar the uploader
 * attaches to the transcript bundle. Events only exist for Bash calls that
 * actually changed the working tree — ~4 per session, measured — so an empty
 * directory is the common case and yields no sidecar at all.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function shellEditsDir(sessionId: string): string {
  return join(homedir(), '.tuneloop', 'claude-code', 'shell-edits', sessionId)
}

/** Merge the session's event files into one sidecar in a temp dir; null when
 *  there are none. Best-effort throughout — capture must never block upload. */
export async function collectShellEdits(sessionId: string): Promise<string | null> {
  const dir = shellEditsDir(sessionId)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith('edit-') && n.endsWith('.json')).sort()
  } catch {
    return null
  }
  const events: unknown[] = []
  for (const name of names) {
    try {
      events.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch {
      /* half-written or corrupt event — skip it, keep the rest */
    }
  }
  if (events.length === 0) return null
  const out = join(await mkdtemp(join(tmpdir(), 'tuneloop-shell-edits-')), 'shell-edits.json')
  await writeFile(out, JSON.stringify({ version: 1, events }))
  return out
}

/**
 * Age-based retention, replacing clear-on-upload: a resumed session's next
 * SessionEnd must re-ship the SAME events (a later bundle without them would
 * lose the edits to any latest-wins consumer), a failed upload must leave the
 * spool for the next attempt or a backfill, and orphaned scratch (a hook
 * killed at its timeout never reaches its cleanup) must not accumulate
 * forever. So: session dirs idle past 14 days are removed whole; inside live
 * dirs, pre-/idx- scratch older than an hour is stale by definition.
 */
export async function sweepShellEdits(): Promise<void> {
  const root = join(homedir(), '.tuneloop', 'claude-code', 'shell-edits')
  const now = Date.now()
  let sessions: string[]
  try {
    sessions = await readdir(root)
  } catch {
    return
  }
  for (const sid of sessions) {
    const dir = join(root, sid)
    try {
      const st = await stat(dir)
      if (now - st.mtimeMs > 14 * 24 * 3600 * 1000) {
        await rm(dir, { recursive: true, force: true })
        continue
      }
      for (const name of await readdir(dir)) {
        if (!name.startsWith('pre-') && !name.startsWith('idx-')) continue
        const f = join(dir, name)
        if (now - (await stat(f)).mtimeMs > 3600 * 1000) await rm(f, { force: true })
      }
    } catch {
      /* raced with a writer — next sweep gets it */
    }
  }
}
