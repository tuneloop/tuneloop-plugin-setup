const TUNELOOP_SERVER = '__TUNELOOP_SERVER__'
const TUNELOOP_TOKEN = '__TUNELOOP_TOKEN__'

import { readHookPayload, upload } from './upload.js'
import { accountEmail } from './git.js'
import { collectSkills, uploadSkills } from './skills.js'
import { collectShellEdits, sweepShellEdits } from './shell-edits.js'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

async function main(): Promise<void> {
  const hook = await readHookPayload()
  const path = hook?.transcript_path
  if (!path) return

  // Shell-edit events the pre/post Bash hooks spooled for this session ride
  // the bundle as a `shell-edits.json` sidecar (absent when nothing edited).
  const shellEdits = hook?.session_id ? await collectShellEdits(hook.session_id).catch(() => null) : null

  // Transcript upload — best-effort and INDEPENDENT of the skills report below.
  try {
    await upload({
      server: TUNELOOP_SERVER,
      token: TUNELOOP_TOKEN,
      hook,
      format: 'claude-code-jsonl',
      extras: shellEdits ? [shellEdits] : undefined,
    })
  } catch {
    /* transcript upload is best-effort; the kept spool re-ships next time */
  } finally {
    // The merged sidecar was a temp copy — the spool itself is retained (a
    // resumed session must re-ship the same events) and reaped by age.
    if (shellEdits) await rm(dirname(shellEdits), { recursive: true, force: true }).catch(() => {})
    await sweepShellEdits().catch(() => {})
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
