/**
 * The Cursor hook entry point — ONE script, three jobs, selected by argv:
 *
 *   <event-name>       record: write this hook's stdin payload into the spool
 *   __flush <conv>     bundle a conversation's spool + Cursor's transcript
 *                      files and upload them as `cursor-hooks-v1`
 *   __idle <conv>      detached timer: wait out the idle window, then flush
 *                      if the conversation stayed quiet
 *
 * Design constraints (see cursor-adapter-design.md in tuneloop-enterprise):
 * - Recording must be milliseconds and can NEVER fail a session: one file per
 *   event (hooks are concurrent processes; big appends interleave), always
 *   exit 0.
 * - Uploads happen when a conversation goes IDLE, not per turn — otherwise
 *   every turn re-runs server-side enrichment. Triggers: sessionEnd (window
 *   closed), a detached idle timer spawned on each `stop`, and a throttled
 *   sweep that any hook invocation may run for conversations left behind.
 * - Flush work runs in a DETACHED child so the hook process itself exits
 *   instantly; a hung network can never stall Cursor.
 */
const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { uploadBundle } from '../upload.js'

const SPOOL = process.env.TUNELOOP_CURSOR_SPOOL ?? join(homedir(), '.tuneloop', 'cursor', 'spool')
const IDLE_MS = envNum('TUNELOOP_CURSOR_IDLE_MS', 15 * 60_000)
const SWEEP_EVERY_MS = envNum('TUNELOOP_CURSOR_SWEEP_MS', 60_000)
const PURGE_AFTER_MS = 30 * 24 * 3_600_000

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

async function main(): Promise<void> {
  const arg = process.argv[2] ?? ''
  if (arg === '__flush') return flush(process.argv[3] ?? '')
  if (arg === '__idle') return idleThenFlush(process.argv[3] ?? '')
  await record(arg)
}

// ── Record ───────────────────────────────────────────────────────────────────

