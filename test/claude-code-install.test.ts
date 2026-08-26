/**
 * The claude-code `--install` path: merge the three hooks into settings.json
 * (the config-management alternative to the plugin — same scripts, same
 * capture). Drives the shipped CLI artifact with TUNELOOP_CLAUDE_SETTINGS
 * pointing at an isolated file, the way the enterprise ingest CLI is tested.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js')

function run(settingsPath: string): string {
  return execFileSync(
    'node',
    [CLI, '--server', 'http://localhost:9999', '--token', 'tok-test', '--harness', 'claude-code', '--install'],
    { env: { ...process.env, TUNELOOP_CLAUDE_SETTINGS: settingsPath }, encoding: 'utf8' },
  )
}

test('claude-code --install merges hooks into settings.json', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-install-'))
  const settings = join(dir, 'settings.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await t.test('fresh install writes scripts and all three hooks', () => {
    run(settings)
    const s = JSON.parse(readFileSync(settings, 'utf8'))
    for (const ev of ['SessionEnd', 'PreToolUse', 'PostToolUse']) {
      assert.ok(Array.isArray(s.hooks[ev]) && s.hooks[ev].length === 1, `${ev} present`)
    }
    assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash')
    assert.equal(s.hooks.SessionEnd[0].matcher, undefined)
    const bin = join(homedir(), '.tuneloop', 'claude-code', 'bin')
    assert.ok(existsSync(join(bin, 'tuneloop-upload.mjs')))
    assert.ok(existsSync(join(bin, 'tuneloop-shell-edit.mjs')))
    // server + token baked into the uploader, not the capture script
    assert.ok(readFileSync(join(bin, 'tuneloop-upload.mjs'), 'utf8').includes('tok-test'))
  })

  await t.test('re-install is idempotent — no duplicate entries', () => {
    run(settings)
    const s = JSON.parse(readFileSync(settings, 'utf8'))
    for (const ev of ['SessionEnd', 'PreToolUse', 'PostToolUse']) assert.equal(s.hooks[ev].length, 1)
  })

  await t.test('existing settings and foreign hooks survive, with a backup', () => {
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    )
    run(settings)
    const s = JSON.parse(readFileSync(settings, 'utf8'))
    assert.equal(s.model, 'opus')
    assert.equal(s.hooks.PreToolUse.length, 2) // theirs + ours
    assert.equal(s.hooks.PreToolUse[0].matcher, 'Write')
    assert.ok(readdirSync(dir).some((n) => n.startsWith('settings.json.bak-')))
  })

  await t.test('unparseable settings file is refused, not clobbered', () => {
    writeFileSync(settings, '{not json')
    assert.throws(() => run(settings))
    assert.equal(readFileSync(settings, 'utf8'), '{not json')
  })
})
