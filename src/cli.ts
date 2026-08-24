import { resolve } from 'node:path'
import { generateClaudeCode, generateClaudeCodeMarketplace } from './generate/claude-code.js'
import { generateCodex, generateCodexManaged, generateCodexMarketplace } from './generate/codex.js'
import { generateCursor, generateCursorMarketplace } from './generate/cursor.js'
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
    --harness <name>   One of: claude-code, codex, cursor, opencode, pi (required)
    -o <path>          Output path (default: current directory)
    --install          Copy to the harness's local plugin directory (opencode, pi)
                       (codex always installs into ~/.codex directly)
    --marketplace      (claude-code, codex, cursor) Emit an unpacked marketplace
                       directory for plugin-install distribution instead of the
                       default output
    --managed          (codex) Emit admin artifacts for an enterprise managed
                       deployment (allow_managed_hooks_only) instead of a local
                       install. Writes the uploader + requirements.toml + README.
    --managed-dir <p>       (codex --managed) Unix managed dir on endpoints
    --managed-dir-windows <p>  (codex --managed) Windows managed dir on endpoints
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

const HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode', 'pi'] as const
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
    if (harness === 'cursor') {
      // Deliberate, not a TODO: Cursor's primary data (tokens, thinking, tool
      // outcomes) exists only while hooks observe it — there is no historical
      // corpus to sweep. Coverage starts at install.
      process.stderr.write('Backfill is not supported for cursor: sessions are captured live via hooks,\nso coverage starts when the plugin is installed.\n')
      return 1
    }
    return runBackfill(serverUrl, token, harness, flags)
  }

  return runGenerate(serverUrl, token, harness, flags)
}

async function runGenerate(server: string, token: string, harness: Harness, flags: Record<string, string | boolean>): Promise<number> {
  const output = str(flags.o) ?? str(flags.output)
  const install = flags.install === true

  // Codex has no drop-in plugin dir: it needs its config.toml edited and the
  // hook trusted via the app-server RPC, so it always installs directly.
  if (harness === 'codex') {
    return runGenerateCodex(server, token, flags)
  }

  // Claude Code marketplace layout for `/plugin install` distribution.
  if (harness === 'claude-code' && flags.marketplace === true) {
    return runGenerateClaudeCodeMarketplace(server, token, flags)
  }

  // Cursor marketplace layout for the Plugins UI's `+ Add` (a git-shaped
  // directory — Cursor loads even a local marketplace via git).
  if (harness === 'cursor' && flags.marketplace === true) {
    return runGenerateCursorMarketplace(server, token, flags)
  }

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
    case 'cursor': {
      const out = output ?? 'tuneloop-cursor.zip'
      result = await generateCursor({ server, token, output: resolve(out), install })
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
  } else if (harness === 'cursor') {
    if (install) {
      process.stdout.write('Hooks merged into ~/.cursor/hooks.json (Cursor hot-reloads; no restart needed).\n')
      process.stdout.write('Verify: the newest cursor.hooks.*.log under Cursor\'s logs must say "Loaded N hook(s)" —\n')
      process.stdout.write('one invalid hook name silently disables ALL hooks.\n')
    } else {
      process.stdout.write('\nInstall the zip as a Cursor plugin (org marketplace or local), or re-run with --install\n')
      process.stdout.write('to register the hooks directly in ~/.cursor/hooks.json.\n')
    }
  }

  return 0
}

async function runGenerateClaudeCodeMarketplace(
  server: string,
  token: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const outputDir = str(flags.o) ?? str(flags.output) ?? 'tuneloop-claude-code-marketplace'
  const res = await generateClaudeCodeMarketplace({ server, token, outputDir: resolve(outputDir) })

  process.stdout.write(`Generated marketplace in ${res.outputDir}:\n`)
  process.stdout.write('  .claude-plugin/marketplace.json\n')
  process.stdout.write('  tuneloop/   — the plugin (server URL + token baked in)\n')
  process.stdout.write('\nTo distribute: commit this directory to a (private) git repo. Developers then run,\n')
  process.stdout.write('inside Claude Code:\n')
  process.stdout.write('  /plugin marketplace add <your-repo>\n')
  process.stdout.write(`  /plugin install ${res.pluginRef}\n`)
  process.stdout.write('\nOr test locally now:\n')
  process.stdout.write(`  claude plugin marketplace add ${res.outputDir} --scope user\n`)
  process.stdout.write(`  claude plugin install ${res.pluginRef} --scope user\n`)
  return 0
}

