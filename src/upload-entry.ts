const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { readHookPayload, upload } from './upload.js'

async function main(): Promise<void> {
  const hook = await readHookPayload()
  const path = hook?.transcript_path
  if (!path) return

  await upload({
    server: TUNELOOP_SERVER,
    token: TUNELOOP_TOKEN,
    hook,
    format: 'claude-code-jsonl',
  })
}

main().catch(() => {
  // Upload failures are non-fatal — exit 0 so we never interrupt a session.
  process.exitCode = 0
})
