import { defineConfig } from 'tsup'

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
  {
    entry: { 'upload-entry': 'src/upload-entry.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    removeNodeProtocol: false,
  },
  {
    entry: { 'codex-upload-entry': 'src/codex-upload-entry.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    clean: false,
    dts: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    removeNodeProtocol: false,
  },
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
