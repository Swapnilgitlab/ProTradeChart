#!/usr/bin/env node
// Writes THIRD_PARTY_LICENSES.txt: the licence text of every third-party component that
// ships inside the app — the npm packages bundled into its interface and the Rust crates
// compiled into the executable for Windows, macOS and Linux.
//
// Their licences (MIT, Apache-2.0, BSD, ISC, MPL, ...) ask for their copyright notices and
// licence texts to travel with every copy, and the minified bundle keeps no comments, so
// this file is how they do. It is committed, bundled with the installers (tauri.conf.json,
// bundle.resources) and shown in the app's About dialog.
//
// Usage:  node scripts/third-party-licenses.mjs [--check]
//
// Run it after changing dependencies (`npm run licenses`). The release workflow runs it
// before building, so a release never ships a stale list. With --check it only reports
// whether the committed file is up to date (exit code 1 if not).
//
// Needs `npm install` to have run (it reads node_modules) and cargo on the PATH (it asks
// `cargo metadata` for the crate graph, which also downloads any missing crate sources).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_NAME = 'THIRD_PARTY_LICENSES.txt';

/** The targets release builds are made for. Crates only used elsewhere (Android, iOS, ...)
 *  never reach an installer, so they are left out. */
export const DESKTOP_TARGETS = [
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
];

/** A licence, notice or copying file, judged by its name. */
export function isLicenseFile(name) {
  return /^(licen[cs]es?|copying|notice|copyright|unlicense)([-_. ].*)?$/i.test(name);
}

/** Line endings and trailing spaces vary between copies of the same licence. */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Two copies of a licence that differ only in how they are wrapped or indented are the
 *  same licence, and print once. */
export function sameTextKey(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Standard texts for the few components that ship no licence file of their own. */
const STANDARD_TEXTS = {
  MIT: { file: 'MIT.txt', copyright: true },
  'MPL-2.0': { file: 'MPL-2.0.txt', copyright: false },
};

/** Which licence to reproduce for a component with no licence file. An `OR` (or the old
 *  `/`) offers a choice, and MIT is preferred as the shortest. Anything this can't settle
 *  (an `AND`, a licence with no standard text here) returns null, and the run fails so
 *  that a person looks at it. */
export function chooseStandardLicense(expression) {
  if (!expression || /\b(AND|WITH)\b/.test(expression)) return null;
  const options = expression.split(/\s+OR\s+|\//).map((s) => s.replace(/[()]/g, '').trim());
  return ['MIT', 'MPL-2.0'].find((id) => options.includes(id)) ?? null;
}

/** "Jane Doe <jane@example.com>" → "Jane Doe". */
export function holders(authors, name) {
  const names = (authors ?? []).map((a) => a.replace(/\s*<[^>]*>\s*/g, '').trim()).filter(Boolean);
  return names.length > 0 ? names.join(', ') : `the ${name} authors`;
}

/** Crates that ship no licence file but live in the repository of one that does, under
 *  the same licence. */
const SAME_LICENSE_AS = { 'alloc-stdlib': 'alloc-no-stdlib' };

/** Package ids of every crate compiled into the app: the root's normal (not dev or build)
 *  dependencies, transitively. `cargo metadata --filter-platform` has already dropped
 *  dependencies of other platforms. */
export function runtimeCrateIds(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const root = metadata.resolve.root;
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(root);
  return seen;
}

/** `[{ name, text }]` for the licence files directly inside `dir`. */
function licenseFilesIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => isLicenseFile(n) && statSync(path.join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, text: normalizeText(readFileSync(path.join(dir, n), 'utf8')) }))
    .filter((f) => f.text.length > 0);
}

/** A component's texts: its own licence files, or failing that a standard text. */
function textsFor(component, dir, standardDir) {
  const own = licenseFilesIn(dir);
  if (own.length > 0) return own.map((f) => f.text);
  const id = chooseStandardLicense(component.license);
  if (!id) {
    throw new Error(
      `${component.name} ${component.version} ships no licence file and its licence ` +
        `("${component.license}") has no standard text here: add one to scripts/licenses/.`,
    );
  }
  const standard = STANDARD_TEXTS[id];
  let text = normalizeText(readFileSync(path.join(standardDir, standard.file), 'utf8'));
  if (standard.copyright) text = text.replace('{copyright}', holders(component.authors, component.name));
  const which =
    component.license === id ? `its licence, ${id}` : `${id}, one of the licences it is offered under ("${component.license}")`;
  const note =
    `(${component.name} ships no licence file of its own. Below is the standard text of ${which}` +
    (standard.copyright ? ', with its authors as the copyright holders.)' : '.)');
  return [`${note}\n\n${text}`];
}

