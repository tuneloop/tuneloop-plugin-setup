/**
 * Collect the shell-edit events the pre/post Bash hooks spooled for a session
 * (see shell-edit-entry.ts) into one `shell-edits.json` sidecar the uploader
 * attaches to the transcript bundle. Events only exist for Bash calls that
 * actually changed the working tree — ~4 per session, measured — so an empty
 * directory is the common case and yields no sidecar at all.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

/** After a successful upload the events are on the server — clear the spool
 *  (a resumed session re-captures; stale pre-* scratch goes with it). */
export async function clearShellEdits(sessionId: string): Promise<void> {
  try {
    await rm(shellEditsDir(sessionId), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
