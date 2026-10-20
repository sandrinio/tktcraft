#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distCli = join(__dirname, '..', 'dist', 'cli.js');
const srcCli = join(__dirname, '..', 'src', 'cli.ts');

if (existsSync(distCli)) {
  await import(distCli);
} else if (existsSync(srcCli)) {
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', srcCli, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  if (res.error) {
    console.error(`Error: Could not start tktcraft: ${res.error.message}`);
  }
  process.exit(res.status ?? 1);
} else {
  console.error('Error: Could not locate compiled dist/cli.js or src/cli.ts. Reinstall tktcraft, or run npm run build in the source checkout.');
  process.exit(1);
}
