import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The bundled Pi extension (dist/pi-extension.js) with server + token baked in.
 *  Written with a `.ts` name on install — bundled JS is valid TS, so Pi's loader
 *  handles it. Global substitution; placeholders only appear as string literals. A
 *  function replacer is used so `$`-sequences in a token (e.g. `$&`) are inserted
 *  verbatim, not treated as `String.replace` special patterns. */
async function renderExtension(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'pi-extension.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/'__TUNELOOP_SERVER__'|"__TUNELOOP_SERVER__"/g, () => JSON.stringify(server))
  script = script.replace(/'__TUNELOOP_TOKEN__'|"__TUNELOOP_TOKEN__"/g, () => JSON.stringify(token))
  return script
}

export async function generatePi(opts: { server: string; token: string; output: string; install?: boolean }): Promise<string> {
  const content = await renderExtension(opts.server, opts.token)
  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, content)

  if (opts.install) {
    const dest = join(homedir(), '.pi', 'agent', 'extensions', 'tuneloop-upload.ts')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content)
    return dest
  }
  return opts.output
}
