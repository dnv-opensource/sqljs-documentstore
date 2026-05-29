const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/persistenceWorker.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2022',
    tsconfig: path.join(__dirname, '../tsconfig.worker.json'),
  });

  const code = result.outputFiles[0].text;
  const output = `// AUTO-GENERATED — do not edit. Run "pnpm run build:worker" to regenerate.\nexport const WORKER_CODE = ${JSON.stringify(code)};\n`;
  fs.writeFileSync(path.join(__dirname, '../src/persistenceWorker.generated.ts'), output);
}

build().catch(e => { console.error(e); process.exit(1); });
