import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

export const BUNDLE_VERSION = 1

export interface BundleFile {
  name: string
  content: string
}

export interface SessionBundle {
  bundleVersion: number
  sessionKey: string | null
  primary: string
  files: BundleFile[]
}

function orderFiles(files: BundleFile[], primary: string): BundleFile[] {
  const rest = files.filter((f) => f.name !== primary).sort((a, b) => a.name.localeCompare(b.name))
  const head = files.filter((f) => f.name === primary)
  return [...head, ...rest]
}

export function encodeBundle(bundle: SessionBundle): string {
  return JSON.stringify({ ...bundle, files: orderFiles(bundle.files, bundle.primary) })
}

export function sessionDir(transcriptPath: string): string {
  const name = basename(transcriptPath).replace(/\.jsonl$/, '')
  return join(dirname(transcriptPath), name)
}

export interface BuildBundleOptions {
  sessionKey?: string | null
  extras?: string[]
}

export async function buildBundle(transcriptPath: string, opts: BuildBundleOptions = {}): Promise<SessionBundle> {
  const primary = basename(transcriptPath)
  const files: BundleFile[] = [{ name: primary, content: await readFile(transcriptPath, 'utf8') }]

  const dir = sessionDir(transcriptPath)
  for (const full of await walkSession(dir)) {
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size === 0) continue
      files.push({
        name: relative(dirname(transcriptPath), full).split(sep).join('/'),
        content: await readFile(full, 'utf8'),
      })
    } catch {
      // Raced with a rotation — the bundle is still valid without it.
    }
  }

  for (const extra of opts.extras ?? []) {
    try {
      const content = await readFile(extra, 'utf8')
      if (content.length > 0) files.push({ name: basename(extra), content })
    } catch {
      // Raced with a rotation — the bundle is still valid without it.
    }
  }

  return {
    bundleVersion: BUNDLE_VERSION,
    sessionKey: opts.sessionKey ?? (await sessionKeyOf(transcriptPath)),
    primary,
    files,
  }
}

async function walkSession(dir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
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

export async function sessionKeyOf(transcriptPath: string): Promise<string | null> {
  let head: string
  try {
    head = (await readFile(transcriptPath, 'utf8')).slice(0, 64 * 1024)
  } catch {
    return null
  }
  for (const line of head.split('\n').slice(0, 50)) {
    if (!line.includes('"sessionId"')) continue
    try {
      const parsed = JSON.parse(line) as { sessionId?: unknown }
      if (typeof parsed.sessionId === 'string' && parsed.sessionId) return parsed.sessionId
    } catch {
      // Truncated final line of the slice.
    }
  }
  return null
}

export function cwdFromContent(content: string): string | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"cwd"')) continue
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } }
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : parsed.payload?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      // Not a line we can read — keep walking back.
    }
  }
  return null
}

export function groupIntoSessions(paths: string[]): string[] {
  const owned = new Set(paths.map((p) => sessionDir(p) + '/'))
  return paths.filter((p) => ![...owned].some((dir) => p.startsWith(dir)))
}
