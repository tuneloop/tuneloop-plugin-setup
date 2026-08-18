# tuneloop-plugin-setup

Generate per-harness plugins that upload AI coding session transcripts to a [Tuneloop](https://tuneloop.io) server. Supports **Claude Code**, **Codex**, **OpenCode**, and **Pi**.

Each plugin has the server URL and ingest token baked in at generation time — no config files, no runtime dependencies.

## Quick start

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <your-ingest-token> \
  --harness claude-code
```

### Harness-specific examples

**Claude Code** — generates a `.zip` plugin archive:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness claude-code \
  -o tuneloop-claude-code.zip
```

Load it with `claude --plugin-dir ./tuneloop-claude-code` (after unzipping), or upload to your org's plugin marketplace.

**Codex** — installs a `SessionEnd` hook directly into `~/.codex`:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness codex
```

Codex has no drop-in plugin directory, so this always installs directly: it writes a self-contained uploader to `~/.codex/tuneloop-upload.mjs` and adds a `[[hooks.SessionEnd]]` block to `~/.codex/config.toml`. Codex requires hooks to be *trusted* before they run — the installer trusts it automatically via the `codex app-server` API. If that can't be verified, it prints a one-time instruction to trust the hook manually with `/hooks`.

_Codex enterprise (managed hooks)._ Fleets that set `allow_managed_hooks_only = true` ignore user-installed hooks — the command above won't apply. For those, generate admin artifacts instead of installing locally:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness codex --managed \
  -o ./tuneloop-codex-managed
```

This writes three files: the baked-in `tuneloop-upload.mjs`, a `requirements.toml` fragment (the `[[hooks.SessionEnd]]` block), and `README-admin.md`. The admin distributes the uploader into the managed directory and merges the fragment into the managed `requirements.toml` (Unix `/etc/codex/requirements.toml`, Windows `%ProgramData%\OpenAI\Codex\requirements.toml`) — both via MDM, since Codex does not distribute hook scripts itself. Managed hooks are trusted by policy (no `/hooks` step) and developers run nothing. Override the target directories with `--managed-dir` and `--managed-dir-windows` (defaults: `/etc/codex/hooks`, `C:\ProgramData\OpenAI\Codex\hooks`).

**OpenCode** — generates a `.js` plugin file:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness opencode \
  --install
```

With `--install`, copies directly to `~/.config/opencode/plugins/`. Restart OpenCode to activate.

**Pi** — generates a `.ts` extension file:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness pi \
  --install
```

With `--install`, copies directly to `~/.pi/agent/extensions/`. Restart Pi to activate.

## Backfill existing sessions

Upload historical sessions that predate plugin installation:

```bash
npx tuneloop-plugin-setup \
  --server https://tuneloop.yourcompany.com \
  --token <token> \
  --harness claude-code \
  --backfill
```

Preview first with `--dry-run`. Scope with `--since <days>` and `--limit <n>`.

## Options

| Flag | Description |
|------|-------------|
| `--server <url>` | Tuneloop server URL (required) |
| `--token <token>` | Ingest token (required) |
| `--harness <name>` | `claude-code`, `codex`, `opencode`, or `pi` (required) |
| `-o <path>` | Output path (defaults per harness) |
| `--install` | Copy plugin to the harness's local directory |
| `--managed` | (codex) Emit enterprise managed-hook artifacts instead of installing locally |
| `--managed-dir <path>` | (codex `--managed`) Unix managed directory on endpoints |
| `--managed-dir-windows <path>` | (codex `--managed`) Windows managed directory on endpoints |
| `--backfill` | Upload existing sessions |
| `--since <days>` | Backfill sessions modified within N days |
| `--limit <n>` | Cap number of sessions to backfill |
| `--dry-run` | Preview what would be uploaded |
| `--quiet` | Suppress progress output |

## How it works

- **Claude Code**: Installs a [SessionEnd hook](https://docs.anthropic.com/en/docs/claude-code/plugins) that bundles the session transcript and POSTs it to your server.
- **Codex**: Installs a `SessionEnd` hook in `~/.codex/config.toml` (auto-trusted via the `codex app-server` API). Because Codex clamps the hook to a few seconds, it hands the upload to a detached child so the session never blocks.
- **OpenCode**: Registers a [plugin](https://opencode.ai/docs/plugins/) that listens for session idle events, reads session data from OpenCode's SQLite database, and uploads it.
- **Pi**: Registers an [extension](https://docs.pi.new/extensions/) that triggers on `session_shutdown`, bundles the session JSONL file, and uploads it.

All uploads are gzip-compressed and sent as multipart form-data to `/api/ingest/transcript` with Bearer token auth. Upload failures are non-fatal — they never block the coding agent.

## Requirements

- Node.js 22+
- Zero runtime dependencies

## License

MIT
