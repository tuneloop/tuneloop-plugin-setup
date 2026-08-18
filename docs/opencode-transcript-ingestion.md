# OpenCode transcript ingestion — issue & fix options

Status: **open decision** — issue diagnosed, awaiting choice of fix.
Scope: OpenCode **transcript** upload only. OpenCode **skills** capture is unaffected and works.

---

## TL;DR

The OpenCode plugin uploads session transcripts tagged `format: 'opencode-raw'`, a format
the Tuneloop server has **never** accepted. Every OpenCode transcript upload gets rejected
with **HTTP 415 Unsupported Media Type** and is silently dropped. This has been broken since
the plugin repo's initial release — it is a **pre-existing client-side defect**, not something
introduced by the recent skills work, and not a server outage.

The other three agents (claude-code, codex, pi) are unaffected.

---

## Where the error is

`src/opencode-plugin.ts` sends the transcript with a made-up format string:

```js
await send(body, 'opencode-raw', cwd, session.id, dbPath)
```

The server's ingest route (`apps/server/src/routes/ingest.ts`) checks the format against a
fixed allow-list and rejects anything else:

```js
const format = meta.format ?? 'claude-code-jsonl'
if (!SUPPORTED_FORMATS.includes(format)) {
  return reply.code(415).send({ error: `unsupported format "${format}"` })
}
```

The allow-list (`packages/core/src/adapters/formats.ts`) is:

```js
RAW_FORMATS = {
  'claude-code-jsonl': 'claude-code',
  'codex-jsonl':       'codex',
  'pi-jsonl':          'pi',
}
SUPPORTED_FORMATS = [...RAW_FORMATS keys, 'tuneloop-normalized']
```

`'opencode-raw'` is not in that list → **415**.

### Why OpenCode is special

The other three harnesses each write **one transcript file per session**, so the client just
ships the raw bytes and the server parses them (the `RAW_FORMATS` above). OpenCode instead keeps
every session in a single live SQLite database (`opencode.db`). The original design (documented
in `packages/core/src/adapters/opencode/index.ts` in the enterprise repo) deliberately gave
OpenCode **no raw wire format**:

> "OpenCode normalizes on the machine that owns the DB and uploads the result as
> `tuneloop-normalized` — the format PLAN.md §4.2 reserves for pre-normalized sessions, where
> the server-side adapter is a no-op."

The reasoning was: shipping the whole `opencode.db` would re-upload every session whenever any
one changed, and hand the server a WAL it should not read. So the **old npm client**
(`@tuneloop/ingest`, `packages/ingest/src/opencode.ts`) opened the DB read-only, ran the shared
parse layer **on the client**, and uploaded the result as `tuneloop-normalized` — which the
server accepts.

### The actual root cause

When this decoupled plugin repo was written (commit `4dd44bb`, "Initial release"), the OpenCode
plugin was **never wired to do that client-side normalization**. It instead dumps one session's
raw `{session, messages, parts}` rows and invented the unsupported `'opencode-raw'` tag. It has
been silently 415ing ever since. The recent skills work only *surfaced* this (during end-to-end
testing); it did not cause it. The skills upload was, however, previously coupled to the
transcript upload — a failed transcript aborted the whole handler before skills ran — and that
coupling has already been fixed (skills now upload in an independent try/catch, so they succeed
regardless of the transcript 415).

---

## Fix options

Note: unlike the old batch CLI, the plugin is event-driven and already extracts **only the one
session's rows** — not the whole DB. So the historical "don't ship the whole DB/WAL" objection
no longer applies to the plugin.

### Option A — Server-side parse (keeps the client thin)

- **Client:** keep dumping one session's raw `{session, messages, parts}`. Only change: rename
  the format from `'opencode-raw'` to a real, registered name (e.g. `'opencode-jsonl'`).
- **Server:** add a new adapter that reconstructs an in-memory `OcDb`-shaped view over the
  uploaded rows and runs the **same** `buildSessions()` the old client used. Register the new
  format in `RAW_FORMATS`.

```
CLIENT (plugin, unchanged shape):
  {session, messages, parts}  --format: 'opencode-jsonl'-->

SERVER (new adapter, reuses existing core parse):
  rows -> OcDb-shim -> buildSessions() -> Session[]
```

- **Pros:**
  - Keeps `tuneloop-plugin-setup` **zero-dependency and thin** (its stated design).
  - Aligns OpenCode with the other 3 agents: *client dumps raw, server parses*.
  - **No code duplication** — parse logic lives once, in the enterprise repo where it already is.
  - `buildSessions()` only needs the small `OcDb` interface (`allSessions` / `messagesFor` /
    `partsFor`), so an in-memory shim over the uploaded rows is straightforward.
- **Cons:**
  - Touches **two repos**: enterprise server (which already has open PR #35) + one line in the plugin.
  - Requires a new format registration + a new server-side adapter + wiring it into the raw-parse path.

### Option B — Client-side normalize (faithful to the old client)

- **Client:** copy the ~1300-line parse stack into `tuneloop-plugin-setup` (`opencode/parse` +
  `opencode/db` + `core/blocks` + `core/model` + `core/hash` + `normalized`), build an `OcDb`
  over `bun:sqlite`, normalize locally, and upload as `'tuneloop-normalized'` (already accepted).
- **Server:** untouched (normalized format is already a no-op passthrough at ingest).

```
CLIENT (plugin, +~1300 lines copied):
  bun:sqlite -> OcDb -> buildSessions()
    -> NormalizedEnvelope
    --format: 'tuneloop-normalized'-->

SERVER: no-op (already accepts 'tuneloop-normalized')
```

- **Pros:**
  - Exactly matches the old `@tuneloop/ingest` behavior and the original PLAN.md §4.2 design.
  - **Plugin-repo-only** change; enterprise server untouched.
- **Cons:**
  - **Duplicates ~1300 lines** of core parse into a repo that is deliberately zero-dependency,
    creating a permanent **sync burden** (any change to core parse must be mirrored here).
  - Bloats the thin client and couples it to internal model/blocks logic it otherwise doesn't need.

---

## Recommendation

**Option A (server-side parse).** It preserves the plugin repo's zero-dependency, thin design,
puts parsing where the parse code already lives (no duplication / sync burden), and makes
OpenCode consistent with the other three agents. The historical reason for client-side
normalization does not apply to the event-driven plugin, which already sends a single session.

The main cost is that it touches the enterprise server repo — but that is a bounded, well-scoped
addition (one adapter + one format entry), and it's the correct long-term home for the logic.

---

## Verification once fixed (either option)

1. Run an OpenCode session against the local preview server (http://localhost:4326).
2. Confirm the transcript upload returns **2xx** (not 415).
3. Confirm a parsed session row appears (messages/parts reconstructed correctly).
4. Confirm skills continue to upload independently (already working: source=opencode).

## Key file references

- Plugin sender: `src/opencode-plugin.ts` (`send(...)` call, `'opencode-raw'`).
- Plugin generator: `src/generate/opencode.ts`.
- Server allow-list: `apps/server/src/routes/ingest.ts`, `packages/core/src/adapters/formats.ts` (enterprise repo).
- Existing parse layer to reuse: `packages/core/src/adapters/opencode/{index,parse,db}.ts` (enterprise repo).
- Old client reference (client-side normalize): `packages/ingest/src/opencode.ts` (enterprise repo).
