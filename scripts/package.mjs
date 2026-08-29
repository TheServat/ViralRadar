/**
 * Builds the single-file executable.
 *
 * Node's own SEA support, which means no packaging framework and nothing to
 * install: the binary is a copy of the Node runtime with the bundle injected
 * into it. Around 110 MB, most of which is Node itself — the radar's own code
 * and dashboard are under two.
 *
 * Cross-compiling is not possible. SEA works by modifying the Node binary that
 * is running, so a Windows executable has to be built on Windows. The release
 * workflow does this on three runners for that reason.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'build');
const DIST = join(ROOT, 'dist');

const PLATFORM = process.platform;
const NAME = PLATFORM === 'win32' ? 'viral-radar.exe' : 'viral-radar';
const OUT = join(DIST, NAME);

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
}

if (!existsSync(join(BUILD, 'radar.cjs'))) {
  console.error('Run `node scripts/bundle.mjs` first.');
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });
rmSync(OUT, { force: true });

// The blob Node injects. `useSnapshot` is off: it speeds up startup but is
// still experimental and has bitten builds that worked without it.
const configPath = join(BUILD, 'sea-config.json');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: join(BUILD, 'radar.cjs'),
      output: join(BUILD, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
);

console.log('Preparing the blob');
run(process.execPath, ['--experimental-sea-config', configPath]);

console.log('Copying the Node runtime');
copyFileSync(process.execPath, OUT);

// macOS and Windows verify signatures, and injecting into a signed binary
// invalidates the existing one. Removing it first, and re-signing after on
// macOS, is what makes the result actually launchable.
if (PLATFORM === 'darwin') {
  try {
    run('codesign', ['--remove-signature', OUT]);
  } catch {
    console.log('  (nothing to unsign)');
  }
}

// The icon and version details go on before the blob: injecting rewrites the
// section table, and editing resources afterwards would move what postject
// just placed.
if (PLATFORM === 'win32') {
  console.log('Branding');
  execFileSync('python', [join(ROOT, 'scripts', 'icon.py')], { stdio: 'inherit', cwd: ROOT });
  const { brandWindows } = await import('./brand.mjs');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  brandWindows(OUT, join(BUILD, 'icon.ico'), {
    version: pkg.version ?? '1.0.0',
    description: 'Viral Radar',
    product: 'Viral Radar',
    company: 'Sajjad Servatjoo',
  });
}

console.log('Injecting');
const inject = [
  'postject',
  OUT,
  'NODE_SEA_BLOB',
  join(BUILD, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (PLATFORM === 'darwin') inject.push('--macho-segment-name', 'NODE_SEA');

run('npx', ['--yes', ...inject], { shell: PLATFORM === 'win32' });

if (PLATFORM === 'darwin') {
  console.log('Re-signing');
  run('codesign', ['--sign', '-', OUT]);
}

console.log('');
console.log('  ' + OUT);
console.log('  ' + Math.round(statSync(OUT).size / (1024 * 1024)) + ' MB');
console.log('');
console.log('Try it:  ' + (PLATFORM === 'win32' ? 'dist\\' + NAME : './dist/' + NAME) + ' --help');
