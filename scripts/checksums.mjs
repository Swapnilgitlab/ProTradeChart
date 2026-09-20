#!/usr/bin/env node
// Writes a SHA256SUMS file for the downloads in a folder, in the format `sha256sum -c`,
// `shasum -a 256 -c` and PowerShell's Get-FileHash comparisons all understand:
//
//   <64 hex characters>  <file name>
//
// Usage:  node scripts/checksums.mjs <folder> [--out <file>]
//
// The release workflow runs this over what a release actually holds (see
// publish-checksums.sh). It is also the way to produce the file for installers you host
// yourself, e.g. on a website: put them in a folder and run it.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUMS_NAME = 'SHA256SUMS';

/** Signatures, the updater manifest and the sums file itself are not downloads to verify:
 *  `latest.json` is rewritten as each platform's build finishes, so its hash would go stale. */
export function isDownload(name) {
  return name !== SUMS_NAME && name !== 'latest.json' && !name.endsWith('.sig');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** `{ hash, name }` for every download directly inside `dir` (sub-folders are ignored). */
export async function sumsFor(dir) {
  const entries = [];
  for (const name of await readdir(dir)) {
    if (!isDownload(name)) continue;
    const file = path.join(dir, name);
    if (!(await stat(file)).isFile()) continue;
    // A newline in a name would split its line in two and quietly corrupt the file.
    if (/[\r\n]/.test(name)) throw new Error(`Refusing a file name containing a line break: ${JSON.stringify(name)}`);
    entries.push({ name, hash: await sha256File(file) });
  }
  return entries;
}

/** Sorted by name so the file is the same however the folder happened to be listed. Two
 *  spaces between hash and name is the text-mode form `sha256sum -c` expects. */
export function formatSums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ hash, name }) => `${hash}  ${name}\n`)
    .join('');
}

async function main(argv) {
  const args = argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  const dir = args[0];
  if (!dir || args.length !== 1 || (outAt >= 0 && !out)) {
    console.error('Usage: node scripts/checksums.mjs <folder> [--out <file>]');
    return 2;
  }

  const entries = await sumsFor(dir);
  if (entries.length === 0) {
    console.error(`No files to checksum in ${dir}`);
    return 1;
  }
  const text = formatSums(entries);
  await writeFile(out ?? path.join(dir, SUMS_NAME), text);
  process.stdout.write(text);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
