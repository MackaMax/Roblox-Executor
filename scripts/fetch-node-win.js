#!/usr/bin/env node
/**
 * Downloads a real Windows `node.exe` to use as the body of the standalone exe.
 *
 * Why not fetch it straight from nodejs.org? Because the SEA blob is injected
 * into a genuine node binary, and the npm package `node-win-x64` republishes
 * exactly those official builds — which keeps this build reproducible without
 * depending on a redirect to an object store that may not be reachable.
 *
 * Usage: node scripts/fetch-node-win.js [version]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, '.build');
const PKG = 'node-win-x64';

const requested = process.argv[2] ?? process.env.NODE_WIN_VERSION ?? "22.20.0";

fs.mkdirSync(BUILD, { recursive: true });
const target = path.join(BUILD, 'node-win-x64.exe');
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log(`  ${path.relative(ROOT, target)} already present (${(fs.statSync(target).size / 1024 / 1024).toFixed(0)} MB)`);
  process.exit(0);
}

console.log(`  fetching ${PKG}@${requested} from npm ...`);
const tmp = fs.mkdtempSync(path.join(BUILD, 'dl-'));

let tarball;
try {
  const out = execFileSync('npm', ['pack', `${PKG}@${requested}`, '--pack-destination', tmp], {
    cwd: tmp,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  tarball = path.join(tmp, out.trim().split('\n').pop().trim());
} catch {
  console.error(`\n  Could not download ${PKG}@${requested}.`);
  console.error('  Pick another version with: node scripts/fetch-node-win.js <version>\n');
  process.exit(1);
}

execFileSync('tar', ['xzf', tarball, '-C', tmp], { stdio: 'inherit' });
const extracted = path.join(tmp, 'package', 'bin', 'node.exe');
if (!fs.existsSync(extracted)) {
  console.error('  node.exe was not where it was expected inside the package');
  process.exit(1);
}

// Sanity-check the PE header so a corrupt download cannot become an exe that
// fails to start on the user's machine with no explanation.
const fd = fs.openSync(extracted, 'r');
const head = Buffer.alloc(0x200);
fs.readSync(fd, head, 0, head.length, 0);
fs.closeSync(fd);
if (head[0] !== 0x4d || head[1] !== 0x5a) {
  console.error('  downloaded node.exe is not a valid PE file (missing MZ header)');
  process.exit(1);
}
const peOffset = head.readUInt32LE(0x3c);
const machine = head.readUInt16LE(peOffset + 4);

fs.copyFileSync(extracted, target);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`  saved .build/node-win-x64.exe (${(fs.statSync(target).size / 1024 / 1024).toFixed(0)} MB)`);
console.log(`  version ${requested}, machine 0x${machine.toString(16)} (0x8664 = x64)`);
