import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { buildManagedRequirements, codexHookCommand, quotePosixShellArg } from '../src/generate/codex.ts'

test('quotePosixShellArg preserves shell metacharacters literally', { skip: process.platform === 'win32' }, () => {
  const value = `spaces $HOME $(touch PWNED) \`touch PWNED_TOO\` "double" 'single' \\backslash`
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${quotePosixShellArg(value)}`], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, value)
})

test('codexHookCommand executes an uploader at a literal path', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tuneloop-shell-quote-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const dangerousDir = `hook $HOME $(touch PWNED) "double" 'single'`
  const uploaderDir = join(root, dangerousDir)
  const uploaderPath = join(uploaderDir, 'tuneloop-upload.mjs')
  const completedPath = join(root, 'completed')
  await mkdir(uploaderDir)
  await writeFile(
    uploaderPath,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(completedPath)}, process.argv.slice(2).join(','))`,
  )

  const result = spawnSync('/bin/sh', ['-c', codexHookCommand(uploaderPath)], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(completedPath, 'utf8'), '--detach')
  assert.equal(existsSync(join(root, 'PWNED')), false)
})

test('managed POSIX command shell-quotes the uploader path', () => {
  const managedDir = `/opt/Tuneloop $HOME $(touch PWNED) "double" 'single'`
  const requirements = buildManagedRequirements(managedDir, String.raw`C:\Program Files\Tuneloop`)
  const commandLine = requirements.split('\n').find((line) => line.startsWith('command = '))
  assert.ok(commandLine)

  const tomlValue = commandLine.slice('command = '.length)
  const command = tomlValue.startsWith("'") ? tomlValue.slice(1, -1) : JSON.parse(tomlValue)
  assert.equal(command, `node ${quotePosixShellArg(`${managedDir}/tuneloop-upload.mjs`)} --detach`)
})
