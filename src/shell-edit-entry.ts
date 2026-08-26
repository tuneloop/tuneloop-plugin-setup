/**
 * Shell-edit capture hook (docs/plans/shell-edit-capture.md in the server repo).
 *
 * Registered for PreToolUse/PostToolUse with matcher `Bash`. Agents edit files
 * through the shell (`sed -i`, python heredocs, `cat > file`) and the
 * transcript records only the command text — so this hook OBSERVES the edit
 * instead of parsing intent: fingerprint the working tree's content before
 * and after the command, and when it changed, record the exact `git diff`,
 * anchored to the call's `tool_use_id`. The SessionEnd uploader ships the
 * events as a `shell-edits.json` bundle sidecar.
 *
 * Fingerprint CONTENT, not refs: a `git commit` moves refs without changing a
 * file byte and must record nothing. The fingerprint is a tree-object hash
 * from a throwaway index seeded from the real one, so git re-hashes only
 * files whose stat changed — the same trick that makes `git status` fast.
 * When HEAD moved between the snapshots, the change was RESTORED, not
 * authored (checkout, reset): recorded as kind `revert`, which the server
 * never credits.
 *
 * The no-harm contract: always exit 0, never print, give up silently on any
 * failure (no git, not a repo, slow disk). Scratch state is one tiny file per
 * call keyed by tool_use_id — parallel Bash calls mean parallel hooks, and
 * separate files can't corrupt each other.
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_use_id?: string
}

/** Bound one event's patch so a vendored-dependency commit can't bloat the
 *  spool; a truncated patch still parses per-line server-side. */
const PATCH_MAX = 512 * 1024

export function stateDir(sessionId: string): string {
  return join(homedir(), '.tuneloop', 'claude-code', 'shell-edits', sessionId)
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout).replace(/\n$/, '')),
    )
  })
}

/** Tree-object hash of the working tree (tracked + untracked), via a
 *  throwaway index seeded from the real one so only changed files re-hash. */
async function snapshot(cwd: string, scratch: string): Promise<{ tree: string; head: string | null } | null> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], cwd)
  if (!toplevel) return null
  const realIndex = await git(['rev-parse', '--absolute-git-dir'], cwd)
  if (!realIndex) return null
  try {
    await copyFile(join(realIndex, 'index'), scratch)
  } catch {
    /* unborn repo with no index yet — git add builds one from scratch */
  }
  const env = { GIT_INDEX_FILE: scratch }
  const added = await git(['add', '-A', '.'], toplevel, env)
  if (added === null) return null
  const tree = await git(['write-tree'], toplevel, env)
  if (!tree) return null
  const head = await git(['rev-parse', 'HEAD'], toplevel)
  return { tree, head }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  let input: HookInput
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return
  }
  if (input.tool_name !== 'Bash') return
  const { session_id: sessionId, tool_use_id: toolUseId, cwd } = input
  if (!sessionId || !toolUseId || !cwd) return

  const dir = stateDir(sessionId)
  await mkdir(dir, { recursive: true })
  // File names embed the tool_use_id, so nothing here can collide across
  // parallel Bash calls. Sanitize: an id is opaque, not a path.
  const key = toolUseId.replace(/[^\w.-]/g, '_')
  const preFile = join(dir, `pre-${key}.json`)
  const scratch = join(dir, `idx-${key}-${input.hook_event_name === 'PreToolUse' ? 'pre' : 'post'}`)

  try {
    if (input.hook_event_name === 'PreToolUse') {
      const snap = await snapshot(cwd, scratch)
      if (snap) await writeFile(preFile, JSON.stringify({ ...snap, ts: new Date().toISOString() }))
      return
    }

    // PostToolUse
    let pre: { tree?: string; head?: string | null } | null = null
    try {
      pre = JSON.parse(await readFile(preFile, 'utf8'))
    } catch {
      return // no pre snapshot (hook added mid-session, or pre failed) — nothing to compare
    } finally {
      await rm(preFile, { force: true })
    }
    if (!pre?.tree) return
    const post = await snapshot(cwd, scratch)
    if (!post || post.tree === pre.tree) return // the command touched nothing

    let patch = await git(['diff', '--no-color', pre.tree, post.tree], cwd)
    if (!patch) return
    if (patch.length > PATCH_MAX) patch = patch.slice(0, PATCH_MAX)

    // HEAD moved: was the content change authored, or restored? An
    // edit+commit-in-one-command CREATES its new HEAD during the command, so
    // its committer date is fresh; a checkout/reset moves HEAD to a commit
    // that already existed. Fresh commit → authored; old commit → restored.
    let kind: 'edit' | 'revert' = 'edit'
    if ((pre.head ?? null) !== (post.head ?? null)) {
      // Epoch seconds on both sides (%ct truncates to seconds, so the pre
      // timestamp must too — same machine, same clock, no grace needed).
      const committed = post.head ? await git(['show', '-s', '--format=%ct', post.head], cwd) : null
      const preTs = typeof (pre as { ts?: string }).ts === 'string' ? Date.parse((pre as { ts?: string }).ts!) : NaN
      kind = committed && Number.isFinite(preTs) && Number(committed) >= Math.floor(preTs / 1000) ? 'edit' : 'revert'
    }
    const event = {
      version: 1,
      kind,
      toolUseId,
      ts: new Date().toISOString(),
      cwd,
      patch,
    }
    await writeFile(join(dir, `edit-${Date.now()}-${process.pid}.json`), JSON.stringify(event))
  } finally {
    await rm(scratch, { force: true })
  }
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0
  })
