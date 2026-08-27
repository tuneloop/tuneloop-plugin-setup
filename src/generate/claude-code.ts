import { readFile } from 'node:fs/promises'
import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip } from '../zip.js'
import { claudeHome } from '../skills.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PLUGIN_JSON = JSON.stringify(
  {
    name: 'tuneloop',
    version: '0.1.0',
    description: 'Uploads session transcripts to your Tuneloop server on SessionEnd.',
    author: { name: 'Tuneloop', email: 'bbhat@tuneloop.io' },
  },
  null,
  2,
)

/**
 * ONE hook spec, rendered for both install paths — the plugin's hooks.json
 * (commands under ${CLAUDE_PLUGIN_ROOT}) and the settings-level installer
 * (absolute paths). A single source of truth is what makes "the two installs
 * are functionally identical" an enforced fact instead of a hand-kept promise.
 *
 * Scripts ship with the .mjs extension: the bundles are ESM, and an
 * extensionless file is only ESM-parsed by Node's syntax detection (22.7+,
 * and never when an ancestor package.json declares a `type`) — a marketplace
 * repo with "type":"commonjs" would kill every hook invocation.
 */
const HOOK_DEFS: Array<{ event: string; matcher?: string; script: string; timeout: number }> = [
  { event: 'SessionEnd', script: 'tuneloop-upload.mjs', timeout: 120 },
  // Shell-edit capture: fingerprint the working tree around every Bash call
  // and record the diff when it changed — the transcript carries no
  // before/after for shell-mediated edits. Tight timeout: PreToolUse blocks.
  { event: 'PreToolUse', matcher: 'Bash', script: 'tuneloop-shell-edit.mjs', timeout: 20 },
  { event: 'PostToolUse', matcher: 'Bash', script: 'tuneloop-shell-edit.mjs', timeout: 20 },
]

function renderHooks(commandFor: (script: string) => string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const d of HOOK_DEFS) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command: commandFor(d.script), timeout: d.timeout }] }
    if (d.matcher) entry.matcher = d.matcher
    hooks[d.event] = [...(hooks[d.event] ?? []), entry]
  }
  return hooks
}

// eslint-disable-next-line no-template-curly-in-string
const HOOKS_JSON = JSON.stringify({ hooks: renderHooks((script) => `node "\${CLAUDE_PLUGIN_ROOT}/bin/${script}"`) }, null, 2)

/** The uploader script with server + token baked in. */
async function renderUploader(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'upload-entry.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/"__TUNELOOP_SERVER__"|'__TUNELOOP_SERVER__'/g, () => JSON.stringify(server))
  script = script.replace(/"__TUNELOOP_TOKEN__"|'__TUNELOOP_TOKEN__'/g, () => JSON.stringify(token))
  return script
}

/** The files that make up the plugin, relative to the plugin root. */
async function pluginFiles(server: string, token: string): Promise<Array<{ path: string; data: string }>> {
  return [
    { path: '.claude-plugin/plugin.json', data: PLUGIN_JSON },
    { path: 'hooks/hooks.json', data: HOOKS_JSON },
    { path: 'bin/tuneloop-upload.mjs', data: await renderUploader(server, token) },
    // Local capture only — no server/token to bake; copied verbatim.
    { path: 'bin/tuneloop-shell-edit.mjs', data: await readFile(join(__dirname, 'shell-edit-entry.js'), 'utf8') },
  ]
}

export async function generateClaudeCode(opts: {
  server: string
  token: string
  output: string
}): Promise<string> {
  const files = await pluginFiles(opts.server, opts.token)
  const zip = createZip(files.map((f) => ({ path: f.path, data: Buffer.from(f.data) })))

  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, zip)
  return opts.output
}

/**
 * The marketplace catalog. `source: "./tuneloop"` resolves relative to the
 * marketplace root (the directory containing `.claude-plugin/`), which is why
 * the plugin must live in a subdirectory of the marketplace — Claude Code
 * rejects absolute paths and won't follow `../` outside the root.
 */
function marketplaceJson(): string {
  return JSON.stringify(
    {
      name: 'tuneloop',
      owner: { name: 'Tuneloop' },
      description: 'Tuneloop session-transcript upload plugin.',
      plugins: [
        {
          name: 'tuneloop',
          source: './tuneloop',
          description: 'Uploads session transcripts to your Tuneloop server on SessionEnd.',
        },
      ],
    },
    null,
    2,
  )
}

/**
 * Emit an unpacked marketplace directory an admin commits to a (private) git
 * repo, so developers install with `/plugin marketplace add <repo>` then
 * `/plugin install tuneloop@tuneloop` — no npx, no unzip.
 *
 *   <outputDir>/
 *   ├── .claude-plugin/marketplace.json
 *   └── tuneloop/                       (the plugin itself)
 *       ├── .claude-plugin/plugin.json
 *       ├── hooks/hooks.json
 *       └── bin/tuneloop-upload
 */
