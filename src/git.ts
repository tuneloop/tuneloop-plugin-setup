import { execFile } from 'node:child_process'
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

export interface RepoContext {
  remote: string | null
  branch: string | null
  repo: string | null
  toplevel: string | null
}

export async function repoContext(cwd: string | undefined): Promise<RepoContext> {
  if (!cwd) return { remote: null, branch: null, repo: null, toplevel: null }
  return {
    remote: await git(['-C', cwd, 'remote', 'get-url', 'origin']),
    branch: await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
    repo: await repoName(cwd),
    toplevel: await git(['-C', cwd, 'rev-parse', '--show-toplevel']),
  }
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
