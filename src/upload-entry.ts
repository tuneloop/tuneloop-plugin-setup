const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { readHookPayload, upload } from './upload.js'
import { accountEmail } from './git.js'
import { collectSkills, uploadSkills } from './skills.js'

async function main(): Promise<void> {
  const hook = await readHookPayload()
  const path = hook?.transcript_path
  if (!path) return

  // Transcript upload — best-effort and INDEPENDENT of the skills report below.
  try {
    await upload({
      server: TUNELOOP_SERVER,
      token: TUNELOOP_TOKEN,
      hook,
      format: 'claude-code-jsonl',
    })
  } catch {
    /* transcript upload is best-effort */
  }

  // Report the installed-skill inventory this session could invoke — independent,
  // so a failed transcript upload doesn't suppress it.
  try {
    const email = await accountEmail()
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
