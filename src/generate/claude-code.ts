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

export async function generateClaudeCode(opts: {
  server: string
  token: string
  output: string
}): Promise<string> {
  const templatePath = join(__dirname, 'upload-entry.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/"__TUNELOOP_SERVER__"|'__TUNELOOP_SERVER__'/, JSON.stringify(opts.server))
  script = script.replace(/"__TUNELOOP_TOKEN__"|'__TUNELOOP_TOKEN__'/, JSON.stringify(opts.token))

  const zip = createZip([
    { path: '.claude-plugin/plugin.json', data: Buffer.from(PLUGIN_JSON) },
    { path: 'hooks/hooks.json', data: Buffer.from(HOOKS_JSON) },
    { path: 'bin/tuneloop-upload', data: Buffer.from(script) },
  ])

  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, zip)
  return opts.output
}
