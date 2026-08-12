import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function generatePluginJs(server: string, token: string): string {
  return `// Tuneloop plugin for OpenCode.
// Uploads session data to your Tuneloop server when a session goes idle.
// Server URL and token are baked in at generation time.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { hostname, userInfo, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';

const TUNELOOP_SERVER = ${JSON.stringify(server)};
const TUNELOOP_TOKEN = ${JSON.stringify(token)};
const CLIENT_VERSION = '0.1.0';

const run = promisify(execFile);

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

function findDb() {
  const roots = [join(homedir(), '.local', 'share', 'opencode')];
  for (const root of roots) {
    const p = join(root, 'opencode.db');
    if (existsSync(p)) return p;
  }
  return null;
}

function uploadSession(sessionId) {
  const dbPath = findDb();
  if (!dbPath) return;

  const db = new Database(dbPath, { readonly: true });
  try {
    db.run('PRAGMA query_only = true');
    const session = db.query(
      'SELECT s.id, s.parent_id, s.directory, s.title, s.agent, s.model, s.version, ' +
      's.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, ' +
      's.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated, ' +
      'w.branch AS branch ' +
      'FROM session s LEFT JOIN workspace w ON w.id = s.workspace_id ' +
      'WHERE s.id = ?'
    ).get(sessionId);
    if (!session) return;

    const messages = db.query(
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC'
    ).all(sessionId);
    const parts = db.query(
      'SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC'
    ).all(sessionId);

    const bundle = {
      bundleVersion: 1,
      sessionKey: session.id,
      primary: 'session.json',
      files: [{
        name: 'session.json',
        content: JSON.stringify({ session, messages, parts }),
      }],
    };
    const body = Buffer.from(JSON.stringify(bundle), 'utf8');
    const cwd = session.directory || null;
    return send(body, 'opencode-raw', cwd, session.id, dbPath);
  } finally {
    db.close();
  }
}

const plugin = async () => {
  const pending = new Map();
  return {
    event: async ({ event }) => {
      if (
        event.type === 'session.status' &&
        event.properties?.status?.type === 'idle' &&
        event.properties?.sessionID
      ) {
        const id = event.properties.sessionID;
        clearTimeout(pending.get(id));
        pending.set(id, setTimeout(() => {
          pending.delete(id);
          uploadSession(id).catch(() => {});
        }, 10_000));
      }
    },
  };
};

// File-based plugins require id + server as the default export.
export default { id: 'tuneloop', server: plugin };
`
}

export async function generateOpencode(opts: {
  server: string
  token: string
  output: string
  install?: boolean
}): Promise<string> {
  const content = generatePluginJs(opts.server, opts.token)

  // Output as a single .js file (OpenCode discovers plugins via plugins/*.{ts,js})
  const outputPath = opts.output.endsWith('.js') ? opts.output : join(opts.output, 'tuneloop.js')
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, content)

  if (opts.install) {
    const dest = join(homedir(), '.config', 'opencode', 'plugins', 'tuneloop.js')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content)
    return dest
  }
  return outputPath
}
