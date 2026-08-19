/**
 * Installed-skill inventory capture, for all harnesses.
 *
 * The server sees skill INVOCATIONS in transcripts, but only this machine sees what
 * is INSTALLED. After each session upload we report the skills present in the
 * locations that session could invoke, tagged with the harness (`source`). A skill
 * is a `<name>/SKILL.md` folder (name = the directory, the invokable identity) —
 * identical format across harnesses; only WHERE they live differs, so the per-agent
 * location table below is the single source of truth.
 *
 * Locations mirror the tuneloop OSS environment reader:
 *   claude-code : ~/.claude/skills (+ legacy commands/), <repo>/.claude/skills
 *   codex       : <codexHome>/.agents/skills, <repo>/.agents/skills
 *   opencode    : <configHome>/skills, ~/.agents/skills, ~/.claude/skills (+ project variants)
 *   pi          : <piHome>/skills, ~/.agents/skills (+ <repo>/.pi/skills, <repo>/.agents/skills)
 *
 * When a skill lives in a git checkout we also capture its provenance (source repo,
 * path, commit, dirty) so the team view can anchor version drift against the repo's
 * canonical commit. Only the name, hashes, the SKILL.md body/description, and that
 * git metadata ever leave the machine — never other files' contents.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gitFolderFiles, repoContext, repoSlug, skillProvenance, type SkillProvenance } from './git.js'

export type Harness = 'claude-code' | 'codex' | 'opencode' | 'pi'

export interface SkillEntry {
  name: string
  /** sha256[:32] of the SKILL.md body (frontmatter excluded). */
  bodyHash: string
  description?: string
  /** sha256[:32] over every file in the skill folder — the version identity. */
  folderHash: string
  /** SKILL.md body text (frontmatter excluded), for the version diff. */
  body?: string
  /** sha256[:32] over everything except the body + description. */
  extrasHash: string
  // Git provenance (present only when the skill lives in a checkout).
  sourceRemote?: string
  sourceRepo?: string
  sourcePath?: string
  sourceCommit?: string
  sourceCommittedAt?: string
  sourceDirty?: boolean
}

export interface SkillLocation {
  source: string
  scope: 'global' | 'project'
  /** '_global', or the canonical `owner/name` repo id (basename fallback). */
  scopeKey: string
  skills: SkillEntry[]
}

/** sha256, truncated to 32 hex — the project's skill-hash convention. */
function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

/** Split YAML frontmatter from body; a file not opening with `---` is all body. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) return { frontmatter: '', body: text }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/)
  if (!m) return { frontmatter: '', body: text }
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' }
}

/** The one frontmatter field we report — a minimal `description:` scan, not a YAML parser. */
function frontmatterDescription(frontmatter: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^description:\s*(.+)$/)
    if (!m) continue
    const v = m[1]!.trim()
    const unquoted =
      v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) ? v.slice(1, -1) : v
    return unquoted || undefined
  }
  return undefined
}

/** Frontmatter with any `description:` line removed — folded into extras_hash. */
function frontmatterWithoutDescription(frontmatter: string): string {
  return frontmatter
    .split(/\r?\n/)
    .filter((line) => !/^description:\s*/.test(line))
    .join('\n')
}

const MAX_FOLDER_FILES = 500

/** Every file under `root` as `{ rel, hash }` sorted by path — the folder/extras input.
 *  Follows symlinked dirs; bounded so a looping tree can't hang the hook. */
