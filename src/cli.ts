import { resolve } from 'node:path'
import { generateClaudeCode } from './generate/claude-code.js'
import { generateOpencode } from './generate/opencode.js'
import { generatePi } from './generate/pi.js'
import { backfill, type SourceSummary } from './backfill.js'
import { CLIENT_VERSION } from './upload.js'

interface Args {
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) continue
    const eq = arg.indexOf('=')
    if (eq > 0) {
      flags[arg.replace(/^-+/, '').slice(0, eq - arg.lastIndexOf('-', eq) - 1 || undefined)] = arg.slice(eq + 1)
      const name = arg.slice(arg.startsWith('--') ? 2 : 1, eq)
      flags[name] = arg.slice(eq + 1)
      continue
    }
    const name = arg.replace(/^-+/, '')
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { flags }
}

const USAGE = `tuneloop-plugin-setup ${CLIENT_VERSION}

  Generate a plugin for your AI coding harness that uploads session
  transcripts to a Tuneloop server.

  Usage:
    npx tuneloop-plugin-setup --server <url> --token <token> --harness <name> [-o <path>]

  Options:
    --server <url>     Tuneloop server URL (required)
    --token <token>    Ingest token (required)
    --harness <name>   One of: claude-code, opencode, pi (required)
    -o <path>          Output path (default: current directory)
    --install          Copy to the harness's local plugin directory (opencode, pi)
    --backfill         Upload existing sessions that predate installation
    --since <days>     Backfill only sessions modified within N days
    --limit <n>        Cap number of sessions to backfill
    --dry-run          Preview what would be uploaded (with --backfill)
    --quiet            Suppress progress output
    --help             Show this help

  Examples:
    npx tuneloop-plugin-setup \\
      --server https://tuneloop.yourcompany.com \\
      --token <your-ingest-token> \\
      --harness claude-code \\
      -o tuneloop-claude-code.zip

    npx tuneloop-plugin-setup \\
      --server https://tuneloop.yourcompany.com \\
      --token <your-ingest-token> \\
      --harness claude-code --backfill --dry-run
`

const HARNESSES = ['claude-code', 'opencode', 'pi'] as const
type Harness = (typeof HARNESSES)[number]

async function main(): Promise<number> {
  const { flags } = parseArgs(process.argv.slice(2))

  if (flags.help || flags.h) {
    process.stdout.write(USAGE)
    return 0
  }

  const server = str(flags.server)
  const token = str(flags.token)
  const harness = str(flags.harness) as Harness | undefined

  if (!server || !token || !harness) {
    process.stderr.write('Required: --server <url> --token <token> --harness <name>\n\n')
    process.stdout.write(USAGE)
    return 1
  }

  if (!HARNESSES.includes(harness)) {
    process.stderr.write(`Unknown harness "${harness}". Must be one of: ${HARNESSES.join(', ')}\n`)
    return 1
  }

  const serverUrl = server.replace(/\/+$/, '')

  if (flags.backfill) {
    return runBackfill(serverUrl, token, harness, flags)
  }

  return runGenerate(serverUrl, token, harness, flags)
}

async function runGenerate(server: string, token: string, harness: Harness, flags: Record<string, string | boolean>): Promise<number> {
  const output = str(flags.o) ?? str(flags.output)
  const install = flags.install === true

  let result: string

  switch (harness) {
    case 'claude-code': {
      const out = output ?? 'tuneloop-claude-code.zip'
      result = await generateClaudeCode({ server, token, output: resolve(out) })
      break
    }
    case 'opencode': {
      const out = output ?? 'tuneloop-opencode.js'
      result = await generateOpencode({ server, token, output: resolve(out), install })
      break
    }
    case 'pi': {
      const out = output ?? 'tuneloop-pi-extension.ts'
      result = await generatePi({ server, token, output: resolve(out), install })
      break
    }
  }

  process.stdout.write(`Generated: ${result}\n`)

  if (harness === 'claude-code') {
    process.stdout.write('\nTo use:\n')
    process.stdout.write(`  claude --plugin-dir ./${result.split('/').pop()}\n`)
    process.stdout.write('\nOr upload to your org marketplace for enterprise rollout.\n')
  } else if (harness === 'opencode' && install) {
    process.stdout.write('Installed to OpenCode plugins directory. Restart OpenCode to activate.\n')
  } else if (harness === 'pi' && install) {
    process.stdout.write('Installed to Pi extensions directory. Restart Pi to activate.\n')
  }

  return 0
}

async function runBackfill(server: string, token: string, harness: Harness, flags: Record<string, string | boolean>): Promise<number> {
  const quiet = flags.quiet === true
  const dryRun = flags['dry-run'] === true

  const summaries = await backfill({
    server,
    token,
    sources: [harness === 'claude-code' ? 'claude-code' : harness],
    sinceDays: num(flags.since),
    limit: num(flags.limit),
    concurrency: num(flags.concurrency),
    dryRun,
    onProgress: quiet
      ? undefined
      : (e) => {
          const n = `${e.index + 1}/${e.total}`
          const name = e.label.split('/').pop() ?? e.label
          const line = `  ${e.source} ${n} ${e.status.padEnd(8)} ${name}${e.error ? ` — ${e.error}` : ''}`
          if (process.stdout.isTTY && !e.error) process.stdout.write(`\r\x1b[2K${line.slice(0, 100)}`)
          else process.stdout.write(`${line}\n`)
        },
  })

  if (process.stdout.isTTY && !quiet) process.stdout.write('\r\x1b[2K')
  if (!quiet) printBackfill(summaries, dryRun)
  return summaries.some((s) => s.failed > 0) ? 1 : 0
}

function printBackfill(summaries: SourceSummary[], dryRun: boolean): void {
  if (summaries.length === 0) {
    process.stdout.write('No transcripts found on this machine.\n')
    return
  }
  const lines: string[] = ['']
  let bytes = 0
  for (const s of summaries) {
    bytes += s.bytesUploaded
    const parts = dryRun
      ? [`${s.found} to upload`]
      : [`${s.uploaded} uploaded`, `${s.deduped} already had`, ...(s.failed ? [`${s.failed} FAILED`] : [])]
    lines.push(`  ${s.source.padEnd(12)} ${parts.join(', ')}`)
  }
  if (!dryRun && bytes > 0) lines.push(`  ${''.padEnd(12)} ${(bytes / 1024 / 1024).toFixed(1)}MB sent`)
  if (!dryRun) lines.push('', '  Analysis runs in the background — give the worker a moment, then reload the dashboard.')
  process.stdout.write(lines.join('\n') + '\n')
}

function num(v: string | boolean | undefined): number | undefined {
  const parsed = typeof v === 'string' ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`tuneloop-plugin-setup: ${(err as Error).message}\n`)
    process.exitCode = 1
  })
