import { describe, expect, it } from 'vitest';
import { exitSummary, formatElapsed } from './format';

describe('formatElapsed', () => {
  it('shows milliseconds under a second', () => {
    expect(formatElapsed(0)).toBe('0 ms');
    expect(formatElapsed(412.4)).toBe('412 ms');
    expect(formatElapsed(999)).toBe('999 ms');
  });

  it('shows seconds to a tenth up to a minute', () => {
    expect(formatElapsed(1000)).toBe('1.0 s');
    expect(formatElapsed(3240)).toBe('3.2 s');
    expect(formatElapsed(59_900)).toBe('59.9 s');
  });

  it('shows minutes and seconds beyond that', () => {
    expect(formatElapsed(60_000)).toBe('1 min 0 s');
    expect(formatElapsed(185_000)).toBe('3 min 5 s');
    expect(formatElapsed(119_600)).toBe('2 min 0 s');
  });

  it('survives nonsense', () => {
    expect(formatElapsed(-5)).toBe('0 ms');
    expect(formatElapsed(NaN)).toBe('0 ms');
    expect(formatElapsed(Infinity)).toBe('0 ms');
  });
});

describe('exitSummary', () => {
  it('says a clean exit finished, as information', () => {
    expect(exitSummary({ code: 0, stopped: false, error: null }, 3240)).toEqual({ level: 'info', text: '✓ Finished in 3.2 s' });
  });

  it('says a stop was a stop, and not a failure', () => {
    expect(exitSummary({ code: null, stopped: true, error: null }, 800)).toEqual({ level: 'info', text: '■ Stopped after 800 ms' });
  });

  it('reports a failing exit code as an error', () => {
    expect(exitSummary({ code: 1, stopped: false, error: null }, 2000)).toEqual({ level: 'error', text: '✗ Exited with code 1 after 2.0 s' });
  });

  it('reports a script that could not start with the reason', () => {
    expect(exitSummary({ code: null, stopped: false, error: "Couldn't start Python: not found" }, 5)).toEqual({
      level: 'error',
      text: "✗ Couldn't start Python: not found",
    });
  });

  it('reports a death by signal as unexpected', () => {
    expect(exitSummary({ code: null, stopped: false, error: null }, 1500).level).toBe('error');
  });
});
