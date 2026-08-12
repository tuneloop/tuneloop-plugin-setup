import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function generateExtension(server: string, token: string): string {
  return `// Tuneloop upload extension for Pi.
// Server URL and token are baked in at generation time.
const TUNELOOP_SERVER = ${JSON.stringify(server)};
const TUNELOOP_TOKEN = ${JSON.stringify(token)};

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { hostname, userInfo, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, relative, sep, resolve } from 'node:path';

const run = promisify(execFile);
const CLIENT_VERSION = '0.1.0';
const BUNDLE_VERSION = 1;

function machineId() {
  const raw = \`\${hostname()} \${userInfo().username} \${homedir()}\`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function git(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 5000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitConfigEmail(cwd) {
  const args = cwd ? ['-C', cwd, 'config', '--get', 'user.email'] : ['config', '--get', 'user.email'];
  return (await git(args)) ?? undefined;
}

async function repoContext(cwd) {
  if (!cwd) return { remote: null, branch: null, repo: null, toplevel: null };
  const top = await git(['-C', cwd, 'rev-parse', '--show-toplevel']);
  let repo = top ? basename(top) : null;
  if (top) {
    const common = await git(['-C', cwd, 'rev-parse', '--git-common-dir']);
    if (common) {
      const abs = resolve(cwd, common);
      if (basename(abs) === '.git') repo = basename(dirname(abs));
    }
  }
  return {
    remote: await git(['-C', cwd, 'remote', 'get-url', 'origin']),
    branch: await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
    repo,
    toplevel: top,
  };
}

function sessionDir(transcriptPath) {
  const name = basename(transcriptPath).replace(/\\.jsonl$/, '');
  return join(dirname(transcriptPath), name);
}

async function walkSession(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkSession(full)));
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.meta.json'))) out.push(full);
  }
  return out;
}

async function buildBundle(transcriptPath) {
  const primary = basename(transcriptPath);
  const files = [{ name: primary, content: await readFile(transcriptPath, 'utf8') }];
  const dir = sessionDir(transcriptPath);
  for (const full of await walkSession(dir)) {
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size === 0) continue;
      files.push({
        name: relative(dirname(transcriptPath), full).split(sep).join('/'),
        content: await readFile(full, 'utf8'),
      });
    } catch {}
  }

  let sessionKey = null;
  const head = files[0].content.slice(0, 64 * 1024);
  for (const line of head.split('\\n').slice(0, 50)) {
    if (!line.includes('"sessionId"') && !line.includes('"id"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionId === 'string' && parsed.sessionId) { sessionKey = parsed.sessionId; break; }
      if (parsed.type === 'session' && typeof parsed.id === 'string') { sessionKey = parsed.id; break; }
    } catch {}
  }

  return { bundleVersion: BUNDLE_VERSION, sessionKey, primary, files };
}

function encodeBundle(bundle) {
  const rest = bundle.files.filter(f => f.name !== bundle.primary).sort((a, b) => a.name.localeCompare(b.name));
  const head = bundle.files.filter(f => f.name === bundle.primary);
  return JSON.stringify({ ...bundle, files: [...head, ...rest] });
}

function cwdFromContent(content) {
  const lines = content.split('\\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"cwd"')) continue;
    try {
      const parsed = JSON.parse(line);
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : parsed.payload?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch {}
  }
  return null;
}

async function send(body, format, cwd, sessionKey, sourcePath) {
  const contentHash = createHash('sha256').update(body).digest('hex');
  const gz = gzipSync(body);
  const repo = await repoContext(cwd);
  const email = (await gitConfigEmail()) ?? null;
  const gitAuthorEmail = cwd ? ((await gitConfigEmail(cwd)) ?? null) : null;

  const meta = {
    format, contentHash, bytes: body.length,
    userEmail: email, machineId: machineId(),
    gitRemote: repo.remote, gitBranch: repo.branch, repo: repo.repo,
    gitAuthorEmail, gitToplevel: repo.toplevel,
    cwd, sourcePath, sessionKey: sessionKey ?? null,
    fileCount: 1, clientVersion: CLIENT_VERSION,
  };

  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('transcript', new Blob([gz], { type: 'application/gzip' }), 'transcript.gz');

  const res = await fetch(\`\${TUNELOOP_SERVER}/api/ingest/transcript\`, {
    method: 'POST',
    headers: { authorization: \`Bearer \${TUNELOOP_TOKEN}\` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(\`upload rejected: \${res.status} \${text.slice(0, 200)}\`);
  }
}

export default function (pi) {
  pi.on('session_shutdown', async (event, ctx) => {
    try {
      const transcriptPath = ctx.sessionManager.getSessionFile();
      if (!transcriptPath) return;

      const bundle = await buildBundle(transcriptPath);
      const body = Buffer.from(encodeBundle(bundle), 'utf8');
      if (bundle.files.every(f => f.content.length === 0)) return;

      const cwd = ctx.cwd ?? cwdFromContent(bundle.files[0]?.content ?? '');
      await send(body, 'pi-jsonl', cwd, bundle.sessionKey, transcriptPath);
    } catch {
      // Upload failures are non-fatal.
    }
  });
}
`
}

export async function generatePi(opts: {
  server: string
  token: string
  output: string
  install?: boolean
}): Promise<string> {
  await mkdir(dirname(opts.output), { recursive: true })
  await writeFile(opts.output, generateExtension(opts.server, opts.token))

  if (opts.install) {
    const dest = join(homedir(), '.pi', 'agent', 'extensions', 'tuneloop-upload.ts')
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(opts.output, dest)
    return dest
  }
  return opts.output
}
