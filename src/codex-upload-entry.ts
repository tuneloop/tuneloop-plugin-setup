const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { spawn } from 'node:child_process'
import { decodeHookPayload, encodeHookPayload } from './detach.js'
import { readHookPayload, upload, type HookPayload } from './upload.js'

const FORMAT = 'codex-jsonl'

/**
 * Re-launch this script as a detached child that does the actual upload.
 * `detached: true` puts the child in its own process group, so when Codex kills
 * the ~3s-clamped hook process the upload survives. The payload rides along as a
 * base64 argv because the detached child has no stdin to read it from.
 */
function respawnDetached(hook: HookPayload): void {
  const child = spawn(process.execPath, [process.argv[1]!, '--hook-json', encodeHookPayload(hook)], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {}) // an async spawn failure must not surface as an uncaught error
  child.unref()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const detach = args.includes('--detach')
  const hookJsonIndex = args.indexOf('--hook-json')
  const hookJson = hookJsonIndex >= 0 ? args[hookJsonIndex + 1] : undefined

  // The detached child arrives with --hook-json (its stdin is /dev/null); the
  // hook process itself reads the payload from stdin, the way Codex invokes it.
  const hook = hookJson ? decodeHookPayload(hookJson) : await readHookPayload()
  if (!hook?.transcript_path) return

  // Codex clamps SessionEnd to ~3s, so the hook process hands the real work to a
  // detached child (which arrives back here via --hook-json) and returns at once.
  if (detach && !hookJson) {
    respawnDetached(hook)
    return
  }

  await upload({ server: TUNELOOP_SERVER, token: TUNELOOP_TOKEN, hook, format: FORMAT })
}

main().catch(() => {
  // Upload failures are non-fatal — exit 0 so we never interrupt a session.
  process.exitCode = 0
})
