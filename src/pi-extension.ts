// Tuneloop upload extension for Pi — bundled from src (tsup) so it reuses the shared
// git/skills/machine-id modules instead of hand-inlined duplicates. Server URL and
// token are baked in at generation time (see generate/pi.ts). Emitted as a single
// self-contained file installed as `tuneloop-upload.ts` (bundled JS is valid TS, so
// Pi's loader handles it).
//
// server/token are referenced ONLY as these string constants (never interpolated),
// so after bundling they stay replaceable string literals for the generator.
const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { basename, dirname, join, relative, sep } from 'node:path'
import { accountEmail, gitConfigEmail, repoContext } from './git.js'
import { machineId } from './machine-id.js'
import { collectSkills, uploadSkills } from './skills.js'

const CLIENT_VERSION = '0.1.0'
const BUNDLE_VERSION = 1

interface BundleFile {
  name: string
  content: string
}

function sessionDir(transcriptPath: string): string {
  const name = basename(transcriptPath).replace(/\.jsonl$/, '')
  return join(dirname(transcriptPath), name)
}

async function walkSession(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkSession(full)))
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.meta.json'))) out.push(full)
  }
  return out
}

async function buildBundle(transcriptPath: string): Promise<{ bundleVersion: number; sessionKey: string | null; primary: string; files: BundleFile[] }> {
  const primary = basename(transcriptPath)
  const files: BundleFile[] = [{ name: primary, content: await readFile(transcriptPath, 'utf8') }]
  for (const full of await walkSession(sessionDir(transcriptPath))) {
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size === 0) continue
      files.push({ name: relative(dirname(transcriptPath), full).split(sep).join('/'), content: await readFile(full, 'utf8') })
    } catch {
      /* skip unreadable */
    }
  }

  let sessionKey: string | null = null
  const head = (files[0]?.content ?? '').slice(0, 64 * 1024)
  for (const line of head.split('\n').slice(0, 50)) {
    if (!line.includes('"sessionId"') && !line.includes('"id"')) continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
        sessionKey = parsed.sessionId
        break
      }
      if (parsed.type === 'session' && typeof parsed.id === 'string') {
        sessionKey = parsed.id
        break
      }
    } catch {
      /* not JSON */
    }
  }

  return { bundleVersion: BUNDLE_VERSION, sessionKey, primary, files }
}

function encodeBundle(bundle: { primary: string; files: BundleFile[] } & Record<string, unknown>): string {
  const rest = bundle.files.filter((f) => f.name !== bundle.primary).sort((a, b) => a.name.localeCompare(b.name))
  const head = bundle.files.filter((f) => f.name === bundle.primary)
  return JSON.stringify({ ...bundle, files: [...head, ...rest] })
}

function cwdFromContent(content: string): string | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"cwd"')) continue
    try {
      const parsed = JSON.parse(line)
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : parsed.payload?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      /* not JSON */
    }
  }
  return null
}

async function send(body: Buffer, format: string, cwd: string | null, sessionKey: string | null, sourcePath: string | null): Promise<void> {
  const contentHash = createHash('sha256').update(body).digest('hex')
  const gz = gzipSync(body)
  const repo = await repoContext(cwd ?? undefined)
  const email = await accountEmail()
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

export default function (pi: any): void {
  pi.on('session_shutdown', async (_event: any, ctx: any) => {
    let cwd: string | null = ctx.cwd ?? null
    // Transcript upload — best-effort and INDEPENDENT of the skills report, so a
    // failed/unsupported transcript can't suppress the skills inventory.
    try {
      const transcriptPath: string | undefined = ctx.sessionManager?.getSessionFile?.()
      if (transcriptPath) {
        const bundle = await buildBundle(transcriptPath)
        const body = Buffer.from(encodeBundle(bundle), 'utf8')
        if (!bundle.files.every((f) => f.content.length === 0)) {
          cwd = ctx.cwd ?? cwdFromContent(bundle.files[0]?.content ?? '')
          await send(body, 'pi-jsonl', cwd, bundle.sessionKey, transcriptPath)
        }
      }
    } catch {
      // Upload failures are non-fatal.
    }

    // Installed-skill inventory (Pi scope), independent + best-effort.
    try {
      const email = await accountEmail()
      const locations = await collectSkills('pi', cwd ?? undefined)
      await uploadSkills(TUNELOOP_SERVER, TUNELOOP_TOKEN, email, locations)
    } catch {
      /* skills report is strictly best-effort */
    }
  })
}
