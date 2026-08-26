import { readFile } from 'node:fs/promises'
import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip } from '../zip.js'

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

const HOOKS_JSON = JSON.stringify(
  {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/tuneloop-upload"',
              timeout: 120,
            },
          ],
        },
      ],
      // Shell-edit capture: fingerprint the working tree around every Bash
      // call and record the diff when it changed — the transcript carries no
      // before/after for shell-mediated edits (sed/python/redirects), so this
      // hook OBSERVES them. Tight timeout: PreToolUse blocks the tool.
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/tuneloop-shell-edit"',
              timeout: 20,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/tuneloop-shell-edit"',
              timeout: 20,
            },
          ],
        },
      ],
    },
  },
  null,
  2,
)

/** The uploader script with server + token baked in. */
async function renderUploader(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'upload-entry.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/"__TUNELOOP_SERVER__"|'__TUNELOOP_SERVER__'/g, () => JSON.stringify(server))
  script = script.replace(/"__TUNELOOP_TOKEN__"|'__TUNELOOP_TOKEN__'/g, () => JSON.stringify(token))
  return script
}

/** The three files that make up the plugin, relative to the plugin root. */
async function pluginFiles(server: string, token: string): Promise<Array<{ path: string; data: string }>> {
  return [
    { path: '.claude-plugin/plugin.json', data: PLUGIN_JSON },
    { path: 'hooks/hooks.json', data: HOOKS_JSON },
    { path: 'bin/tuneloop-upload', data: await renderUploader(server, token) },
    // Local capture only — no server/token to bake; copied verbatim.
    { path: 'bin/tuneloop-shell-edit', data: await readFile(join(__dirname, 'shell-edit-entry.js'), 'utf8') },
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
 * scripts under ~/.tuneloop/claude-code/bin and merges the three hooks into
 * the user-level settings.json with absolute paths. Functionally identical
 * to the plugin: same scripts, same capture, same upload.
 *
 * Merge policy: back up first, refuse to touch a file we cannot parse, and
 * never disturb entries that are not ours (ours are recognizable by the
 * script path).
 * ------------------------------------------------------------------------- */

function settingsPath(): string {
  const override = process.env.TUNELOOP_CLAUDE_SETTINGS
  if (override) return override
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'settings.json')
}

export async function installClaudeCode(opts: { server: string; token: string }): Promise<{ settingsPath: string; binDir: string }> {
  const binDir = join(homedir(), '.tuneloop', 'claude-code', 'bin')
  await mkdir(binDir, { recursive: true })
  const uploadPath = join(binDir, 'tuneloop-upload.mjs')
  const shellEditPath = join(binDir, 'tuneloop-shell-edit.mjs')
  await writeFile(uploadPath, await renderUploader(opts.server, opts.token))
  await writeFile(shellEditPath, await readFile(join(__dirname, 'shell-edit-entry.js'), 'utf8'))

  const path = settingsPath()
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(`${path}.bak-${Date.now()}`, JSON.stringify(settings, null, 2))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`refusing to modify unparseable settings file: ${path}`)
    }
  }

  settings.hooks ??= {}
  const wanted: Array<{ event: string; matcher?: string; command: string; timeout: number }> = [
    { event: 'SessionEnd', command: `node "${uploadPath}"`, timeout: 120 },
    { event: 'PreToolUse', matcher: 'Bash', command: `node "${shellEditPath}"`, timeout: 20 },
    { event: 'PostToolUse', matcher: 'Bash', command: `node "${shellEditPath}"`, timeout: 20 },
  ]
  for (const w of wanted) {
    const entries: any[] = Array.isArray(settings.hooks[w.event]) ? settings.hooks[w.event] : []
    const ours = entries.some((e) =>
      (e?.hooks ?? []).some((h: any) => typeof h?.command === 'string' && h.command.includes(binDir)),
    )
    if (!ours) {
      const entry: Record<string, any> = { hooks: [{ type: 'command', command: w.command, timeout: w.timeout }] }
      if (w.matcher) entry.matcher = w.matcher
      entries.push(entry)
    }
    settings.hooks[w.event] = entries
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n')
  return { settingsPath: path, binDir }
}
