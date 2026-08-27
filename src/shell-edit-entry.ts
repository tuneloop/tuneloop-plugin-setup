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
 *
 * Classification ships as a verdict (`kind`) AND the evidence it was derived
 * from (heads, stash movement, parent count, freshness) — the server can
 * re-derive a better verdict later without re-rolling hooks to every laptop.
 *
 * The no-harm contract: always exit 0, never print, give up silently on any
 * failure (no git, not a repo, slow disk). Scratch state is one tiny file per
 * call keyed by tool_use_id — parallel Bash calls mean parallel hooks, and
 * separate files can't corrupt each other.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExec } from './git.js'
import { readHookPayload } from './upload.js'
import { shellEditsDir } from './shell-edits.js'

/** Bound one event's patch so a vendored-dependency commit can't bloat the
 *  spool. A diff too large even to CAPTURE (past git's output buffer) falls
 *  back to a bare changed-file list — path-only credit beats a dropped event. */
const PATCH_MAX = 512 * 1024
const DIFF_BUFFER = Number(process.env.TUNELOOP_DIFF_MAX_BUFFER || 32 * 1024 * 1024)

const git = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => gitExec(args, { cwd, env })

interface Snapshot {
  tree: string
  head: string | null
  stash: string | null
  toplevel: string
}

/** Tree-object hash of the working tree (tracked + untracked), via a
 *  throwaway index seeded from the real one so only changed files re-hash. */
async function snapshot(cwd: string, scratch: string): Promise<Snapshot | null> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], cwd)
  if (!toplevel) return null
  const gitDir = await git(['rev-parse', '--absolute-git-dir'], cwd)
  if (!gitDir) return null
  try {
    await copyFile(join(gitDir, 'index'), scratch)
  } catch {
    /* unborn repo with no index yet — git add builds one from scratch */
  }
  const env = { GIT_INDEX_FILE: scratch }
  const added = await git(['add', '-A', '.'], toplevel, env)
  if (added === null) return null
  const tree = await git(['write-tree'], toplevel, env)
  if (!tree) return null
  const head = await git(['rev-parse', 'HEAD'], toplevel)
  // The stash is a hidden commit with its own bookmark. Content changing
  // while THIS bookmark moves means the content traveled to or from the
  // shelf (`git stash` / `stash pop`) — shelved or restored, never authored.
  const stash = await git(['rev-parse', '--quiet', '--verify', 'refs/stash'], toplevel)
  return { tree, head, stash, toplevel }
}

