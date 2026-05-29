const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'sqljsLib',
  outfile: path.join(__dirname, 'dist/bundle.js'),
  target: 'es2022',
  external: ['sql.js'],
  tsconfig: path.join(__dirname, '../tsconfig.app.json'),
});