export async function generateClaudeCodeMarketplace(opts: {
  server: string
  token: string
  outputDir: string
}): Promise<{ outputDir: string; marketplaceName: string; pluginRef: string }> {
  await mkdir(join(opts.outputDir, '.claude-plugin'), { recursive: true })
  await writeFile(join(opts.outputDir, '.claude-plugin', 'marketplace.json'), marketplaceJson())

  const pluginRoot = join(opts.outputDir, 'tuneloop')
  for (const file of await pluginFiles(opts.server, opts.token)) {
    const dest = join(pluginRoot, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.data)
  }

  return { outputDir: opts.outputDir, marketplaceName: 'tuneloop', pluginRef: 'tuneloop@tuneloop' }
}

/* ---------------------------------------------------------------------------
 * `--install`: the settings-level path — an alternative to the plugin for
 * teams that manage developer machines through settings.json (config
 * management can push one file; no marketplace, no plugin UI). Writes the
 * scripts under ~/.tuneloop/claude-code/bin and merges the hooks rendered
 * from the SAME HOOK_DEFS spec the plugin uses.
 *
 * Merge policy: validate before touching anything, back up only when the file
 * is pristine (no tuneloop entries yet — later backups would capture the
 * post-install state and defeat "restore the backup"), update our entries in
 * place when the definition changed, never disturb entries that are not
 * ours, refuse shapes we do not understand rather than clobber them, and
 * skip the rewrite entirely when nothing changed (config management re-runs
 * this on a schedule).
 * ------------------------------------------------------------------------- */

function settingsPath(): string {
  return process.env.TUNELOOP_CLAUDE_SETTINGS || join(claudeHome(), 'settings.json')
}

function installBinDir(): string {
  return process.env.TUNELOOP_CLAUDE_BIN || join(homedir(), '.tuneloop', 'claude-code', 'bin')
}

export async function installClaudeCode(opts: { server: string; token: string }): Promise<{ settingsPath: string; binDir: string }> {
  const path = settingsPath()

  // Read + validate BEFORE writing anything, so a refusal never leaves a
  // half-install (new scripts on disk under old hook entries).
  let settings: Record<string, any> = {}
  let existed = false
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`refusing to modify settings that are not a JSON object: ${path}`)
    }
    settings = parsed
    existed = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof SyntaxError) throw new Error(`refusing to modify unparseable settings file: ${path}`)
      throw err
    }
  }
  settings.hooks ??= {}
  for (const d of HOOK_DEFS) {
    const existing = settings.hooks[d.event]
    if (existing !== undefined && !Array.isArray(existing)) {
      // A hand-edited single-object entry (or anything else we don't
      // understand): refusing beats silently deleting the user's hook.
      throw new Error(`refusing to merge into settings.hooks.${d.event}: expected an array, found ${typeof existing}`)
    }
  }

  const binDir = installBinDir()
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'tuneloop-upload.mjs'), await renderUploader(opts.server, opts.token))
  await writeFile(join(binDir, 'tuneloop-shell-edit.mjs'), await readFile(join(__dirname, 'shell-edit-entry.js'), 'utf8'))

  const before = JSON.stringify(settings)
  const isOurs = (h: unknown) => typeof (h as { command?: unknown })?.command === 'string' && ((h as { command: string }).command).includes(binDir)
  const hadOurs = Object.values(settings.hooks as Record<string, unknown>).some(
    (entries) => Array.isArray(entries) && entries.some((e) => (e?.hooks ?? []).some(isOurs)),
  )
  for (const d of HOOK_DEFS) {
    const wantedEntry: Record<string, any> = {
      hooks: [{ type: 'command', command: `node "${join(binDir, d.script)}"`, timeout: d.timeout }],
    }
    if (d.matcher) wantedEntry.matcher = d.matcher
    const entries: any[] = Array.isArray(settings.hooks[d.event]) ? settings.hooks[d.event] : []
    const idx = entries.findIndex((e) => (e?.hooks ?? []).some(isOurs))
    // Update in place when our entry drifted from the current definition
    // (timeout bump, renamed script) — an installer that only ADDs leaves the
    // fleet frozen at first-install values forever.
    if (idx >= 0) entries[idx] = wantedEntry
    else entries.push(wantedEntry)
    settings.hooks[d.event] = entries
  }

  if (JSON.stringify(settings) !== before || !existed) {
    // Back up only a PRISTINE file: a backup taken after our hooks are in
    // already contains them, so "restore the backup" would not restore the
    // pre-tuneloop state.
    if (existed && !hadOurs) {
      try {
        await writeFile(`${path}.bak-${Date.now()}`, before)
      } catch (err) {
        throw new Error(`could not write settings backup next to ${path}: ${(err as Error).message}`)
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(settings, null, 2) + '\n')
  }
  return { settingsPath: path, binDir }
}
