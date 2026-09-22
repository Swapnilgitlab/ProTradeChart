import { describe, expect, it } from 'vitest';
import {
  chooseStandardLicense,
  holders,
  isLicenseFile,
  normalizeText,
  render,
  runtimeCrateIds,
  sameTextKey,
} from './third-party-licenses.mjs';

describe('isLicenseFile', () => {
  it('recognises the names licences ship under', () => {
    for (const name of ['LICENSE', 'LICENSE-MIT', 'LICENSE_APACHE-2.0', 'license.md', 'LICENCE.txt', 'COPYING', 'NOTICE', 'UNLICENSE']) {
      expect(isLicenseFile(name), name).toBe(true);
    }
  });

  it('ignores everything else', () => {
    for (const name of ['README.md', 'Cargo.toml', 'licensed.rs', 'package.json', 'CHANGELOG.md']) {
      expect(isLicenseFile(name), name).toBe(false);
    }
  });
});

describe('chooseStandardLicense', () => {
  it('prefers MIT when it is one of the choices', () => {
    expect(chooseStandardLicense('MIT')).toBe('MIT');
    expect(chooseStandardLicense('Zlib OR Apache-2.0 OR MIT')).toBe('MIT');
    expect(chooseStandardLicense('MIT/Apache-2.0')).toBe('MIT');
    expect(chooseStandardLicense('(Apache-2.0 OR MIT)')).toBe('MIT');
  });

  it('uses MPL-2.0 when that is the licence', () => {
    expect(chooseStandardLicense('MPL-2.0')).toBe('MPL-2.0');
  });

  it("refuses what it can't settle, so a person looks", () => {
    expect(chooseStandardLicense('(MIT OR Apache-2.0) AND Unicode-3.0')).toBeNull();
    expect(chooseStandardLicense('Apache-2.0 WITH LLVM-exception')).toBeNull();
    expect(chooseStandardLicense('BSD-3-Clause')).toBeNull();
    expect(chooseStandardLicense(undefined)).toBeNull();
  });
});

describe('holders', () => {
  it('drops e-mail addresses and falls back to the project', () => {
    expect(holders(['Jane Doe <jane@example.com>', 'Sam'], 'x')).toBe('Jane Doe, Sam');
    expect(holders([], 'objc2')).toBe('the objc2 authors');
  });
});

describe('normalizeText and sameTextKey', () => {
  it('evens out line endings, trailing spaces and a byte-order mark', () => {
    expect(normalizeText('﻿MIT  \r\n\r\nText\t\r\n')).toBe('MIT\n\nText');
  });

  it('treats rewrapped copies of a licence as the same text', () => {
    expect(sameTextKey('Permission is hereby\n  granted')).toBe(sameTextKey('Permission is\nhereby granted'));
  });
});

describe('runtimeCrateIds', () => {
  it('follows normal dependencies only, and leaves out the app itself', () => {
    const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
    const metadata = {
      resolve: {
        root: 'app',
        nodes: [
          { id: 'app', deps: [dep('serde'), dep('test-helper', 'dev'), dep('cc', 'build')] },
          { id: 'serde', deps: [dep('serde_derive')] },
          { id: 'serde_derive', deps: [] },
          { id: 'test-helper', deps: [dep('only-in-tests')] },
          { id: 'cc', deps: [] },
        ],
      },
    };
    expect([...runtimeCrateIds(metadata)].sort()).toEqual(['serde', 'serde_derive']);
  });
});

describe('render', () => {
  it('lists every component and prints a shared licence text once', () => {
    const mit = 'MIT License\n\nCopyright (c) Someone';
    const out = render({
      npm: [{ name: 'react', version: '19.0.0', license: 'MIT', texts: [mit] }],
      crates: [
        { name: 'serde', version: '1.0.0', license: 'MIT OR Apache-2.0', texts: [mit, 'Apache License'] },
      ],
      extra: [],
    });
    expect(out).toContain('  react 19.0.0  (MIT)');
    expect(out).toContain('  serde 1.0.0  (MIT OR Apache-2.0)');
    expect(out.split(mit)).toHaveLength(2);
    expect(out).toContain('react 19.0.0, serde 1.0.0\n');
    expect(out).toContain('Apache License');
    expect(out.endsWith('\n')).toBe(true);
  });
});
