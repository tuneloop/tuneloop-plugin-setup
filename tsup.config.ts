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
])
