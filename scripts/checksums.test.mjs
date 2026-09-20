import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSums, isDownload, sha256File, sumsFor, SUMS_NAME } from './checksums.mjs';

// Published test vectors for SHA-256.
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'checksums.mjs');

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'protradechart-sums-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = (name, content) => writeFile(path.join(dir, name), content);

describe('sha256File', () => {
  it('matches the published vectors', async () => {
    await put('empty', '');
    await put('abc', 'abc');
    expect(await sha256File(path.join(dir, 'empty'))).toBe(EMPTY);
    expect(await sha256File(path.join(dir, 'abc'))).toBe(ABC);
  });

  it('hashes a file larger than one read chunk the same as hashing it whole', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await put('big', big);
    const { createHash } = await import('node:crypto');
    expect(await sha256File(path.join(dir, 'big'))).toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('rejects for a file that does not exist', async () => {
    await expect(sha256File(path.join(dir, 'missing'))).rejects.toThrow();
  });
});

describe('isDownload', () => {
  it('keeps installers and updater bundles', () => {
    for (const name of ['ProTradeChart_0.1.0_x64-setup.exe', 'ProTradeChart_0.1.0_x64.dmg', 'ProTradeChart_0.1.0_amd64.AppImage', 'ProTradeChart_x64.app.tar.gz']) {
      expect(isDownload(name)).toBe(true);
    }
  });

  it('skips signatures, the updater manifest and the sums file itself', () => {
    expect(isDownload('ProTradeChart_0.1.0_x64-setup.exe.sig')).toBe(false);
    expect(isDownload('latest.json')).toBe(false);
    expect(isDownload(SUMS_NAME)).toBe(false);
  });
});

describe('formatSums', () => {
  it('writes "hash  name" lines in name order, whatever order they came in', () => {
    const text = formatSums([
      { name: 'b.dmg', hash: ABC },
      { name: 'a.exe', hash: EMPTY },
    ]);
    expect(text).toBe(`${EMPTY}  a.exe\n${ABC}  b.dmg\n`);
  });

  it('is empty for no files', () => {
    expect(formatSums([])).toBe('');
  });
});

describe('sumsFor', () => {
  it('hashes downloads, and ignores signatures, the manifest, an old sums file and sub-folders', async () => {
    await put('ProTradeChart_setup.exe', 'abc');
    await put('ProTradeChart_setup.exe.sig', 'signature');
    await put('latest.json', '{}');
    await put(SUMS_NAME, 'old');
    await mkdir(path.join(dir, 'nested'));
    await put(path.join('nested', 'inner.bin'), 'x');

    expect(await sumsFor(dir)).toEqual([{ name: 'ProTradeChart_setup.exe', hash: ABC }]);
  });

  it('refuses a name with a line break, which would corrupt the file', async () => {
    if (process.platform === 'win32') return; // Windows can't create such a file
    await put('bad\nname.exe', 'abc');
    await expect(sumsFor(dir)).rejects.toThrow(/line break/);
  });
});

describe('the command line', () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('writes SHA256SUMS into the folder and prints it', async () => {
    await put('one.exe', 'abc');
    await put('two.dmg', '');
    const result = run(dir);
    expect(result.status).toBe(0);
    const expected = `${ABC}  one.exe\n${EMPTY}  two.dmg\n`;
    expect(result.stdout).toBe(expected);
    expect(await readFile(path.join(dir, SUMS_NAME), 'utf8')).toBe(expected);
  });

  it('gives the same answer when run again over a folder that now holds its own output', async () => {
    await put('one.exe', 'abc');
    const first = run(dir).stdout;
    expect(run(dir).stdout).toBe(first);
  });

  it('can write the file somewhere else', async () => {
    await put('one.exe', 'abc');
    const out = path.join(os.tmpdir(), `protradechart-sums-out-${process.pid}`);
    try {
      expect(run(dir, '--out', out).status).toBe(0);
      expect(await readFile(out, 'utf8')).toBe(`${ABC}  one.exe\n`);
    } finally {
      await rm(out, { force: true });
    }
  });

  it('fails on an empty folder and on bad usage', () => {
    expect(run(dir).status).toBe(1);
    expect(run().status).toBe(2);
    expect(run(dir, '--out').status).toBe(2);
  });

  it('produces a file the system checker accepts', async () => {
    await put('one.exe', 'abc');
    await put('two.dmg', 'some more bytes');
    run(dir);
    const check = (() => {
      for (const [cmd, args] of [
        ['sha256sum', ['-c', SUMS_NAME]],
        ['shasum', ['-a', '256', '-c', SUMS_NAME]],
      ]) {
        try {
          return execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return null; // neither tool is installed (a bare Windows shell)
    })();
    if (check !== null) expect(check).toMatch(/one\.exe: OK[\s\S]*two\.dmg: OK/);
  });
});
