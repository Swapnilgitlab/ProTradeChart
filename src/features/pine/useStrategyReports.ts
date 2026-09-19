import { useEffect, useState } from 'react';
import type { VelaWorkspace, WorkspaceScriptRun } from '@luxalgo/vela/workspace';
import { barsFor } from '../../pine/engine';
import { currencyProp, effectiveProps, numberProp } from '../../pine/props';
import { buildReport, parseCommission, type TesterReport } from '../../pine/tester';

export interface StrategyEntry {
  /** `cell/indicatorId` — unique across the workspace's grid. */
  key: string;
  cell: string;
  id: string;
  title: string;
  symbol: string;
  timeframe: string;
  currency: string | undefined;
  report: TesterReport;
}

/** A tick refines the open bar and arrives about once a second; the report only needs to
 *  keep up with what a person can read. */
const DEBOUNCE_MS = 250;
const PRUNE_MS = 1500;

/** Every strategy running on the workspace's charts, each with its computed report. The
 *  engine reports fills and account state; `buildReport` turns them into the trade list,
 *  equity curve and summary the tester shows. */
export function useStrategyReports(ws: VelaWorkspace | null, watching: boolean): StrategyEntry[] {
  const [entries, setEntries] = useState<StrategyEntry[]>([]);

  useEffect(() => {
    if (!ws) {
      setEntries([]);
      return;
    }
    let disposed = false;
    const timers = new Map<string, number>();

    const compute = async (run: WorkspaceScriptRun) => {
      const cell = ws.cells().find((c) => c.id === run.cell);
      const handle = cell?.chart.indicators().find((h) => h.id === run.id);
      if (!cell || !handle) return;
      const trades = await run.trades();
      if (disposed) return;
      const props = effectiveProps(handle);
      const report = buildReport({
        state: run.strategy ?? { initialCapital: numberProp(props, 'initial_capital', 1_000_000), equity: 0 },
        trades,
        bars: barsFor(run.id) ?? [],
        commission: parseCommission(props.commission_type, props.commission_value),
      });
      const entry: StrategyEntry = {
        key: `${run.cell}/${run.id}`,
        cell: run.cell,
        id: run.id,
        title: run.title,
        symbol: cell.symbol,
        timeframe: cell.timeframe,
        currency: currencyProp(props),
        report,
      };
      setEntries((prev) => [...prev.filter((e) => e.key !== entry.key), entry]);
    };

    const offRun = ws.on('script:run', (run) => {
      if (run.kind !== 'strategy') return;
      const key = `${run.cell}/${run.id}`;
      window.clearTimeout(timers.get(key));
      timers.set(
        key,
        window.setTimeout(() => {
          timers.delete(key);
          void compute(run);
        }, DEBOUNCE_MS),
      );
    });

    return () => {
      disposed = true;
      offRun();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [ws]);

  // Drop strategies that were removed from the chart (or whose cell went away). Only
  // while the tester is on screen — nothing is displayed otherwise.
  useEffect(() => {
    if (!ws || !watching) return;
    const prune = () => {
      const alive = new Set<string>();
      for (const cell of ws.cells()) {
        try {
          for (const h of cell.chart.indicators()) alive.add(`${cell.id}/${h.id}`);
        } catch {
          // a cell mid-rebuild: skip it this round rather than drop its strategies
          return;
        }
      }
      setEntries((prev) => (prev.every((e) => alive.has(e.key)) ? prev : prev.filter((e) => alive.has(e.key))));
    };
    prune();
    const timer = window.setInterval(prune, PRUNE_MS);
    return () => window.clearInterval(timer);
  }, [ws, watching]);

  return entries;
}
