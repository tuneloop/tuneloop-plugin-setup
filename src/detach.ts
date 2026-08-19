/**
 * The hook payload as it travels to a detached upload child.
 *
 * Codex's SessionEnd hook is clamped to ~3s, so the Codex uploader reads the
 * payload and hands the real work to a detached child. That child has no stdin,
 * so the payload rides along as a base64 argv (`--hook-json`) instead.
 */
import type { HookPayload } from './upload.js'

export function encodeHookPayload(hook: HookPayload): string {
  return Buffer.from(JSON.stringify(hook)).toString('base64')
}

export function decodeHookPayload(b64: string): HookPayload | null {
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as HookPayload
  } catch {
    return null
  }
}
