#!/usr/bin/env node
/**
 * Bundles the browser app (public/js/app.js + CodeMirror + three.js) into
 * public/js/bundle.js so the IDE works without any build server at runtime.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(ROOT, 'public/js/app.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: path.join(ROOT, 'public/js/bundle.js'),
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching public/js …');
} else {
  await esbuild.build(options);
  const size = fs.statSync(options.outfile).size;
  console.log(`\nbundle written: ${(size / 1024).toFixed(0)} kB`);
}