function npmComponents(standardDir) {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key || entry.dev || entry.devOptional || entry.link) continue;
    const dir = path.join(ROOT, key);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const component = {
      name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version ?? pkg.version,
      license: entry.license ?? pkg.license ?? 'UNKNOWN',
      authors: [],
    };
    out.push({ ...component, texts: textsFor(component, dir, standardDir) });
  }
  return out;
}

function crateComponents(standardDir) {
  const args = ['metadata', '--format-version', '1', '--locked', '--manifest-path', path.join(ROOT, 'src-tauri', 'Cargo.toml')];
  for (const t of DESKTOP_TARGETS) args.push('--filter-platform', t);
  const metadata = JSON.parse(execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const byName = new Map(metadata.packages.map((p) => [p.name, p]));
  const out = [];
  for (const id of runtimeCrateIds(metadata)) {
    const p = byId.get(id);
    const component = { name: p.name, version: p.version, license: p.license ?? 'UNKNOWN', authors: p.authors };
    const sibling = byName.get(SAME_LICENSE_AS[p.name]) ?? p;
    out.push({ ...component, texts: textsFor(component, path.dirname(sibling.manifest_path), standardDir) });
  }
  return out;
}

/** Things compiled in that aren't a crate or package themselves. */
function extraComponents(crates, standardDir) {
  const webview2 = crates.find((c) => c.name === 'webview2-com-sys');
  if (!webview2) return [];
  return [
    {
      name: 'Microsoft Edge WebView2 SDK (WebView2 loader)',
      version: `via webview2-com-sys ${webview2.version}, Windows builds`,
      license: 'BSD-style (Microsoft)',
      texts: [normalizeText(readFileSync(path.join(standardDir, 'WebView2-SDK.txt'), 'utf8'))],
    },
  ];
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en');
const label = (c) => `${c.name} ${c.version}`;
const RULE = '='.repeat(80);

/** The whole file. Components with an identical licence text share one copy of it. */
export function render({ npm, crates, extra }) {
  const lines = [
    'THIRD-PARTY LICENCES',
    '',
    'ProTradeChart is free software, licensed under the GNU Affero General Public License',
    'version 3 (the LICENSE file). It includes the third-party components listed below, each',
    'under its own licence; THIRD_PARTY_NOTICES.md summarises them. This file reproduces',
    'their copyright notices and licence texts.',
    '',
    'Generated by scripts/third-party-licenses.mjs from package-lock.json and',
    'src-tauri/Cargo.lock. Do not edit it by hand.',
    '',
    RULE,
    'COMPONENTS',
    RULE,
  ];
  const sections = [
    ['npm packages (bundled into the app interface)', npm],
    ['Rust crates (compiled into the app for Windows, macOS and Linux)', crates],
    ['Other', extra],
  ];
  for (const [title, list] of sections) {
    if (list.length === 0) continue;
    lines.push('', `${title}:`, '');
    for (const c of [...list].sort(byName)) lines.push(`  ${label(c)}  (${c.license})`);
  }

  const groups = new Map();
  for (const c of [...npm, ...crates, ...extra].sort(byName)) {
    for (const text of c.texts) {
      const key = sameTextKey(text);
      const group = groups.get(key) ?? { text, users: [] };
      if (!group.users.includes(label(c))) group.users.push(label(c));
      groups.set(key, group);
    }
  }
  lines.push('', RULE, 'LICENCE TEXTS', RULE, '', 'Components with the same licence text are listed together above it.');
  for (const { text, users } of groups.values()) {
    lines.push('', RULE, ...wrapList(users), '-'.repeat(80), '', text);
  }
  return lines.join('\n') + '\n';
}

/** "a 1.0, b 2.0, ..." broken into lines of at most 80 characters. */
function wrapList(items) {
  const out = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (next.length > 80 && line) {
      out.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

export function generate() {
  const standardDir = path.join(ROOT, 'scripts', 'licenses');
  const npm = npmComponents(standardDir);
  const crates = crateComponents(standardDir);
  return render({ npm, crates, extra: extraComponents(crates, standardDir) });
}

async function main(args) {
  const outFile = path.join(ROOT, OUT_NAME);
  const text = generate();
  if (args.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // A missing file is simply out of date.
    }
    if (current !== text) {
      console.error(`${OUT_NAME} is out of date: run \`npm run licenses\` and commit the result.`);
      process.exit(1);
    }
    console.log(`${OUT_NAME} is up to date.`);
    return;
  }
  writeFileSync(outFile, text);
  console.log(`Wrote ${OUT_NAME} (${Math.round(text.length / 1024)} KB).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
