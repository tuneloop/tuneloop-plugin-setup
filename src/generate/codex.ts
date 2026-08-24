/**
 * Installing Codex's `SessionEnd` hook, with two Codex-specific hurdles.
 *
 * 1. **Trust.** Codex won't run a user hook until it's trusted: a `[hooks.state]`
 *    entry whose `trusted_hash` matches the hash Codex computes for the hook
 *    (a wrong hash means it silently never fires). Rather than reproduce Codex's
 *    undocumented hashing, we let Codex hand us the canonical key and hash via
 *    its `app-server` `hooks/list` RPC, write those, then re-list to confirm
 *    `trusted`. On any failure we leave the hook untrusted and have the CLI print
 *    the one-time `/hooks` instruction — graceful degradation.
 * 2. **Timeout.** Codex clamps `SessionEnd` to ~3s, so the hook runs the bundled
 *    uploader with `--detach` (see codex-upload-entry.ts), handing the work to a
 *    child that outlives it.
 *
 * Unlike the other harnesses this must edit Codex's own `config.toml` (there is
 * no drop-in plugin directory), so the hook lives between `# >>> tuneloop`
 * markers and is rewritten by string surgery — no TOML library (this tool stays
 * dependency-free). The self-contained uploader (server + token baked in) is
 * written next to it in `CODEX_HOME`.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexHome } from '../codex.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const BEGIN = '# >>> tuneloop-upload (managed) — do not edit by hand'
const END = '# <<< tuneloop-upload'

// The installer and backfill share one Codex-home resolver (see ../codex.ts) so
// a custom CODEX_HOME can never point them at different locations.
export { codexHome }

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml')
}

/** Where the self-contained uploader is written. */
export function codexUploaderPath(): string {
  return join(codexHome(), 'tuneloop-upload.mjs')
}

/**
 * The command Codex runs on SessionEnd. Guarded so a removed uploader is a
 * no-op, and `--detach` because of the 3s cap.
 */
export function codexHookCommand(uploaderPath: string): string {
  const path = quotePosixShellArg(uploaderPath)
  return `[ -f ${path} ] && node ${path} --detach || true`
}

/** Quote one argument for a POSIX shell without allowing any expansion. */
export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

interface HookState {
  key: string
  trustedHash: string
}

/**
 * A TOML string for an arbitrary value. Prefers a literal string (single quotes,
 * no escaping), and falls back to a basic string when the value itself contains
 * a single quote. Codex hashes the parsed value, so the quoting style never
 * affects the trust hash.
 */
export function tomlString(s: string): string {
  if (!s.includes("'")) return `'${s}'`
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The managed config block, optionally carrying the trust state. */
export function buildCodexBlock(command: string, state?: HookState): string {
  const lines = [
    BEGIN,
    '[[hooks.SessionEnd]]',
    '[[hooks.SessionEnd.hooks]]',
    'type = "command"',
    `command = ${tomlString(command)}`,
    'timeout = 3',
  ]
  if (state) {
    lines.push('', `[hooks.state."${state.key}"]`, 'enabled = true', `trusted_hash = "${state.trustedHash}"`)
  }
  lines.push(END)
  return lines.join('\n')
}

/** Remove any existing managed block (and the blank lines hugging it). */
export function stripCodexBlock(text: string): string {
  const start = text.indexOf(BEGIN)
  if (start === -1) return text
  const endMarker = text.indexOf(END, start)
  if (endMarker === -1) return text // truncated block — leave it rather than guess
  const end = endMarker + END.length
  return (text.slice(0, start).replace(/\n*$/, '') + '\n' + text.slice(end).replace(/^\n*/, '')).replace(/\n*$/, '') + '\n'
}

/** Append our block to `text`, replacing any prior copy of it. */
export function mergeCodexBlock(text: string, block: string): string {
  const base = stripCodexBlock(text)
  const body = base.trim() ? base.replace(/\n*$/, '') + '\n\n' : ''
  return body + block + '\n'
}

export interface CodexHooksEntry {
  key: string
  eventName: string
  command: string
  source: string
  trustStatus: string
  currentHash: string
}

/**
 * Drive `codex app-server` over stdio JSON-RPC and return every configured hook.
 *
 * The handshake is `initialize` → `initialized` → `hooks/list`; the server also
 * emits unrelated notifications, so responses are matched by request id. Any
 * failure (Codex absent from PATH, protocol drift, timeout) resolves to null so
 * the caller degrades to manual trust rather than blocking the install.
 */
export function codexHooksList(env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CodexHooksEntry[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }

    let settled = false
    const done = (result: CodexHooksEntry[] | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve(result)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    // Fail fast and never let an async stream error escape the promise: a codex
    // that exits mid-handshake would otherwise surface an uncaught EPIPE on a
    // later tick, outside installCodexHook's try/catch.
    child.on('error', () => done(null))
    child.on('close', () => done(null))
    child.stdin!.on('error', () => done(null))
    child.stdout!.on('error', () => done(null))

    const send = (o: unknown) => {
      try {
        child.stdin!.write(JSON.stringify(o) + '\n')
      } catch {
        done(null)
      }
    }

    let buf = ''
    let initialized = false
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: { id?: unknown; result?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 0 && !initialized) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 1, method: 'hooks/list', params: {} })
        } else if (msg.id === 1) {
          done(parseHooksList(msg.result))
        }
      }
    })

    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'tuneloop-plugin-setup', version: '1' } } })
  })
}

