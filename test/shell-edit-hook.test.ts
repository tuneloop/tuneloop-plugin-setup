/**
 * The shell-edit capture hook, driven exactly the way Claude Code drives it:
 * spawn dist/shell-edit-entry.js with a hook payload on stdin, around real
 * commands in a real scratch git repo. Every case here is a row of the design
 * doc's behavior table (docs/plans/shell-edit-capture.md in the server repo).
 *
 * Requires `npm run build` first — it tests the shipped artifact, not source.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const HOOK = join(import.meta.dirname, '..', 'dist', 'shell-edit-entry.js')
const SID = `hook-test-${process.pid}`
const STATE = join(homedir(), '.tuneloop', 'claude-code', 'shell-edits', SID)

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): void {
  execSync(cmd, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' })
}

function invoke(event: 'PreToolUse' | 'PostToolUse', toolUseId: string, cwd: string, env: Record<string, string> = {}): void {
  execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: SID, cwd, hook_event_name: event, tool_name: 'Bash', tool_use_id: toolUseId }),
    env: { ...process.env, ...env },
  })
}

function events(): Array<{ kind: string; toolUseId: string; patch: string }> {
  if (!existsSync(STATE)) return []
  return readdirSync(STATE)
    .filter((n) => n.startsWith('edit-'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(STATE, n), 'utf8')))
}

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'shell-edit-hook-'))
  const backdate = { GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z' }
  sh('git init -q', r)
  writeFileSync(join(r, 'f.ts'), 'original\n')
  sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m init', r, backdate)
  return r
}

test('shell-edit hook behavior table', async (t) => {
  rmSync(STATE, { recursive: true, force: true })
  const r = repo()
  t.after(() => {
    rmSync(r, { recursive: true, force: true })
    rmSync(STATE, { recursive: true, force: true })
  })

  await t.test('no-op command records nothing', () => {
    invoke('PreToolUse', 't1', r)
    invoke('PostToolUse', 't1', r)
    assert.equal(events().length, 0)
  })

  await t.test('a real edit records kind=edit with the exact diff', () => {
    invoke('PreToolUse', 't2', r)
    writeFileSync(join(r, 'f.ts'), 'edited\n')
    invoke('PostToolUse', 't2', r)
    const [e] = events()
    assert.equal(events().length, 1)
    assert.equal(e!.kind, 'edit')
    assert.equal(e!.toolUseId, 't2')
    assert.ok(e!.patch.includes('-original') && e!.patch.includes('+edited'))
    // git diff paths are toplevel-relative; the event must carry the toplevel
    // so the server can absolutize them into the native-Edit path frame.
    assert.ok(typeof (e as { toplevel?: string }).toplevel === 'string' && (e as { toplevel?: string }).toplevel!.length > 0)
  })

  await t.test('commit-only moves refs, not bytes — records nothing', () => {
    sh('git add -A', r) // stage the previous edit so the commit changes no content
    const before = events().length
    invoke('PreToolUse', 't3', r)
    sh('git -c user.name=t -c user.email=t@t commit -q -m staged', r)
    invoke('PostToolUse', 't3', r)
    assert.equal(events().length, before)
  })

  await t.test('edit+commit in one command is authored (kind=edit) despite HEAD moving', () => {
    invoke('PreToolUse', 't4', r)
    writeFileSync(join(r, 'f.ts'), 'v3\n')
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m v3', r)
    invoke('PostToolUse', 't4', r)
    const e = events().at(-1)!
    assert.equal(e.kind, 'edit')
    assert.ok(e.patch.includes('+v3'))
  })

  await t.test('checkout to an old commit is restored content (kind=revert)', () => {
    // The genuinely old (backdated) root commit — a checkout target created
    // seconds ago is indistinguishable from a commit-made-now, by design.
    sh('git branch old-state $(git rev-list --max-parents=0 HEAD)', r)
    invoke('PreToolUse', 't5', r)
    sh('git checkout -q old-state', r)
    invoke('PostToolUse', 't5', r)
    assert.equal(events().at(-1)!.kind, 'revert')
  })

  await t.test('git stash: content vanishes but was SHELVED, not authored (kind=revert)', () => {
    writeFileSync(join(r, 'f.ts'), 'work in progress\n')
    invoke('PreToolUse', 't7', r)
    sh('git stash -q', r)
    invoke('PostToolUse', 't7', r)
    assert.equal(events().at(-1)!.kind, 'revert')
  })

  await t.test('git stash pop: content reappears but was RESTORED (kind=revert)', () => {
    invoke('PreToolUse', 't8', r)
    sh('git stash pop -q', r)
    invoke('PostToolUse', 't8', r)
    assert.equal(events().at(-1)!.kind, 'revert')
    sh('git checkout -q -- .', r) // clean up the popped WIP for later cases
  })

  await t.test('merge commit (mode-2 pull): fresh but TWO parents — arrival, not authorship (kind=revert)', () => {
    // Build divergence: a side branch edits g.ts; main edits h.ts.
    sh('git checkout -q -b side', r)
    writeFileSync(join(r, 'g.ts'), 'from the other history\n')
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m side', r)
    sh('git checkout -q -', r)
    writeFileSync(join(r, 'h.ts'), 'local work\n')
    sh('git add -A && git -c user.name=t -c user.email=t@t commit -q -m local', r)
    invoke('PreToolUse', 't9', r)
    sh('git -c user.name=t -c user.email=t@t merge -q --no-edit side', r) // what a mode-2 `git pull` runs
    invoke('PostToolUse', 't9', r)
    const e = events().at(-1)!
    assert.equal(e.kind, 'revert')
    assert.ok(e.patch.includes('+from the other history')) // the arrival IS recorded, just not credited
  })

  await t.test('events carry the classification EVIDENCE, not just the verdict', () => {
    const e = events().at(-1)! as unknown as { evidence?: { parents?: number; stashMoved?: boolean } }
    assert.ok(e.evidence, 'evidence present')
    assert.equal(e.evidence!.parents, 2) // the merge knot from the previous case
    assert.equal(e.evidence!.stashMoved, false)
  })

  await t.test('a diff too large for the buffer degrades to a file list, never a drop', () => {
    const before = events().length
    invoke('PreToolUse', 't10', r)
    writeFileSync(join(r, 'huge.txt'), 'x'.repeat(2000) + '\n')
    // Force the fallback with a tiny diff buffer.
    invoke('PostToolUse', 't10', r, { TUNELOOP_DIFF_MAX_BUFFER: '64' })
    const e = events().at(-1)! as unknown as { patch: string; files?: string[] }
    assert.equal(events().length, before + 1)
    assert.equal(e.patch, '')
    assert.deepEqual(e.files, ['huge.txt'])
  })

  await t.test('git checkout -- file: no bookmark moves, but post==pre-HEAD → revert', () => {
    writeFileSync(join(r, 'f.ts'), 'dirty change\n')
    invoke('PreToolUse', 't11', r)
    sh('git checkout -- f.ts', r)
    invoke('PostToolUse', 't11', r)
    const e = events().at(-1)! as unknown as { kind: string; evidence: { restoredPaths?: string[] } }
    assert.equal(e.kind, 'revert')
    assert.deepEqual(e.evidence.restoredPaths, ['f.ts'])
  })

  await t.test('a mixed restore+edit command stays edit, with the restored file flagged', () => {
    writeFileSync(join(r, 'f.ts'), 'dirty again\n')
    invoke('PreToolUse', 't12', r)
    sh('git checkout -- f.ts && echo mixed >> h.ts', r)
    invoke('PostToolUse', 't12', r)
    const e = events().at(-1)! as unknown as { kind: string; patch: string; evidence: { restoredPaths?: string[] } }
    assert.equal(e.kind, 'edit')
    assert.deepEqual(e.evidence.restoredPaths, ['f.ts'])
    assert.ok(e.patch.includes('+mixed')) // the real edit is still in the diff
    sh('git checkout -q -- h.ts', r)
  })

  await t.test('non-git directory: silent, exit 0, no event', () => {
    const ng = mkdtempSync(join(tmpdir(), 'shell-edit-nongit-'))
    const before = events().length
    invoke('PreToolUse', 't6', ng)
    invoke('PostToolUse', 't6', ng)
    assert.equal(events().length, before)
    rmSync(ng, { recursive: true, force: true })
  })

  await t.test('scratch hygiene: no pre-/idx- files survive a completed pair', () => {
    const leftovers = readdirSync(STATE).filter((n) => n.startsWith('pre-') || n.startsWith('idx-'))
    assert.deepEqual(leftovers, [])
  })
})
