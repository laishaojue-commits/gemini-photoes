import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export function removeOwnedTempCase(directory, expectedPrefix) {
  const absoluteDirectory = resolve(directory);
  const absoluteTempRoot = resolve(tmpdir());
  assert.equal(dirname(absoluteDirectory), absoluteTempRoot, 'refusing to remove a directory outside os.tmpdir()');
  assert.ok(basename(absoluteDirectory).startsWith(expectedPrefix), `refusing to remove a directory without the ${expectedPrefix} mkdtemp prefix`);
  rmSync(absoluteDirectory, { recursive: true, force: true });
}