async function record(eventArg: string): Promise<void> {
  const payload = await readStdinJson()
  if (!payload) return
  const event = eventArg || String(payload.hook_event_name ?? 'unknown')
  const conv = typeof payload.conversation_id === 'string' ? payload.conversation_id : null
  if (!conv || !/^[0-9a-f-]{8,64}$/i.test(conv)) return // no identity → nothing to group under

  const dir = join(SPOOL, conv)
  mkdirSync(dir, { recursive: true })
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}-${event}.json`
  writeFileSync(join(dir, name), JSON.stringify({ capturedAt: new Date().toISOString(), payload }))

  // Only conversations a human actually prompted are flushable on their own;
  // subagent conversations get pulled into their parent's bundle instead.
  if (event === 'beforeSubmitPrompt') writeFileSync(join(dir, '.primary'), '')

  if (event === 'sessionEnd') spawnDetached('__flush', conv)
  else if (event === 'stop') spawnDetached('__idle', conv)

  maybeSweep()
}

// ── Idle timer (detached) ────────────────────────────────────────────────────

async function idleThenFlush(conv: string): Promise<void> {
  if (!conv) return
  await new Promise((r) => setTimeout(r, IDLE_MS + 5_000))
  const newest = newestEventAt(join(SPOOL, conv))
  if (newest !== null && Date.now() - newest >= IDLE_MS) await flush(conv)
}

// ── Sweep (throttled; runs inside any record invocation) ────────────────────

function maybeSweep(): void {
  try {
    const stamp = join(SPOOL, '.sweep')
    try {
      if (Date.now() - statSync(stamp).mtimeMs < SWEEP_EVERY_MS) return
    } catch {
      /* first sweep */
    }
    writeFileSync(stamp, '')
    for (const entry of readdirSync(SPOOL, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(SPOOL, entry.name)
      const newest = newestEventAt(dir)
      const uploaded = exists(join(dir, '.last-upload'))
      if (newest === null) {
        // Nothing pending. A long-uploaded conversation eventually ages out.
        if (uploaded && Date.now() - dirMtime(dir) > PURGE_AFTER_MS) rmSync(dir, { recursive: true, force: true })
        continue
      }
      if (exists(join(dir, '.primary')) && Date.now() - newest >= IDLE_MS) spawnDetached('__flush', entry.name)
    }
  } catch {
    /* sweeping is best-effort by definition */
  }
}

// ── Flush ────────────────────────────────────────────────────────────────────

async function flush(conv: string): Promise<void> {
  if (!conv) return
  const dir = join(SPOOL, conv)
  if (!(await lock(dir))) return
  try {
    const own = await gatherEvents(dir)
    if (own.lines.length === 0) return

    // Latest observed context wins (workspace/transcript can only get fresher).
    let transcriptPath: string | null = null
    let cwd: string | null = null
    let userEmail: string | null = null
    for (const line of own.lines) {
      const p = parseLine(line)?.payload
      if (!p) continue
      if (typeof p.transcript_path === 'string') transcriptPath = p.transcript_path
      if (Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === 'string') cwd = p.workspace_roots[0]
      if (typeof p.user_email === 'string') userEmail = p.user_email
    }

    // Cursor files each subagent's transcript inside the parent's directory —
    // that layout is the ONLY parent↔child link, so the flusher walks it to
    // pull the children's transcripts AND their spooled hook events into this
    // bundle. Child conversations never flush on their own (no `.primary`).
    const files: Array<{ name: string; content: string }> = []
    const childDirs: string[] = []
    let allLines = own.lines
    if (transcriptPath) {
      const transcript = await tryRead(transcriptPath)
      if (transcript !== null) files.push({ name: 'transcript.jsonl', content: transcript })
      const subDir = join(dirname(transcriptPath), 'subagents')
      for (const name of await tryReaddir(subDir)) {
        if (!name.endsWith('.jsonl')) continue
        const content = await tryRead(join(subDir, name))
        if (content !== null) files.push({ name: `subagents/${name}`, content })
        const childId = basename(name, '.jsonl')
        const childDir = join(SPOOL, childId)
        const child = await gatherEvents(childDir)
        if (child.lines.length > 0) {
          allLines = allLines.concat(child.lines)
          childDirs.push(childDir)
        }
      }
    }

    allLines.sort((a, b) => (parseLine(a)?.capturedAt ?? '').localeCompare(parseLine(b)?.capturedAt ?? ''))
    const events = [JSON.stringify({ cursorEvents: 1, conversationId: conv }), ...allLines].join('\n') + '\n'
    files.unshift({ name: 'events.jsonl', content: events })

    const bundle = { bundleVersion: 1, sessionKey: conv, primary: 'events.jsonl', files }

    // Skip when nothing changed since the last successful upload — a resumed
    // conversation that idles again without new content costs nothing.
    const fingerprint = hashOf(JSON.stringify(bundle))
    if ((await tryRead(join(dir, '.last-upload')))?.includes(fingerprint)) return

    await uploadBundle({
      server: TUNELOOP_SERVER,
      token: TUNELOOP_TOKEN,
      bundle,
      format: 'cursor-hooks-v1',
      sourcePath: transcriptPath ?? dir,
      cwd: cwd ?? undefined,
      // Hooks carry the Cursor ACCOUNT email — stronger identity than the
      // git-config fallback the other harnesses rely on.
      userEmail: userEmail ?? undefined,
      timeoutMs: 60_000,
    })

    await writeFile(join(dir, '.last-upload'), JSON.stringify({ fingerprint, at: new Date().toISOString() }))
    await compact(dir)
    for (const childDir of childDirs) await compact(childDir)
  } catch {
    // Upload failures are non-fatal: the spool keeps everything, and the next
    // idle sweep or sessionEnd retries.
  } finally {
    await unlock(dir)
  }
}

/**
 * A conversation's captured events = the compacted archive (prior flushes) plus
 * every per-event file since. Returned as raw NDJSON lines.
 */
async function gatherEvents(dir: string): Promise<{ lines: string[]; eventFiles: string[] }> {
  const lines: string[] = []
  const eventFiles: string[] = []
  const archived = await tryReadGz(join(dir, 'archive.jsonl.gz'))
  if (archived) for (const l of archived.split('\n')) if (l.trim()) lines.push(l)
  for (const name of (await tryReaddir(dir)).sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const content = await tryRead(join(dir, name))
    if (content?.trim()) {
      lines.push(content.trim())
      eventFiles.push(join(dir, name))
    }
  }
  return { lines, eventFiles }
}

/**
 * After a successful upload: fold the per-event files into one gzipped archive
 * (~4:1, thousands of small files collapse to one) and delete them. The archive
 * is KEPT, not discarded — a resumed conversation must re-bundle its full
 * history for the next upsert.
 */
async function compact(dir: string): Promise<void> {
  const { lines, eventFiles } = await gatherEvents(dir)
  if (eventFiles.length === 0) return
  const tmp = join(dir, 'archive.jsonl.gz.tmp')
  await writeFile(tmp, gzipSync(lines.join('\n') + '\n'))
  renameSync(tmp, join(dir, 'archive.jsonl.gz'))
  for (const f of eventFiles) await rm(f, { force: true })
}

// ── Small helpers ────────────────────────────────────────────────────────────

function spawnDetached(cmd: string, conv: string): void {
  try {
    const child = spawn(process.execPath, [process.argv[1]!, cmd, conv], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
  } catch {
    /* the sweep will catch it later */
  }
}

/** mkdir-as-mutex; a stale lock (crashed flusher) is stolen after 5 minutes. */
async function lock(dir: string): Promise<boolean> {
  const path = join(dir, '.lock')
  try {
    mkdirSync(path)
    return true
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > 300_000) {
        rmSync(path, { recursive: true, force: true })
        mkdirSync(path)
        return true
      }
    } catch {
      /* raced */
    }
    return false
  }
}

async function unlock(dir: string): Promise<void> {
  await rm(join(dir, '.lock'), { recursive: true, force: true })
}

function newestEventAt(dir: string): number | null {
  let newest: number | null = null
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const t = statSync(join(dir, name)).mtimeMs
      if (newest === null || t > newest) newest = t
    }
  } catch {
    return null
  }
  return newest
}

function dirMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return Date.now()
  }
}

function parseLine(line: string): { capturedAt?: string; payload?: Raw } | null {
  try {
    const v = JSON.parse(line) as Raw
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

async function readStdinJson(): Promise<Raw | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw) as Raw
  } catch {
    return null
  }
}

function hashOf(s: string): string {
  // FNV-1a over the bundle JSON — a change detector, not a security boundary
  // (the server computes the real sha256 content hash on receipt).
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16)
}

function envNum(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function tryReadGz(path: string): Promise<string | null> {
  try {
    return gunzipSync(await readFile(path)).toString('utf8')
  } catch {
    return null
  }
}

async function tryReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(() => {
    // A recorder problem must never interrupt the session it records.
    process.exitCode = 0
  })
