import { readFile } from 'node:fs/promises'
import { writeFile, mkdir } from 'node:fs/promises'
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
