import { listPineScripts, type PineScriptRow } from '../lib/ipc';
import { declaredTitle } from './source';

/** Where `import <user>/<library>/<version>` finds a library: among the user's own saved scripts,
 *  the `library()` whose declared title is the import's library name. The user and version in
 *  the import are not checked (the app has no accounts or published versions), so a script
 *  copied from TradingView runs once the library it imports is saved too. Nothing is fetched:
 *  the app loads nothing from servers the user didn't choose. */

/** The source of the saved library titled `name`, or null. Pure. */
export function findLibrary(scripts: readonly Pick<PineScriptRow, 'kind' | 'source'>[], name: string): string | null {
  return scripts.find((s) => s.kind === 'library' && declaredTitle(s.source) === name)?.source ?? null;
}

/** The engine's `importResolver`: asked when a script is prepared, for each library it imports. */
export async function resolveLibrary(_path: string, info: { name: string }): Promise<string | null> {
  return findLibrary(await listPineScripts(), info.name);
}
