// Gera dist/lol-analytics.exe: um executável único com o Node, o app e a página embutidos.
// Usa o "Single Executable Application" do próprio Node (https://nodejs.org/api/single-executable-applications.html).
//
//   npm run exe
//
// Quem usa o .exe não precisa de Node, npm nem nada instalado.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'dist');
const nomeExe = process.platform === 'win32' ? 'lol-analytics.exe' : 'lol-analytics';
const exe = join(dist, nomeExe);
const ARQUIVOS_DA_PAGINA = ['index.html', 'app.js', 'estilo.css', 'icone.svg'];

// Nunca apaga a pasta dist inteira: o .env e a pasta data de quem usa o .exe podem estar nela.
mkdirSync(dist, { recursive: true });
rmSync(exe, { force: true });

// 1. Um arquivo JavaScript só (CommonJS), que é o que o SEA aceita.
//    O aviso "SQLite is experimental" é escondido para não poluir a janela do app.
await build({
  entryPoints: [join(raiz, 'src/app/servidor.ts')],
  outfile: join(dist, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
  // import.meta só é usado fora do .exe (para achar a pasta public); dentro dele a página vem embutida.
  logOverride: { 'empty-import-meta': 'silent' },
  banner: {
    js: [
      'const __avisoOriginal = process.emitWarning;',
      'process.emitWarning = function (aviso, ...resto) {',
      "  const tipo = typeof resto[0] === 'string' ? resto[0] : resto[0] && resto[0].type;",
      "  if (tipo === 'ExperimentalWarning' || (aviso && aviso.name === 'ExperimentalWarning')) return;",
      '  return __avisoOriginal.call(process, aviso, ...resto);',
      '};',
    ].join('\n'),
  },
});

// 2. Blob do SEA com o app e os arquivos da página.
const configSea = {
  main: join(dist, 'app.cjs'),
  output: join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: {
    ...Object.fromEntries(ARQUIVOS_DA_PAGINA.map((a) => [a, join(raiz, 'public', a)])),
    'vendor/chart.umd.js': join(raiz, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
  },
};
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify(configSea, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', join(dist, 'sea-config.json')], { stdio: 'inherit' });

// 3. Copia o node.exe e injeta o blob nele.
copyFileSync(process.execPath, exe);
const postject = join(raiz, 'node_modules', 'postject', 'dist', 'cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', join(dist, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });

for (const f of ['app.cjs', 'sea-prep.blob', 'sea-config.json']) rmSync(join(dist, f), { force: true });
console.log(`\nPronto: ${exe}`);
console.log('Copie o .exe para qualquer pasta. O .env e a pasta data são criados ao lado dele.');
