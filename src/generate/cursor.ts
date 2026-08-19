import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip } from '../zip.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The lean hook set — every event that feeds the normalized session, nothing
 * redundant. Validated against Cursor's own hook-type list: ONE unknown name
 * makes Cursor silently reject the ENTIRE config and load zero hooks, so this
 * list must only ever contain names from the validator's registry.
 */
const HOOK_EVENTS = [
  'beforeSubmitPrompt',
  'afterAgentThought',
  'afterAgentResponse',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeReadFile',
  'afterFileEdit',
  'afterMCPExecution',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'stop',
  'sessionEnd',
] as const

const PLUGIN_JSON = JSON.stringify(
  {
    name: 'tuneloop',
    version: '0.1.0',
    description: 'Captures Cursor sessions via hooks and uploads them to your Tuneloop server when a conversation goes idle.',
  },
  null,
  2,
)

function hooksJson(command: (event: string) => string): string {
  const hooks: Record<string, Array<{ type: string; command: string }>> = {}
  for (const event of HOOK_EVENTS) hooks[event] = [{ type: 'command', command: command(event) }]
  return JSON.stringify({ version: 1, hooks }, null, 2)
}

async function bakedScript(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'cursor-hook-entry.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/"__TUNELOOP_SERVER__"|'__TUNELOOP_SERVER__'/, JSON.stringify(server))
  script = script.replace(/"__TUNELOOP_TOKEN__"|'__TUNELOOP_TOKEN__'/, JSON.stringify(token))
  return script
}

/**
 * Default output: a zip plugin in the same shape as the Claude Code one —
 * Cursor's plugin system reads the identical layout (`.cursor-plugin/plugin.json`
 * manifest + `hooks/hooks.json` + a bin script) and exposes the plugin root as
 * `${CURSOR_PLUGIN_ROOT}`. The script is `.mjs` because it is an ES module and
 * is executed as `node <path>` — an extensionless file would load as CJS and
 * die on the first `import`.
 */
export async function generateCursor(opts: {
  server: string
  token: string
  output: string
  install: boolean
}): Promise<string> {
  const script = await bakedScript(opts.server, opts.token)

  if (opts.install) return install(script)

  const zip = createZip([
    { path: '.cursor-plugin/plugin.json', data: Buffer.from(PLUGIN_JSON) },
    {
      path: 'hooks/hooks.json',
      // eslint-disable-next-line no-template-curly-in-string
      data: Buffer.from(hooksJson((e) => `node "\${CURSOR_PLUGIN_ROOT}/bin/tuneloop-cursor-hook.mjs" ${e}`)),
    },
    { path: 'bin/tuneloop-cursor-hook.mjs', data: Buffer.from(script) },
  ])

  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, zip)
  return opts.output
}

/**
 * `--install`: the hooks.json-merge path — write the script under
 * `~/.tuneloop/cursor/` and register the hooks in the USER-level
 * `~/.cursor/hooks.json` (one install covers every project). Absolute paths,
 * because a hook command that fails to resolve records nothing, silently.
 *
 * Merge policy mirrors the Claude Code settings installer: back up first,
 * refuse to touch a file we cannot parse, and never disturb entries that are
 * not ours (ours are recognizable by the script path).
 */
async function install(script: string): Promise<string> {
  const binDir = join(homedir(), '.tuneloop', 'cursor')
  const scriptPath = join(binDir, 'tuneloop-cursor-hook.mjs')
  await mkdir(binDir, { recursive: true })
  await writeFile(scriptPath, script, 'utf8')

  const hooksPath = join(homedir(), '.cursor', 'hooks.json')
  let config: { version?: number; hooks?: Record<string, unknown[]> } = {}
  let existing: string | null = null
  try {
    existing = await readFile(hooksPath, 'utf8')
  } catch {
    /* no user hooks yet */
  }
  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      config = parsed as typeof config
    } catch {
      throw new Error(`${hooksPath} exists but is not valid JSON — fix or remove it, then re-run (refusing to overwrite)`)
    }
    await copyFile(hooksPath, `${hooksPath}.bak-${Date.now()}`)
  }

  config.version ??= 1
  config.hooks ??= {}
  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(config.hooks[event]) ? config.hooks[event] : []
    const ours = entries.some((e) => {
      const cmd = (e as { command?: unknown } | null)?.command
      return typeof cmd === 'string' && cmd.includes('tuneloop-cursor-hook')
    })
    if (!ours) entries.push({ type: 'command', command: `node "${scriptPath}" ${event}` })
    config.hooks[event] = entries
  }

  await mkdir(dirname(hooksPath), { recursive: true })
  await writeFile(hooksPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return hooksPath
}
