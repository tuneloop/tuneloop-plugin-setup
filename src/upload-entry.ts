const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { readHookPayload, upload } from './upload.js'
import { gitConfigEmail } from './git.js'
import { collectSkills, uploadSkills } from './skills.js'

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

  // Report the installed-skill inventory this session could invoke. Best-effort:
  // a failure here must never fail the upload above (it already succeeded).
  try {
    const email = (await gitConfigEmail()) ?? null
    const locations = await collectSkills('claude-code', hook?.cwd)
    await uploadSkills(TUNELOOP_SERVER, TUNELOOP_TOKEN, email, locations)
  } catch {
    /* skills report is strictly best-effort */
  }
}

main().catch(() => {
  // Upload failures are non-fatal — exit 0 so we never interrupt a session.
  process.exitCode = 0
})