async function main(): Promise<void> {
  const input = await readHookPayload()
  if (!input || input.tool_name !== 'Bash') return
  const { session_id: sessionId, tool_use_id: toolUseId, cwd } = input
  if (!sessionId || !toolUseId || !cwd) return

  const dir = shellEditsDir(sessionId)
  // File names embed the tool_use_id, so nothing here can collide across
  // parallel Bash calls (pre and post for ONE call are strictly sequential —
  // pre finishes before the tool runs). Sanitize: an id is opaque, not a path.
  const key = toolUseId.replace(/[^\w.-]/g, '_')
  const preFile = join(dir, `pre-${key}.json`)
  const scratch = join(dir, `idx-${key}`)

  try {
    if (input.hook_event_name === 'PreToolUse') {
      await mkdir(dir, { recursive: true })
      const snap = await snapshot(cwd, scratch)
      if (snap) {
        // Exactly the fields the post pass consumes — nothing phantom.
        const pre = { tree: snap.tree, head: snap.head, stash: snap.stash, ts: new Date().toISOString() }
        await writeFile(preFile, JSON.stringify(pre))
      }
      return
    }

    // PostToolUse
    let pre: { tree?: string; head?: string | null; stash?: string | null; ts?: string } | null = null
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

    let patch = await gitExec(['diff', '--no-color', pre.tree, post.tree], { cwd, maxBufferBytes: DIFF_BUFFER })
    let files: string[] | undefined
    if (!patch) {
      // The diff exceeded even the raised buffer (vendored deps, generated
      // assets): degrade to the changed-path list — never drop the event.
      const names = await git(['diff', '--name-only', pre.tree, post.tree], cwd)
      if (!names) return
      files = names.split('\n').filter(Boolean)
      patch = ''
    }
    if (patch.length > PATCH_MAX) patch = patch.slice(0, PATCH_MAX)

    // Content changed — authored, or merely moved around by git? Three
    // bookmark checks, cheapest disqualifier first:
    // - stash bookmark moved → shelved or restored (`git stash` / `stash pop`).
    // - HEAD moved to an OLD commit (checkout, reset, fast-forward pull):
    //   restored. Fresh commit = created by this command (committer date in
    //   epoch seconds; %ct truncates to seconds).
    // - fresh commit with TWO+ parents → a merge knot (merge pull): arrival.
    const stashMoved = (pre.stash ?? null) !== (post.stash ?? null)
    const headMoved = (pre.head ?? null) !== (post.head ?? null)
    let fresh: boolean | null = null
    let parents: number | null = null
    if (headMoved && post.head) {
      const committed = await git(['show', '-s', '--format=%ct', post.head], cwd)
      const preTs = typeof pre.ts === 'string' ? Date.parse(pre.ts) : NaN
      fresh = !!committed && Number.isFinite(preTs) && Number(committed) >= Math.floor(preTs / 1000)
      const parentLine = await git(['show', '-s', '--format=%P', post.head], cwd)
      parents = (parentLine ?? '').trim().split(/\s+/).filter(Boolean).length
    }
    let kind: 'edit' | 'revert' = stashMoved ? 'revert' : headMoved ? (fresh && (parents ?? 0) < 2 ? 'edit' : 'revert') : 'edit'

    // The bookmark checks miss restores that move NOTHING (`git checkout --
    // file`, `git reset --hard` at the same HEAD). Positive signal instead:
    // a changed file whose AFTER-content is byte-identical to its PRE-HEAD
    // version was restored, not authored — regardless of which command did
    // it. Compared against the PRE head: after an edit+commit the content
    // equals the NEW head by definition, and must stay authored.
    let restoredPaths: string[] = []
    if (kind === 'edit' && pre.head) {
      const changed =
        files ?? (await git(['diff', '--name-only', pre.tree, post.tree], cwd))?.split('\n').filter(Boolean) ?? []
      if (changed.length) {
        const blobsOf = async (treeish: string) => {
          const outMap = new Map<string, string>()
          const listing = await git(['ls-tree', '-r', treeish, '--', ...changed], cwd)
          for (const lineTxt of (listing ?? '').split('\n')) {
            const tab = lineTxt.indexOf('\t')
            if (tab < 0) continue
            const hash = lineTxt.slice(0, tab).split(/\s+/)[2]
            if (hash) outMap.set(lineTxt.slice(tab + 1), hash)
          }
          return outMap
        }
        const headBlobs = await blobsOf(pre.head)
        const postBlobs = await blobsOf(post.tree)
        restoredPaths = changed.filter((n) => {
          const after = postBlobs.get(n)
          return !!after && after === headBlobs.get(n)
        })
        // Every changed file restored → the command as a whole was a restore.
        if (restoredPaths.length === changed.length) kind = 'revert'
      }
    }

    const event = {
      kind,
      toolUseId,
      ts: new Date().toISOString(),
      cwd,
      // git diff paths are relative to the repo's TOP folder, not cwd — and
      // only this hook knows that folder at capture time. The server joins
      // it with each path so downstream consumers see absolute paths, the
      // same frame native Edit calls use.
      toplevel: post.toplevel,
      // The evidence behind `kind`, so the server can reclassify past events
      // when the policy improves (cherry-pick, rebase pulls) — the verdict is
      // convenient, the observations are the record.
      evidence: {
        preHead: pre.head ?? null,
        postHead: post.head,
        stashMoved,
        fresh,
        parents,
        // Files this command merely restored to their pre-HEAD content — the
        // parser skips them even inside a mixed (edit + restore) command.
        ...(restoredPaths.length ? { restoredPaths } : {}),
      },
      patch,
      ...(files ? { files } : {}),
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
