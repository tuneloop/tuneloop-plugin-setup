import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 5000 })
    const out = stdout.trim()
    return out || null
  } catch {
    return null
  }
}

export async function gitConfigEmail(cwd?: string): Promise<string | undefined> {
  const args = cwd ? ['-C', cwd, 'config', '--get', 'user.email'] : ['config', '--get', 'user.email']
  return (await git(args)) ?? undefined
}

/**
 * The email a session's uploads are attributed to (the account owner). An
 * explicit `TUNELOOP_EMAIL` env var wins so a developer whose git `user.email`
 * differs from their Tuneloop identity — or who works outside a git repo — can
 * still be attributed; it's the only override that works for a shared
 * marketplace/managed install, where the uploader can't bake a per-user address.
 * Otherwise it falls back to git `user.email`. Distinct from the per-repo
 * `gitAuthorEmail`, which stays git-derived for commit/PR attribution.
 */
export async function accountEmail(): Promise<string | null> {
  const override = process.env.TUNELOOP_EMAIL?.trim()
  if (override) return override
  return (await gitConfigEmail()) ?? null
}

export interface RepoContext {
  remote: string | null
  branch: string | null
  repo: string | null
  toplevel: string | null
  /**
   * Every checkout root of this repo — the main worktree plus every linked one
   * (nested `.claude/worktrees/<slug>/` or a sibling dir). The server strips
   * whichever root contains an edited file, so an agent editing in a worktree
   * other than `toplevel` still attributes; a file under no root (a foreign
   * repo) is dropped. Empty when cwd isn't a checkout.
   */
  worktrees: string[]
}

export async function repoContext(cwd: string | undefined): Promise<RepoContext> {
  if (!cwd) return { remote: null, branch: null, repo: null, toplevel: null, worktrees: [] }
  return {
    remote: await git(['-C', cwd, 'remote', 'get-url', 'origin']),
    branch: await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
    repo: await repoName(cwd),
    toplevel: await git(['-C', cwd, 'rev-parse', '--show-toplevel']),
    worktrees: await worktreeRoots(cwd),
  }
}

/**
 * Every worktree root of the repo `cwd` lives in (absolute). `git worktree list
 * --porcelain` emits one `worktree <path>` line per checkout and returns the
 * same set from any worktree. Empty when cwd isn't a checkout.
 */
export async function worktreeRoots(cwd: string): Promise<string[]> {
  const out = await git(['-C', cwd, 'worktree', 'list', '--porcelain'])
  if (!out) return []
  const roots: string[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length).trim())
  }
  return roots
}

export async function repoName(cwd: string): Promise<string | null> {
  const top = await git(['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (!top) return null
  let root = top
  const common = await git(['-C', cwd, 'rev-parse', '--git-common-dir'])
  if (common) {
    const absCommon = resolve(cwd, common)
    if (basename(absCommon) === '.git') root = dirname(absCommon)
  }
  return basename(root) || null
}

/** Canonical `owner/name` (lowercased) from origin, or null when there's none. */
export async function repoSlug(cwd: string): Promise<string | null> {
  return slugFromRemote(await git(['-C', cwd, 'remote', 'get-url', 'origin']))
}

/** Canonical `owner/name` from a remote URL, or null when it doesn't parse. */
export function slugFromRemote(remote: string | null): string | null {
  const m = remote?.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null
}

/**
 * Where an installed skill came from, when it lives in a git checkout — the
 * provenance the team view anchors version drift against. Null outside a checkout
 * (copied in, or no repo), so the caller falls back to hash-only identity.
 *
 *   repo   — canonical `owner/name` (null when there's no parseable origin).
 *   path   — the skill's path within the repo (git's `--show-prefix`, so it's
 *            layout-agnostic: a root `<name>` or `skills/<name>`).
 *   commit — the last commit that touched `path` (NOT repo HEAD); null if untracked.
 *   dirty  — tracked content under `path` differs from that commit (local edits).
 */
export interface SkillProvenance {
  remote: string | null
  repo: string | null
  path: string
  commit: string | null
  committedAt: string | null
  dirty: boolean
}

export async function skillProvenance(skillPath: string): Promise<SkillProvenance | null> {
  // Resolve symlinks first: skills are commonly symlinked from a config dir into a
  // cloned repo, and git must run in the physical checkout to report a correct path.
  let real: string
  let isDir: boolean
  try {
    real = await realpath(skillPath)
    isDir = (await stat(real)).isDirectory()
  } catch {
    return null
  }
  const cwd = isDir ? real : dirname(real)
  const rp = await git(['-C', cwd, 'rev-parse', '--show-toplevel', '--show-prefix'], cwd)
  if (!rp) return null
  const [toplevel, prefixRaw] = rp.split('\n')
  if (!toplevel) return null
  const prefix = (prefixRaw ?? '').replace(/\/$/, '')
  const path = isDir ? prefix : (prefix ? prefix + '/' : '') + basename(real)
  const pathspec = isDir ? '.' : basename(real)

  const remote = await git(['-C', cwd, 'remote', 'get-url', 'origin'], cwd)
  const logLine = await git(['-C', cwd, 'log', '-1', '--format=%H%x09%cI', '--', pathspec], cwd)
  const [commit, committedAt] = logLine ? logLine.split('\t') : [null, null]
  // `--untracked-files=no`: only tracked modifications count as dirty; incidental
  // untracked files (.DS_Store, swap files) don't false-flag a skill as diverged.
  const status = await git(['-C', cwd, 'status', '--porcelain', '--untracked-files=no', '--', pathspec], cwd)

  return {
    remote: remote ?? null,
    repo: slugFromRemote(remote),
    path: path || basename(real),
    commit: commit ?? null,
    committedAt: committedAt ?? null,
    dirty: status !== null,
  }
}