function parseHooksList(result: unknown): CodexHooksEntry[] {
  const data = (result as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: CodexHooksEntry[] = []
  for (const ctx of data) {
    const hooks = (ctx as { hooks?: unknown })?.hooks
    if (!Array.isArray(hooks)) continue
    for (const h of hooks as Array<Record<string, unknown>>) {
      out.push({
        key: str(h.key),
        eventName: str(h.eventName),
        command: str(h.command),
        source: str(h.source),
        trustStatus: str(h.trustStatus),
        currentHash: str(h.currentHash),
      })
    }
  }
  return out
}

/**
 * Our SessionEnd hook among whatever else is configured. Matched on the
 * distinctive uploader filename rather than the absolute path (which varies by
 * `CODEX_HOME`) — this substring is unique to the block we write.
 */
const HOOK_FINGERPRINT = 'tuneloop-upload.mjs'

export function findOurHook(entries: CodexHooksEntry[]): CodexHooksEntry | undefined {
  return entries.find((e) => e.eventName === 'sessionEnd' && e.command.includes(HOOK_FINGERPRINT))
}

export interface CodexResult {
  /** Codex is installed on this machine (its home dir exists). */
  present: boolean
  /** The hook block was written to config.toml. */
  installed: boolean
  /** Codex reports the hook as trusted — it will fire without any manual step. */
  trusted: boolean
  /** The block was already present and trusted; nothing changed. */
  alreadyTrusted: boolean
  /** Print the one-time `/hooks` instruction: installed but not verifiably trusted. */
  needsManualTrust: boolean
  /** Where the uploader was written, once installed. */
  uploaderPath?: string
  /** The edited config file. */
  configPath?: string
}

const ABSENT: CodexResult = {
  present: false,
  installed: false,
  trusted: false,
  alreadyTrusted: false,
  needsManualTrust: false,
}

/**
 * Read the bundled uploader template and bake in the server + token, mirroring
 * generateClaudeCode. The template ships next to this module in `dist/`.
 */
async function renderUploader(server: string, token: string): Promise<string> {
  const templatePath = join(__dirname, 'codex-upload-entry.js')
  let script = await readFile(templatePath, 'utf8')
  script = script.replace(/"__TUNELOOP_SERVER__"|'__TUNELOOP_SERVER__'/g, () => JSON.stringify(server))
  script = script.replace(/"__TUNELOOP_TOKEN__"|'__TUNELOOP_TOKEN__'/g, () => JSON.stringify(token))
  return script
}

export interface GenerateCodexOptions {
  server: string
  token: string
}

/**
 * Install (and trust, when possible) the Codex SessionEnd hook. Never throws:
 * a failure here surfaces as `present: false` rather than aborting the CLI.
 */
export async function generateCodex(opts: GenerateCodexOptions): Promise<CodexResult> {
  try {
    if (!existsSync(codexHome())) return ABSENT

    const configPath = codexConfigPath()
    const uploaderPath = codexUploaderPath()
    const command = codexHookCommand(uploaderPath)
    const env = { ...process.env, CODEX_HOME: codexHome() }

    // Write the self-contained uploader (server + token baked in) first, so the
    // hash Codex computes covers a command whose target already exists.
    await writeUploader(uploaderPath, await renderUploader(opts.server, opts.token))

    // Fast path: only an already-trusted hook with the current command is done.
    // Command changes must be rewritten and re-trusted during upgrades.
    const before = await codexHooksList(env)
    if (before) {
      const existing = findOurHook(before)
      if (existing?.trustStatus === 'trusted' && existing.command === command) {
        return { present: true, installed: true, trusted: true, alreadyTrusted: true, needsManualTrust: false, uploaderPath, configPath }
      }
    }

    // 1. Write the hook definition (no trust state yet).
    await writeConfig(configPath, mergeCodexBlock(await readConfig(configPath), buildCodexBlock(command)))

    // 2. Ask Codex for the hook's canonical key and the hash it computes.
    const listed = await codexHooksList(env)
    const ours = listed ? findOurHook(listed) : undefined
    if (!ours || !ours.key || !ours.currentHash) {
      // Can't verify — leave the (untrusted) hook and fall back to manual trust.
      return { present: true, installed: true, trusted: false, alreadyTrusted: false, needsManualTrust: true, uploaderPath, configPath }
    }

    // 3. Write the trust state using Codex's own reported values, then confirm.
    await writeConfig(
      configPath,
      mergeCodexBlock(await readConfig(configPath), buildCodexBlock(command, { key: ours.key, trustedHash: ours.currentHash })),
    )
    const after = await codexHooksList(env)
    const verified = after ? findOurHook(after) : undefined
    if (verified?.trustStatus === 'trusted') {
      return { present: true, installed: true, trusted: true, alreadyTrusted: false, needsManualTrust: false, uploaderPath, configPath }
    }

    // 4. Verification failed — strip the (unverified) trust state so we never
    // leave a `Modified` hash behind, and degrade to the manual instruction.
    await writeConfig(configPath, mergeCodexBlock(await readConfig(configPath), buildCodexBlock(command)))
    return { present: true, installed: true, trusted: false, alreadyTrusted: false, needsManualTrust: true, uploaderPath, configPath }
  } catch {
    return ABSENT
  }
}

async function writeUploader(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tuneloop-tmp`
  await writeFile(tmp, body)
  await rename(tmp, path)
}

async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function writeConfig(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Back up the pristine pre-tuneloop file, then write through a temp file so an
  // interrupted write can't corrupt a developer's config. Only back up genuine
  // foreign content: a single run rewrites this file up to three times, so
  // backing up unconditionally would overwrite the good backup with our block.
  if (existsSync(path)) {
    const current = await readFile(path, 'utf8')
    if (!current.includes(BEGIN)) await writeFile(`${path}.tuneloop-backup`, current)
  }
  const tmp = `${path}.tuneloop-tmp`
  await writeFile(tmp, body)
  await rename(tmp, path)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/* ------------------------------------------------------------------------- *
 * Managed (enterprise) mode.
 *
 * When a fleet sets `allow_managed_hooks_only = true`, Codex ignores every
 * user/project/session/plugin hook and loads only hooks from the managed
 * `requirements.toml` (Unix: /etc/codex/requirements.toml, Windows:
 * %ProgramData%\OpenAI\Codex\requirements.toml). Managed hooks are trusted by
 * policy — no `hooks/list` trust dance — but Codex does *not* distribute the
 * scripts: the admin ships both the uploader (into `managed_dir`) and the
 * requirements.toml block via their own device management (MDM).
 *
 * So the user-install flow above does not apply. Instead we generate the two
 * artifacts an admin distributes, plus a short README. This never touches the
 * local machine's config or talks to `app-server`.
 * ------------------------------------------------------------------------- */

const UPLOADER_NAME = 'tuneloop-upload.mjs'

/** Join a POSIX managed dir with the uploader name, tolerant of a trailing slash. */
function posixUploaderPath(dir: string): string {
  return `${dir.replace(/\/+$/, '')}/${UPLOADER_NAME}`
}

/** Join a Windows managed dir with the uploader name, tolerant of a trailing slash. */
function windowsUploaderPath(dir: string): string {
  return `${dir.replace(/\\+$/, '')}\\${UPLOADER_NAME}`
}

/**
 * The `requirements.toml` fragment an admin merges into the managed config.
 *
 * `--detach` is still needed: the ~3s SessionEnd clamp is a runtime limit,
 * unrelated to whether the hook is user or managed. The uploader is guaranteed
 * present (MDM installs it), so the command drops the existence guard the
 * user-install path uses. Windows paths carry backslashes, so `tomlString`
 * emits them as literal strings (single quotes) — matching the Codex docs.
 */
export function buildManagedRequirements(managedDir: string, windowsManagedDir: string): string {
  const unixCommand = `node ${quotePosixShellArg(posixUploaderPath(managedDir))} --detach`
  const windowsCommand = `node "${windowsUploaderPath(windowsManagedDir)}" --detach`
  return [
    '# Managed Tuneloop SessionEnd hook for Codex.',
    '# Merge this into your managed requirements.toml — see README-admin.md.',
    '',
    '# Only managed hooks run in this deployment; user hooks are ignored.',
    'allow_managed_hooks_only = true',
    '',
    '[features]',
    'hooks = true',
    '',
    '[hooks]',
    `managed_dir = ${tomlString(managedDir)}`,
    `windows_managed_dir = ${tomlString(windowsManagedDir)}`,
    '',
    '[[hooks.SessionEnd]]',
    '[[hooks.SessionEnd.hooks]]',
    'type = "command"',
    `command = ${tomlString(unixCommand)}`,
    `command_windows = ${tomlString(windowsCommand)}`,
    'timeout = 3',
    '',
  ].join('\n')
}

function buildManagedReadme(managedDir: string, windowsManagedDir: string): string {
  return `# Tuneloop — Codex managed-hook deployment (enterprise)

These artifacts are for a fleet running \`allow_managed_hooks_only = true\`, where
Codex ignores user-installed hooks. Distribute them with your device management
(MDM); Codex does not distribute hook scripts itself. Developers run nothing and
cannot disable the hook.

## Files in this directory
- \`${UPLOADER_NAME}\` — the self-contained uploader (server URL + token already
  baked in). Requires Node.js 22+ on each endpoint.
- \`requirements.toml\` — the managed hook block to merge into your managed config.

## Steps
1. **Install the uploader** on every endpoint, via MDM:
   - macOS / Linux: copy \`${UPLOADER_NAME}\` to \`${posixUploaderPath(managedDir)}\`
   - Windows: copy \`${UPLOADER_NAME}\` to \`${windowsUploaderPath(windowsManagedDir)}\`
   (Adjust the paths with \`--managed-dir\` / \`--managed-dir-windows\` at generation
   time if your managed directory differs; the requirements.toml above must point
   at wherever the script actually lands.)
2. **Merge \`requirements.toml\`** into the managed config, distributed via MDM:
   - macOS / Linux: \`/etc/codex/requirements.toml\`
   - Windows: \`%ProgramData%\\OpenAI\\Codex\\requirements.toml\`
   If a managed \`requirements.toml\` already exists, merge the \`[hooks]\` and
   \`[[hooks.SessionEnd]]\` entries into it rather than overwriting.
3. **Ensure Node.js 22+** is on the PATH for the Codex process on each endpoint.

No trust step is required — managed hooks are trusted by policy and fire when a
Codex session ends. The upload runs in a detached child, so the ~3s SessionEnd
limit never blocks a session.
`
}

export interface GenerateCodexManagedOptions {
  server: string
  token: string
  /** Directory to write the three artifacts into. */
  outputDir: string
  /** Absolute Unix managed dir the uploader will be installed to on endpoints. */
  managedDir: string
  /** Absolute Windows managed dir the uploader will be installed to on endpoints. */
  windowsManagedDir: string
}

export interface CodexManagedResult {
  outputDir: string
  scriptPath: string
  requirementsPath: string
  readmePath: string
  managedDir: string
  windowsManagedDir: string
}

/**
 * Generate the admin artifacts for a managed Codex deployment. Writes the
 * baked-in uploader, a requirements.toml fragment, and an admin README into
 * `outputDir`. Does not touch the local Codex config or the network.
 */
export async function generateCodexManaged(opts: GenerateCodexManagedOptions): Promise<CodexManagedResult> {
  await mkdir(opts.outputDir, { recursive: true })

  const scriptPath = join(opts.outputDir, UPLOADER_NAME)
  await writeFile(scriptPath, await renderUploader(opts.server, opts.token))

  const requirementsPath = join(opts.outputDir, 'requirements.toml')
  await writeFile(requirementsPath, buildManagedRequirements(opts.managedDir, opts.windowsManagedDir))

  const readmePath = join(opts.outputDir, 'README-admin.md')
  await writeFile(readmePath, buildManagedReadme(opts.managedDir, opts.windowsManagedDir))

  return {
    outputDir: opts.outputDir,
    scriptPath,
    requirementsPath,
    readmePath,
    managedDir: opts.managedDir,
    windowsManagedDir: opts.windowsManagedDir,
  }
}

/* ------------------------------------------------------------------------- *
 * Marketplace mode (Codex plugin, for `codex plugin add`).
 *
 * Codex plugins follow the "Agent Plugins" convention: the marketplace manifest
 * lives at `<repo>/.agents/plugins/marketplace.json`, and a plugin's `source`
 * path resolves relative to the repo root (verified empirically). A plugin is a
 * `.codex-plugin/plugin.json` manifest pointing at `hooks/hooks.json`, whose
 * command references the installed plugin via `${PLUGIN_ROOT}`.
 *
 * Codex passes the SessionEnd payload (transcript_path, cwd, session_id) on
 * stdin to plugin hooks, so the same baked-in uploader works. `--detach` handles
 * the SessionEnd time cap. Plugin hooks are NOT auto-trusted on install: the
 * developer trusts once via `/hooks` (Codex's intended flow).
 * ------------------------------------------------------------------------- */

const PLUGIN_NAME = 'tuneloop'
const MARKETPLACE_NAME = 'tuneloop'

/** `.codex-plugin/plugin.json` — points at the hooks file. */
function codexPluginManifest(): string {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: '0.1.0',
      description: 'Uploads session transcripts to your Tuneloop server on SessionEnd.',
      author: { name: 'Tuneloop', email: 'bbhat@tuneloop.io' },
      hooks: './hooks/hooks.json',
    },
    null,
    2,
  )
}

