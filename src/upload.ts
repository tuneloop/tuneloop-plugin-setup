import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { buildBundle, cwdFromContent, encodeBundle, type SessionBundle } from './bundle.js'
import { machineId } from './machine-id.js'
import { accountEmail, gitConfigEmail, repoContext } from './git.js'

export const CLIENT_VERSION = '0.1.0'

export interface HookPayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_use_id?: string
}

export interface UploadOptions {
  server: string
  token: string
  path?: string
  hook?: HookPayload
  extras?: string[]
  /** Explicit session key. Backfill derives it from the transcript; the live
   * hook supplies `hook.session_id`. Takes precedence over both. */
  sessionKey?: string | null
  cwd?: string
  format?: string
  timeoutMs?: number
}

export interface UploadResult {
  status: number
  bytes: number
  gzipBytes: number
  contentHash: string
  deduped: boolean
  sessionId?: string
}

export async function upload(opts: UploadOptions): Promise<UploadResult> {
  const path = opts.path ?? opts.hook?.transcript_path
  if (!path) throw new Error('no transcript path — pass --path, or run this as a SessionEnd hook')

  const bundle = await buildBundle(path, {
    sessionKey: opts.sessionKey ?? opts.hook?.session_id ?? null,
    extras: opts.extras,
  })
  const body = Buffer.from(encodeBundle(bundle), 'utf8')
  // Guard the PRIMARY transcript specifically: a non-empty sidecar must not
  // smuggle an empty/truncated transcript past the check.
  const primary = bundle.files.find((f) => f.name === bundle.primary)
  if (!primary || primary.content.length === 0) throw new Error(`transcript is empty: ${path}`)

  return send({
    server: opts.server,
    token: opts.token,
    body,
    format: opts.format ?? 'claude-code-jsonl',
    sourcePath: path,
    cwd: opts.cwd ?? opts.hook?.cwd ?? cwdFromContent(bundle.files[0]?.content ?? ''),
    sessionKey: bundle.sessionKey,
    fileCount: bundle.files.length,
    timeoutMs: opts.timeoutMs,
  })
}

export async function uploadBundle(opts: {
  server: string
  token: string
  bundle: SessionBundle
  format: string
  sourcePath: string
  cwd?: string
  timeoutMs?: number
}): Promise<UploadResult> {
  return send({
    server: opts.server,
    token: opts.token,
    body: Buffer.from(encodeBundle(opts.bundle), 'utf8'),
    format: opts.format,
    sourcePath: opts.sourcePath,
    cwd: opts.cwd ?? null,
    sessionKey: opts.bundle.sessionKey,
    fileCount: opts.bundle.files.length,
    timeoutMs: opts.timeoutMs,
  })
}

interface SendOptions {
  server: string
  token: string
  body: Buffer
  format: string
  sourcePath: string | null
  cwd: string | null
  sessionKey?: string | null
  fileCount?: number
  timeoutMs?: number
}

async function send(opts: SendOptions): Promise<UploadResult> {
  const { body } = opts
  const contentHash = createHash('sha256').update(body).digest('hex')
  const gz = gzipSync(body)

  const repo = await repoContext(opts.cwd ?? undefined)
  const email = await accountEmail()
  const gitAuthorEmail = (await gitConfigEmail(opts.cwd ?? undefined)) ?? null

  const meta = {
    format: opts.format,
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
    cwd: opts.cwd,
    sourcePath: opts.sourcePath,
    sessionKey: opts.sessionKey ?? null,
    fileCount: opts.fileCount ?? 1,
    clientVersion: CLIENT_VERSION,
  }

  const form = new FormData()
  form.set('meta', JSON.stringify(meta))
  form.set('transcript', new Blob([gz], { type: 'application/gzip' }), 'transcript.gz')

  const res = await fetch(`${opts.server}/api/ingest/transcript`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}` },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  })

  const text = await res.text()
  if (!res.ok) {
    const detail = safeError(text) ?? `${res.status} ${res.statusText}`
    throw new Error(`upload rejected: ${detail}`)
  }
  const parsed = safeJson(text)
  return {
    status: res.status,
    bytes: body.length,
    gzipBytes: gz.length,
    contentHash,
    deduped: parsed?.deduped === true,
    sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined,
  }
}

export async function readHookPayload(): Promise<HookPayload | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw) as HookPayload
  } catch {
    return null
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function safeError(text: string): string | null {
  const parsed = safeJson(text)
  const message = parsed?.error ?? parsed?.message
  return typeof message === 'string' ? message : null
}
