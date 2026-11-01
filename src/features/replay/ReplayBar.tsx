import { useEffect, useState } from 'react';
import { Pause, Play, SkipForward, X } from 'lucide-react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { dateInputValue, intervalFor, replayStartOf, SPEEDS, type Speed } from '../../chart/replay';
import { formatWhen } from '../pine/format';

/** The replay controls under a chart tab: pick where to start, then play, pause or step through
 *  the bars after it. Everything it shows is read back from `ws.replay`, which also ends a replay
 *  on its own (the last bar revealed, or the symbol changed). */

interface Props {
  ws: VelaWorkspace;
  /** A start asked for from the chart (a right-clicked bar), with the cell it was asked on. */
  start: { from: number; cell?: string } | null;
  onClose: () => void;
}

type Snapshot = VelaWorkspace['replay']['state'];

const ENDED: Record<string, string> = {
  finished: 'The replay reached the latest bar.',
  market: 'The symbol changed, so the replay ended.',
};

function defaultDate(ws: VelaWorkspace): string {
  const bounds = ws.replay.bounds;
  // Halfway through what is loaded: there are bars to play, and none to fetch first.
  return bounds ? dateInputValue(bounds.first + (bounds.last - bounds.first) / 2) : '';
}

export function ReplayBar({ ws, start, onClose }: Props) {
  const [state, setState] = useState<Snapshot>(() => ({ ...ws.replay.state }));
  const [speed, setSpeed] = useState<Speed>(1);
  const [date, setDate] = useState(() => (start ? dateInputValue(start.from) : defaultDate(ws)));
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setState({ ...ws.replay.state });
    const stops = (['replay:start', 'replay:step', 'replay:play', 'replay:pause'] as const).map((event) => ws.replay.on(event, read));
    stops.push(
      ws.replay.on('replay:end', ({ reason }) => {
        read();
        setMessage(ENDED[reason] ?? null);
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [ws]);

  const begin = (from: number, cell?: string) => {
    setMessage(null);
    ws.replay.start({ from, cell }).catch((err: unknown) => setMessage(`Couldn’t start the replay: ${err instanceof Error ? err.message : String(err)}`));
  };

  useEffect(() => {
    if (!start) return;
    setDate(dateInputValue(start.from));
    begin(start.from, start.cell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const fromDate = replayStartOf(date);
  const changeSpeed = (next: Speed) => {
    setSpeed(next);
    if (state.playing) ws.replay.play(intervalFor(next));
  };
  const exit = () => {
    if (ws.replay.state.active) ws.replay.stop();
    onClose();
  };

  return (
    <div className="replay-bar" role="toolbar" aria-label="Bar replay">
      <span className="replay-title">Replay</span>
      {state.active && (
        <>
          <button
            type="button"
            className="btn btn-primary replay-play"
            onClick={() => (state.playing ? ws.replay.pause() : ws.replay.play(intervalFor(speed)))}
            disabled={state.remaining === 0}
          >
            {state.playing ? <Pause size={14} /> : <Play size={14} />}
            {state.playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn" onClick={() => ws.replay.step()} disabled={state.playing || state.remaining === 0}>
            <SkipForward size={14} /> Next bar
          </button>
          <label className="replay-speed">
            Speed
            <select className="python-input" value={speed} onChange={(e) => changeSpeed(Number(e.currentTarget.value) as Speed)} aria-label="Replay speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <span className="replay-status">
            {formatWhen(state.cursorTime)} · {state.remaining.toLocaleString()} {state.remaining === 1 ? 'bar' : 'bars'} to go
          </span>
        </>
      )}
      {!state.active && <span className="replay-status">{message ?? 'Pick a date to start from, or right-click a bar and choose Replay from this bar.'}</span>}
      <span className="replay-spacer" />
      <input className="python-input" type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} aria-label="Replay start date" />
      <button type="button" className="btn" disabled={fromDate === null} onClick={() => fromDate !== null && begin(fromDate)}>
        {state.active ? 'Restart here' : 'Start'}
      </button>
      <button type="button" className="btn" onClick={exit} title={state.active ? 'Leave the replay and go back to the latest bars' : 'Close'}>
        <X size={14} /> {state.active ? 'Exit replay' : 'Close'}
      </button>
    </div>
  );
}
