import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  tsconfig: 'tsconfig.app.json',
  external: ['sql.js', 'async-lock', 'idb-keyval', 'lodash'],
});