/** `hooks/hooks.json` — SessionEnd runs the baked-in uploader via ${PLUGIN_ROOT}. */
function codexPluginHooks(): string {
  return JSON.stringify(
    {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                // ${PLUGIN_ROOT} resolves to the installed plugin dir; --detach
                // hands the upload to a child so SessionEnd never blocks.
                command: `node "\${PLUGIN_ROOT}/bin/${UPLOADER_NAME}" --detach`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )
}

/** `.agents/plugins/marketplace.json` — lists the plugin by repo-relative path. */
function codexMarketplaceManifest(): string {
  return JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
          description: 'Uploads session transcripts to your Tuneloop server on SessionEnd.',
        },
      ],
    },
    null,
    2,
  )
}

export interface CodexMarketplaceResult {
  outputDir: string
  marketplaceName: string
  pluginRef: string
}

/**
 * Emit an unpacked Codex plugin marketplace directory an admin commits to a
 * (private) git repo, so developers install with `codex plugin marketplace add
 * <repo>` then `codex plugin add tuneloop@tuneloop` (or via `/plugins`).
 *
 *   <outputDir>/
 *   ├── .agents/plugins/marketplace.json
 *   └── plugins/tuneloop/                 (the plugin, source "./plugins/tuneloop")
 *       ├── .codex-plugin/plugin.json
 *       ├── hooks/hooks.json
 *       └── bin/tuneloop-upload.mjs        (server + token baked in)
 */
export async function generateCodexMarketplace(opts: {
  server: string
  token: string
  outputDir: string
}): Promise<CodexMarketplaceResult> {
  await mkdir(join(opts.outputDir, '.agents', 'plugins'), { recursive: true })
  await writeFile(join(opts.outputDir, '.agents', 'plugins', 'marketplace.json'), codexMarketplaceManifest())

  const pluginRoot = join(opts.outputDir, 'plugins', PLUGIN_NAME)
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
  await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), codexPluginManifest())
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
  await writeFile(join(pluginRoot, 'hooks', 'hooks.json'), codexPluginHooks())
  await mkdir(join(pluginRoot, 'bin'), { recursive: true })
  await writeFile(join(pluginRoot, 'bin', UPLOADER_NAME), await renderUploader(opts.server, opts.token))

  return { outputDir: opts.outputDir, marketplaceName: MARKETPLACE_NAME, pluginRef: `${PLUGIN_NAME}@${MARKETPLACE_NAME}` }
}
