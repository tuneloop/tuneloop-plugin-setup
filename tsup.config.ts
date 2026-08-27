import { defineConfig } from 'tsup'

/** Shared shape for the standalone entry scripts (hook/upload entries): ESM,
 *  shebang'd, no sourcemaps — differing only in their entry name. */
const entryScript = (name: string, src?: string) => ({
  entry: { [name]: src ?? `src/${name}.ts` },
  format: ['esm' as const],
  target: 'node22' as const,
  platform: 'node' as const,
  clean: false,
  dts: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  removeNodeProtocol: false,
})

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: true,
    dts: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    removeNodeProtocol: false,
  },
  entryScript('shell-edit-entry'),
  entryScript('upload-entry'),
  entryScript('codex-upload-entry'),
  // OpenCode plugin + Pi extension: single self-contained modules (no shebang —
  // they're loaded by the harness, not executed). `bun:sqlite` stays external
  // (Bun provides it at runtime); node builtins keep their `node:` prefix.
  {
    entry: { 'opencode-plugin': 'src/opencode-plugin.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    external: ['bun:sqlite'],
    removeNodeProtocol: false,
  },
  {
    entry: { 'pi-extension': 'src/pi-extension.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    removeNodeProtocol: false,
  },
])
