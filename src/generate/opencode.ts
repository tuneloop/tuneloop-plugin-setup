import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The bundled OpenCode plugin (dist/opencode-plugin.js) with server + token baked in.
 *  Global substitution; the placeholders only ever appear as plain string literals
 *  (never interpolated), so a quoted-token replace is exact. A function replacer is
 *  used so `$`-sequences in a token (e.g. `$&`) are inserted verbatim, not treated
 *  as `String.replace` special patterns. */
async function renderPlugin(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'opencode-plugin.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/'__TUNELOOP_SERVER__'|"__TUNELOOP_SERVER__"/g, () => JSON.stringify(server))
  script = script.replace(/'__TUNELOOP_TOKEN__'|"__TUNELOOP_TOKEN__"/g, () => JSON.stringify(token))
  return script
}

export async function generateOpencode(opts: { server: string; token: string; output: string; install?: boolean }): Promise<string> {
  const content = await renderPlugin(opts.server, opts.token)

  // Output as a single .js file (OpenCode discovers plugins via plugins/*.{ts,js}).
  const outputPath = opts.output.endsWith('.js') ? opts.output : join(opts.output, 'tuneloop.js')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, content)

  if (opts.install) {
    // OpenCode reads plugins from $XDG_CONFIG_HOME (default ~/.config).
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    const dest = join(configHome, 'opencode', 'plugins', 'tuneloop.js')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content)
    return dest
  }
  return outputPath
}