async function runGenerateCursorMarketplace(
  server: string,
  token: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const outputDir = str(flags.o) ?? str(flags.output) ?? 'tuneloop-cursor-marketplace'
  const res = await generateCursorMarketplace({ server, token, outputDir: resolve(outputDir) })

  process.stdout.write(`Generated marketplace in ${res.outputDir}:\n`)
  process.stdout.write('  .cursor-plugin/marketplace.json\n')
  process.stdout.write('  tuneloop/   — the plugin (server URL + token baked in)\n')
  if (res.gitReady) {
    process.stdout.write('  (initialized as a git repo — Cursor loads marketplaces via git, even local ones)\n')
  } else {
    process.stdout.write('\nWARNING: could not git-init the directory. Cursor resolves a marketplace via\n')
    process.stdout.write('git even for a local path — run `git init && git add -A && git commit` inside\n')
    process.stdout.write('it or the plugin will fail to load after install.\n')
  }
  process.stdout.write('\nTo distribute: push this directory to a (private) git repo. Developers then, in\n')
  process.stdout.write('Cursor: Plugins panel -> + Add -> the repo URL -> Install "tuneloop".\n')
  process.stdout.write(`\nOr test locally now: Plugins panel -> + Add -> ${res.outputDir}\n`)
  process.stdout.write('\nUpdates ship by committing: installs pin to the marketplace’s commit.\n')
  return 0
}

async function runGenerateCodex(
  server: string,
  token: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  if (flags.managed === true) {
    return runGenerateCodexManaged(server, token, flags)
  }
  if (flags.marketplace === true) {
    return runGenerateCodexMarketplace(server, token, flags)
  }

  const res = await generateCodex({ server, token })

  if (!res.present) {
    process.stderr.write('Codex not found on this machine (no ~/.codex directory). Nothing installed.\n')
    return 1
  }

  process.stdout.write(`Installed uploader: ${res.uploaderPath}\n`)
  process.stdout.write(`Hooked SessionEnd in: ${res.configPath}\n`)

  if (res.alreadyTrusted) {
    process.stdout.write('Already installed and trusted — nothing changed.\n')
  } else if (res.trusted) {
    process.stdout.write('Hook is trusted and will fire when your next Codex session ends.\n')
  } else if (res.needsManualTrust) {
    process.stdout.write('\nCodex could not auto-trust the hook. Trust it once, manually:\n')
    process.stdout.write('  start Codex, run  /hooks , and approve the tuneloop SessionEnd hook.\n')
  }

  return 0
}

// Default managed directories. Codex documents no default (the admin sets
// managed_dir / windows_managed_dir), so these are sensible starting points
// co-located with the managed requirements.toml; override per fleet.
const DEFAULT_MANAGED_DIR = '/etc/codex/hooks'
const DEFAULT_WINDOWS_MANAGED_DIR = 'C:\\ProgramData\\OpenAI\\Codex\\hooks'

async function runGenerateCodexMarketplace(
  server: string,
  token: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const outputDir = str(flags.o) ?? str(flags.output) ?? 'tuneloop-codex-marketplace'
  const res = await generateCodexMarketplace({ server, token, outputDir: resolve(outputDir) })

  process.stdout.write(`Generated Codex marketplace in ${res.outputDir}:\n`)
  process.stdout.write('  .agents/plugins/marketplace.json\n')
  process.stdout.write(`  plugins/tuneloop/   — the plugin (server URL + token baked in)\n`)
  process.stdout.write('\nTo distribute: commit this directory to a (private) git repo. Developers then run:\n')
  process.stdout.write('  codex plugin marketplace add <your-repo>\n')
  process.stdout.write(`  codex plugin add ${res.pluginRef}\n`)
  process.stdout.write('then trust the hook once inside Codex with /hooks (plugin hooks are not auto-trusted).\n')
  process.stdout.write('\nOr test locally now:\n')
  process.stdout.write(`  codex plugin marketplace add ${res.outputDir}\n`)
  process.stdout.write(`  codex plugin add ${res.pluginRef}\n`)
  return 0
}

async function runGenerateCodexManaged(
  server: string,
  token: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const outputDir = str(flags.o) ?? str(flags.output) ?? 'tuneloop-codex-managed'
  const managedDir = str(flags['managed-dir']) ?? DEFAULT_MANAGED_DIR
  const windowsManagedDir = str(flags['managed-dir-windows']) ?? DEFAULT_WINDOWS_MANAGED_DIR

  const res = await generateCodexManaged({
    server,
    token,
    outputDir: resolve(outputDir),
    managedDir,
    windowsManagedDir,
  })

  process.stdout.write(`Generated managed Codex artifacts in ${res.outputDir}:\n`)
  process.stdout.write(`  ${res.scriptPath.split('/').pop()}        — uploader (deploy to ${res.managedDir})\n`)
  process.stdout.write('  requirements.toml   — merge into your managed config\n')
  process.stdout.write('  README-admin.md     — deployment steps\n')
  process.stdout.write('\nDistribute both files via your MDM. See README-admin.md for the exact paths.\n')
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
