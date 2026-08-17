import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { groupIntoSessions } from './bundle.js'
import { groupCodexSessions } from './codex.js'
import { collectOpencodeBundles } from './opencode.js'
import { upload, uploadBundle, type UploadResult } from './upload.js'
import { walkFiles } from './walk.js'

interface FileSource {
  id: string
  root: string
  ext: string
  format: string
}

/** One logical session's files: the primary transcript plus any flat siblings. */
interface SessionPlan {
  primary: string
  extras: string[]
}

function fileSources(): FileSource[] {
  const home = homedir()
  return [
    { id: 'claude-code', root: join(home, '.claude', 'projects'), ext: '.jsonl', format: 'claude-code-jsonl' },
    { id: 'codex', root: join(home, '.codex', 'sessions'), ext: '.jsonl', format: 'codex-jsonl' },
    { id: 'pi', root: join(home, '.pi', 'agent', 'sessions'), ext: '.jsonl', format: 'pi-jsonl' },
  ]
}

export interface BackfillOptions {
  server: string
  token: string
  sources?: string[]
  sinceDays?: number
  limit?: number
  concurrency?: number
  dryRun?: boolean
  onProgress?: (event: BackfillProgress) => void
}

export interface BackfillProgress {
  source: string
  index: number
  total: number
  label: string
  status: 'uploaded' | 'deduped' | 'failed' | 'planned'
  bytes?: number
  error?: string
}

export interface SourceSummary {
  source: string
  found: number
  uploaded: number
  deduped: number
  failed: number
  bytesUploaded: number
}

export async function backfill(opts: BackfillOptions): Promise<SourceSummary[]> {
  const wanted = (id: string) => !opts.sources?.length || opts.sources.includes(id)
  const summaries: SourceSummary[] = []

  for (const source of fileSources()) {
    if (!wanted(source.id)) continue
    const found = await walkFiles(source.root, source.ext)

    // Fold every transcript into the logical session it belongs to, so one
    // upload is one session. How that is determined differs by harness: Claude
    // Code and Pi co-locate a session's files, Codex relates them by ids in the
    // content. Either way `--limit` then counts sessions, never truncating one.
    const plans: SessionPlan[] =
      source.id === 'codex'
        ? (await groupCodexSessions(found)).map((g) => ({ primary: g.primary, extras: g.extras }))
        : groupIntoSessions(found).map((primary) => ({ primary, extras: [] }))

    const ordered = await orderByAge(plans, opts.sinceDays)
    const selected = opts.limit ? ordered.slice(0, opts.limit) : ordered
    if (selected.length === 0) continue
    summaries.push(await uploadFiles(opts, source.id, source.format, selected))
  }

  if (wanted('opencode')) {
    const summary = await uploadOpencode(opts)
    if (summary) summaries.push(summary)
  }

  return summaries
}

async function uploadFiles(
  opts: BackfillOptions,
  source: string,
  format: string,
  files: SessionPlan[],
): Promise<SourceSummary> {
  const summary: SourceSummary = { source, found: files.length, uploaded: 0, deduped: 0, failed: 0, bytesUploaded: 0 }

  let next = 0
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, async () => {
    for (;;) {
      const index = next++
      if (index >= files.length) return
      const plan = files[index]!
      const path = plan.primary
      const emit = (status: BackfillProgress['status'], extra?: Partial<BackfillProgress>) =>
        opts.onProgress?.({ source, index, total: files.length, label: path, status, ...extra })

      if (opts.dryRun) {
        const info = await stat(path).catch(() => null)
        emit('planned', { bytes: info?.size ?? 0 })
        continue
      }

      let result: UploadResult | null = null
      let error: string | undefined
      try {
        result = await upload({ server: opts.server, token: opts.token, path, extras: plan.extras, format })
      } catch (err) {
        error = (err as Error).message
      }

      if (!result) {
        summary.failed++
        emit('failed', { error })
        continue
      }
      if (result.deduped) summary.deduped++
      else {
        summary.uploaded++
        summary.bytesUploaded += result.gzipBytes
      }
      emit(result.deduped ? 'deduped' : 'uploaded', { bytes: result.bytes })
    }
  })

  await Promise.all(workers)
  return summary
}

async function uploadOpencode(opts: BackfillOptions): Promise<SourceSummary | null> {
  const collected = await collectOpencodeBundles()
  if (!collected) return null

  const count = collected.bundles.length
  const summary: SourceSummary = {
    source: 'opencode',
    found: count,
    uploaded: 0,
    deduped: 0,
    failed: 0,
    bytesUploaded: 0,
  }
  if (count === 0) return summary

  if (opts.dryRun) {
    opts.onProgress?.({
      source: 'opencode',
      index: 0,
      total: count,
      label: collected.dbPath,
      status: 'planned',
    })
    return summary
  }

  let next = 0
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, async () => {
    for (;;) {
      const index = next++
      if (index >= collected.bundles.length) return
      const bundle = collected.bundles[index]!
      const emit = (status: BackfillProgress['status'], extra?: Partial<BackfillProgress>) =>
        opts.onProgress?.({
          source: 'opencode',
          index,
          total: count,
          label: bundle.sessionKey ?? collected.dbPath,
          status,
          ...extra,
        })

      try {
        const result = await uploadBundle({
          server: opts.server,
          token: opts.token,
          bundle,
          format: 'opencode-raw',
          sourcePath: collected.dbPath,
        })
        if (result.deduped) summary.deduped++
        else {
          summary.uploaded++
          summary.bytesUploaded += result.gzipBytes
        }
        emit(result.deduped ? 'deduped' : 'uploaded', { bytes: result.bytes })
      } catch (err) {
        summary.failed++
        emit('failed', { error: (err as Error).message })
      }
    }
  })

  await Promise.all(workers)
  return summary
}

async function orderByAge(plans: SessionPlan[], sinceDays?: number): Promise<SessionPlan[]> {
  const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : null
  const stamped: Array<{ plan: SessionPlan; mtime: number }> = []
  for (const plan of plans) {
    try {
      const info = await stat(plan.primary)
      if (cutoff && info.mtimeMs < cutoff) continue
      stamped.push({ plan, mtime: info.mtimeMs })
    } catch {
      // Raced with deletion — skip.
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime)
  return stamped.map((s) => s.plan)
}
