import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['src', 'tests'];
const files = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) files.push(fullPath);
  }
}

for (const target of targets) collect(join(root, target));
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`Syntax check could not start for ${file}: ${result.error.message}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`Syntax OK: ${files.length} JS files under src/ and tests/`);
