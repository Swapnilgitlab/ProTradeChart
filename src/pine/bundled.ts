import type { IndicatorManifestEntry } from '@luxalgo/vela/widget';
import type { PineScriptKind } from '../lib/ipc';
import { declaredTitle, detectKind } from './source';

/** The Pine scripts that ship inside the app: every `.pine` file under `pine/indicators/`
 *  (see pine/README.md). Vite inlines them at build time, so they're part of the installer
 *  with no extra packaging step. */

export const DEFAULT_CATEGORY = 'Pine scripts';

const ROOT = 'pine/indicators/';

export interface BundledScript {
  /** The title the script declares. It is also the script's identity in saved layouts. */
  name: string;
  /** The picker group: the folder it sits in, `A / B` for nested folders. */
  category: string;
  kind: Exclude<PineScriptKind, 'library'>;
  source: string;
  /** Path under `pine/indicators/`, for messages. */
  file: string;
}

/** `files` maps a file's path to its text. Scripts that can't be used are skipped with a
 *  warning rather than failing the app: one bad file must not take the chart down (the
 *  tests fail on any skipped file, so it doesn't get that far). */
export function loadBundled(files: Record<string, string>, warn: (message: string) => void = console.warn): BundledScript[] {
  const out: BundledScript[] = [];
  const names = new Map<string, string>();

  for (const path of Object.keys(files).sort()) {
    const source = files[path];
    const at = path.lastIndexOf(ROOT);
    const file = at >= 0 ? path.slice(at + ROOT.length) : path;
    const parts = file.split('/');
    const filename = parts.pop() ?? file;

    const kind = detectKind(source);
    // A library can't be put on a chart, so it has no place in the Indicators dialog.
    if (!kind || kind === 'library') {
      warn(`Bundled script "${file}" skipped: it has no indicator() or strategy() declaration.`);
      continue;
    }
    const name = declaredTitle(source) ?? filename.replace(/\.pine$/i, '');
    const clash = names.get(name);
    if (clash) {
      warn(`Bundled script "${file}" skipped: its title "${name}" is already used by "${clash}".`);
      continue;
    }
    names.set(name, file);
    out.push({ name, category: parts.length > 0 ? parts.join(' / ') : DEFAULT_CATEGORY, kind, source, file });
  }

  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Vela's manifest form. `enabled: false` lists a script in the Indicators dialog without
 *  putting it on every new chart. Vela saves a manifest indicator in a layout by name. */
export function toManifest(scripts: readonly BundledScript[]): IndicatorManifestEntry[] {
  return scripts.map((s) => ({ name: s.name, script: s.source, language: 'pine', enabled: false, category: s.category }));
}

const RAW_FILES = import.meta.glob<string>('../../pine/indicators/**/*.pine', { query: '?raw', import: 'default', eager: true });

export const BUNDLED_SCRIPTS: readonly BundledScript[] = loadBundled(RAW_FILES);
export const BUNDLED_MANIFEST: IndicatorManifestEntry[] = toManifest(BUNDLED_SCRIPTS);
