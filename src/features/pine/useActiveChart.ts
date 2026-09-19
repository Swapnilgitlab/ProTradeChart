import { useEffect, useState } from 'react';
import type { Vela } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

/** The chart of the workspace's active cell, kept current as cells come and go. Never
 *  cache the returned chart past the render: a layout change can replace it (see the
 *  grid notes in ARCHITECTURE.md). */
export function useActiveChart(ws: VelaWorkspace | null): Vela | null {
  const [chart, setChart] = useState<Vela | null>(null);

  useEffect(() => {
    if (!ws) {
      setChart(null);
      return;
    }
    const sync = () => {
      try {
        setChart(ws.chart);
      } catch {
        setChart(null); // a cell mid-rebuild has no chart yet; the next event resyncs
      }
    };
    sync();
    const stops = [ws.on('cell:active', sync), ws.on('cell:created', sync), ws.on('layout:changed', sync)];
    return () => stops.forEach((stop) => stop());
  }, [ws]);

  return chart;
}

/** Bumps whenever an indicator is added to or removed from `chart`, so a component that
 *  reads `chart.indicators()` while rendering stays accurate. */
export function useIndicatorTick(chart: Vela | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!chart) return;
    const bump = () => setTick((n) => n + 1);
    const stops = [chart.on('indicator:added', bump), chart.on('indicator:removed', bump)];
    return () => stops.forEach((stop) => stop());
  }, [chart]);
  return tick;
}
