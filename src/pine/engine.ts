import {
  registerDefaultEngine,
  type EngineCapabilities,
  type ExecutionHandlers,
  type ExecutionRequest,
  type ExecutionSession,
  type PreparedScript,
  type ScriptingEngine,
} from '@luxalgo/vela/plugin';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';

/** Pine runs in a Worker, never in-process: PineTS compiles a script to JavaScript
 *  (`new Function`), which is why the CSP allows `unsafe-eval`. A worker has no DOM and
 *  no Tauri IPC, so a pasted script can't reach the backend or the broker credentials.
 *  Don't switch this to `PineEngine` without revisiting the CSP note in ARCHITECTURE.md. */

/** Vela's own indicator ids carry no meaning for us; ours look like `<scriptId>~<suffix>`
 *  so a legend row can be traced back to the library script it came from. */
const ID_SEPARATOR = '~';
export const DRAFT_SCRIPT_ID = 'draft';

export function makeIndicatorId(scriptId: string): string {
  return `${scriptId}${ID_SEPARATOR}${crypto.randomUUID().slice(0, 8)}`;
}

/** The library script an indicator id was minted for, or null for an id we didn't mint. */
export function scriptIdOf(indicatorId: string): string | null {
  const at = indicatorId.indexOf(ID_SEPARATOR);
  return at > 0 ? indicatorId.slice(0, at) : null;
}

type BarsReader = () => ExecutionRequest['bars'];

/** The bars each running script was last handed, by indicator id. Vela owns the chart's
 *  bars and gives them only to the engine, so the Strategy Tester (equity curve,
 *  per-trade run-up) reads them from here rather than re-fetching market data. */
const barsByIndicator = new Map<string, BarsReader>();

export function barsFor(indicatorId: string): ExecutionRequest['bars'] | null {
  return barsByIndicator.get(indicatorId)?.() ?? null;
}

/** Delegates everything to the real engine and notes which bars each script runs on. */
export class BarsTap implements ScriptingEngine {
  readonly language: string;
  readonly capabilities: EngineCapabilities;
  private readonly ids = new WeakMap<PreparedScript, string>();

  constructor(private readonly inner: ScriptingEngine) {
    this.language = inner.language;
    this.capabilities = inner.capabilities;
  }

  async prepare(source: string, instanceId: string): Promise<PreparedScript> {
    const prepared = await this.inner.prepare(source, instanceId);
    this.ids.set(prepared, instanceId);
    return prepared;
  }

  execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
    const id = this.ids.get(req.prepared);
    const reader: BarsReader = req.getBars ?? (() => req.bars);
    if (id) barsByIndicator.set(id, reader);
    const session = this.inner.execute(req, handlers);
    // Members are forwarded one by one: a session may be a class instance, whose methods
    // a spread would drop and whose `this` a bare reference would lose.
    return {
      getContext: session.getContext?.bind(session),
      update: (inputs, props) => session.update(inputs, props),
      setVisibleRange: (range) => session.setVisibleRange(range),
      notifyBars: (reason) => session.notifyBars(reason),
      stop: () => {
        if (id && barsByIndicator.get(id) === reader) barsByIndicator.delete(id);
        session.stop();
      },
    };
  }
}

let installed = false;

/** Registers Pine as the default scripting engine for every chart. Call once, before the
 *  first `VelaWorkspace` is constructed (Vela reads the registry at construction). */
export function installPineEngine(): void {
  if (installed) return;
  installed = true;
  // `props: 'strategy'` gives strategies a Properties tab (initial capital, commission,
  // slippage, sizing…) like TradingView, while plain indicators keep Inputs / Style.
  registerDefaultEngine('pine', () => new BarsTap(new PineWorkerEngine({ props: 'strategy' })));
}
