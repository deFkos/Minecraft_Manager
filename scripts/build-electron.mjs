import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const args = process.argv.slice(2);
const compileOnly = args.includes('--compile-only');
const targetArg = args.find((a) => a.startsWith('--target='))?.split('=')[1] || 'current';
const isWindowsHost = process.platform === 'win32';
const npmCmd = isWindowsHost ? 'npm.cmd' : 'npm';
const npxCmd = isWindowsHost ? 'npx.cmd' : 'npx';

function runStep(cmd, cmdArgs, extraEnv = {}) {
  console.log(`\n▶ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: isWindowsHost,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hasPackage(pkgName) {
  return fs.existsSync(path.join(rootDir, 'node_modules', pkgName, 'package.json'));
}

async function bundleElectronProcesses() {
  const outDir = path.join(rootDir, 'dist-electron');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n▶ Сборка Electron Main Process (dist-electron/main.mjs)...');
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
    outfile: path.join(outDir, 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron'],
  });

  console.log('▶ Сборка Electron Preload Script (dist-electron/preload.cjs)...');
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
    outfile: path.join(outDir, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  });
}

async function main() {
  console.log('=== NeoCraft Control — Сборка десктопного приложения и установщика ===');

  // 1. Build React frontend with relative asset paths for file:// loading in Electron
  runStep(npmCmd, ['run', 'build'], { ELECTRON_BUILD: 'true' });

  // 2. Bundle Electron Main & Preload TypeScript sources
  await bundleElectronProcesses();

  if (compileOnly) {
    console.log('\n✓ Компиляция Electron завершена (dist/ + dist-electron/).');
    return;
  }

  // 3. Ensure electron and electron-builder are installed locally before packaging
  const missing = [];
  if (!hasPackage('electron')) missing.push('electron');
  if (!hasPackage('electron-builder')) missing.push('electron-builder');

  if (missing.length > 0) {
    console.log(`\n▶ Автоматическая установка пакетов сборки: ${missing.join(', ')}...`);
    runStep(npmCmd, ['install', '-D', '--no-audit', '--no-fund', ...missing]);
  }

  // 4. Invoke electron-builder for target platform(s)
  const builderArgs = ['electron-builder', '--config', 'electron-builder.yml'];
  if (targetArg === 'win') {
    builderArgs.push('--win', 'nsis');
  } else if (targetArg === 'linux') {
    builderArgs.push('--linux', 'AppImage', 'deb');
  } else if (targetArg === 'all') {
    builderArgs.push('--win', 'nsis', '--linux', 'AppImage');
  }

  runStep(npxCmd, builderArgs, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });

  const releaseDir = path.join(rootDir, 'release');
  console.log(`\n✓ Готово! Установщик собран в папке: ${releaseDir}`);
  if (fs.existsSync(releaseDir)) {
    const files = fs.readdirSync(releaseDir).filter((f) => /\.(exe|AppImage|deb)$/i.test(f));
    for (const f of files) {
      console.log(`  • ${path.join(releaseDir, f)}`);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка сборки:', err);
  process.exit(1);
});
