import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __askCreateRequire } from "node:module";',
      'const require = __askCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})