async function walkFiles(root: string): Promise<Array<{ rel: string; hash: string }>> {
  const out: Array<{ rel: string; hash: string }> = []
  const visit = async (dir: string, prefix: string): Promise<void> => {
    if (out.length >= MAX_FOLDER_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FOLDER_FILES) break
      const abs = join(dir, e.name)
      const rel = prefix ? prefix + '/' + e.name : e.name
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try {
          const st = await stat(abs)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch {
          continue // dangling symlink
        }
      }
      if (isDir) await visit(abs, rel)
      else if (isFile) {
        try {
          out.push({ rel, hash: sha(await readFile(abs, 'utf8')) })
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  await visit(root, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * The files defining a skill folder's version identity, `{ rel, hash }` sorted by path.
 * In a git checkout: git's working-tree set (via gitFolderFiles), so folderHash agrees
 * with the dirty flag and ignores .gitignore'd scratch; outside one: the raw fs walk.
 * Same hash convention either way, so a folder with no ignored files hashes identically.
 */
async function folderFiles(root: string): Promise<Array<{ rel: string; hash: string }>> {
  const tracked = await gitFolderFiles(root)
  if (tracked === null) return walkFiles(root) // not a checkout — raw fs walk
  const out: Array<{ rel: string; hash: string }> = []
  for (const rel of tracked.slice(0, MAX_FOLDER_FILES)) {
    try {
      out.push({ rel, hash: sha(await readFile(join(root, rel), 'utf8')) })
    } catch {
      /* unreadable/binary file — skip, mirrors walkFiles */
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Immediate child directory names of `dir` (follows symlinked dirs); [] if missing. */
async function listDirs(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(e.name)
    else if (e.isSymbolicLink()) {
      try {
        if ((await stat(join(dir, e.name))).isDirectory()) out.push(e.name)
      } catch {
        /* dangling symlink */
      }
    }
  }
  return out
}

function buildEntry(name: string, frontmatter: string, body: string, folderHash: string, extrasHash: string, prov: SkillProvenance | null): SkillEntry {
  const entry: SkillEntry = { name, bodyHash: sha(body), body, folderHash, extrasHash }
  const description = frontmatterDescription(frontmatter)
  if (description) entry.description = description
  if (prov) {
    if (prov.remote) entry.sourceRemote = prov.remote
    if (prov.repo) entry.sourceRepo = prov.repo
    // `!= null`, not truthy: `''` is a valid path (the skill is the repo root).
    if (prov.path != null) entry.sourcePath = prov.path
    if (prov.commit) entry.sourceCommit = prov.commit
    if (prov.committedAt) entry.sourceCommittedAt = prov.committedAt
    entry.sourceDirty = prov.dirty
  }
  return entry
}

/** A `<dir>/<name>/SKILL.md` skill: identity = the whole folder. */
async function readSkillDir(root: string, name: string): Promise<SkillEntry | null> {
  let text: string
  try {
    text = await readFile(join(root, 'SKILL.md'), 'utf8')
  } catch {
    return null // no SKILL.md → not a skill
  }
  const { frontmatter, body } = splitFrontmatter(text)
  const files = await folderFiles(root)
  const folderHash = sha(files.map((f) => f.rel + '\0' + f.hash).join('\n'))
  const extrasHash = sha(
    files.filter((f) => f.rel !== 'SKILL.md').map((f) => f.rel + '\0' + f.hash).join('\n') +
      '\0FM\0' + frontmatterWithoutDescription(frontmatter),
  )
  return buildEntry(name, frontmatter, body, folderHash, extrasHash, await skillProvenance(root))
}

/** A legacy `commands/<file>.md`: a single file, so the file IS the folder. */
async function readCommandFile(dir: string, file: string): Promise<SkillEntry | null> {
  const path = join(dir, file)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  return buildEntry(basename(file, '.md'), frontmatter, body, sha(text), sha(frontmatterWithoutDescription(frontmatter)), await skillProvenance(path))
}

// ---- per-harness config-home resolvers (mirror the OSS environment readers) ----

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}
function codexHome(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
}
function opencodeConfigHome(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (dir) return resolve(dir)
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'opencode')
}
function piHome(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  if (configured) return resolve(configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured)
  return resolve(join(homedir(), '.pi', 'agent'))
}

/** Skill directories for a harness, per scope. `commands` is Claude Code's legacy category. */
function skillDirs(harness: Harness, repo: string | null): { skills: string[]; commands: string[] } {
  const home = homedir()
  if (repo === null) {
    switch (harness) {
      case 'claude-code':
        return { skills: [join(claudeHome(), 'skills')], commands: [join(claudeHome(), 'commands')] }
      case 'codex':
        return { skills: [join(codexHome(), '.agents', 'skills')], commands: [] }
      case 'opencode':
        return { skills: [join(opencodeConfigHome(), 'skills'), join(home, '.agents', 'skills'), join(home, '.claude', 'skills')], commands: [] }
      case 'pi':
        return { skills: [join(piHome(), 'skills'), join(home, '.agents', 'skills')], commands: [] }
    }
  }
  switch (harness) {
    case 'claude-code':
      return { skills: [join(repo, '.claude', 'skills')], commands: [join(repo, '.claude', 'commands')] }
    case 'codex':
      return { skills: [join(repo, '.agents', 'skills')], commands: [] }
    case 'opencode':
      return { skills: [join(repo, '.opencode', 'skills'), join(repo, '.agents', 'skills'), join(repo, '.claude', 'skills')], commands: [] }
    case 'pi':
      return { skills: [join(repo, '.pi', 'skills'), join(repo, '.agents', 'skills')], commands: [] }
  }
}

/** Scan + MERGE a set of skill/command dirs into one deduped list (first-seen wins,
 *  the way harnesses resolve a name across several search roots). */
async function scanLocation(dirs: { skills: string[]; commands: string[] }): Promise<SkillEntry[]> {
  const out: SkillEntry[] = []
  const seen = new Set<string>()
  const push = (entry: SkillEntry | null): void => {
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name)
      out.push(entry)
    }
  }
  for (const dir of dirs.skills) {
    for (const name of (await listDirs(dir)).sort()) push(await readSkillDir(join(dir, name), name))
  }
  for (const dir of dirs.commands) {
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
    } catch {
      /* no commands dir */
    }
    for (const file of files) push(await readCommandFile(dir, file))
  }
  return out
}

/**
 * The installed skills a `harness` session in `cwd` could invoke: the harness's
 * global locations, plus the session repo's project locations. Locations are
 * reported even when empty — an empty list is what lets the server tombstone a
 * removal (silence would read as "not scanned").
 */
export async function collectSkills(harness: Harness, cwd: string | null | undefined): Promise<SkillLocation[]> {
  const locations: SkillLocation[] = [
    { source: harness, scope: 'global', scopeKey: '_global', skills: await scanLocation(skillDirs(harness, null)) },
  ]
  if (cwd) {
    const ctx = await repoContext(cwd)
    // Keyed by canonical `owner/name` so it joins the server's repo identity; the
    // lossy basename is the fallback for a local-only checkout with no origin.
    const slug = (await repoSlug(cwd)) ?? ctx.repo
    if (ctx.toplevel && slug) {
      locations.push({ source: harness, scope: 'project', scopeKey: slug, skills: await scanLocation(skillDirs(harness, ctx.toplevel)) })
    }
  }
  return locations
}

/**
 * POST the inventory. Best-effort: a skills report must never fail the transcript
 * upload it rides on. No email → no user row to attach to, so nothing is sent.
 */
export async function uploadSkills(
  server: string,
  token: string,
  email: string | null,
  locations: SkillLocation[],
  timeoutMs = 30_000,
): Promise<void> {
  if (!email) return
  const res = await fetch(`${server}/api/ingest/skills`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userEmail: email, locations }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`skills upload rejected: ${res.status} ${res.statusText}`)
}
