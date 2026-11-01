import { describe, expect, it } from 'vitest';
import {
  assistHistory,
  captureLine,
  describeSetup,
  MAX_RUN_TEXT_BYTES,
  MAX_SETUP_CHARS,
  newCapture,
  newScriptName,
  parseAssistAnswer,
  PROPOSED_NOTE,
  runReport,
  stripFence,
  tailText,
  todayInIndia,
  type LastRun,
} from './assistant';

describe('describing the setup to the assistant', () => {
  it('says what it knows, one fact a line, and nothing it doesn’t', () => {
    const text = describeSetup({
      broker: { id: 'zerodha', label: 'Zerodha', configured: true },
      keepLoaded: false,
      savedPrices: true,
      watchlists: [{ name: 'Nifty 50', count: 50 }],
      layouts: [],
      emailReady: false,
      schedules: [{ name: 'Evening', step: 2, steps: 3, when: 'Weekdays at 16:00', enabled: true }],
      python: { version: '3.12.4', custom: false },
      packages: [
        { name: 'pandas', version: '2.2.3' },
        { name: 'matplotlib', version: null },
      ],
    });
    expect(text).toContain('Broker serving india: symbols: Zerodha (connected)');
    expect(text).toContain('"10", "15", "30", "60" (minutes) and "D"');
    expect(text).toContain('"Keep the market loaded" is off');
    expect(text).toContain('pt.sql can read prices.price_series');
    expect(text).toContain('Watchlists (name: symbols): Nifty 50: 50.');
    expect(text).toContain('There are no saved chart layouts.');
    expect(text).toContain('pt.send_email will fail until');
    expect(text).toContain('"Evening" (step 2 of 3, Weekdays at 16:00)');
    expect(text).toContain("Python 3.12.4, the app's own environment.");
    expect(text).toContain('Installed packages: pandas 2.2.3. Not installed: matplotlib.');
    expect(text).not.toContain('datasets');
    expect(describeSetup({})).toBe('');
  });

  it('warns about FYERS Standard’s request limits', () => {
    const text = describeSetup({ broker: { id: 'fyers', label: 'FYERS', configured: true, fyersPlan: 'standard', requestsToday: 120, dailyLimit: 5000 } });
    expect(text).toContain('50 data requests a minute and 5000 a day (120 used today)');
    expect(text).toContain('"120", "240"');
  });

  it('names a long list only in part, and stays bounded', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `List ${i}`, count: i }));
    expect(describeSetup({ watchlists: many })).toContain('List 39: 39, and 60 more.');
    const huge = Array.from({ length: 40 }, () => 'x'.repeat(500));
    expect(describeSetup({ layouts: huge, scripts: huge }).length).toBeLessThanOrEqual(MAX_SETUP_CHARS);
  });

  it('dates the request in India', () => {
    expect(todayInIndia(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11-01');
    expect(todayInIndia(new Date('2026-10-31T10:00:00Z'))).toBe('2026-10-31');
  });
});

describe('what of the last run goes with a request', () => {
  const run: LastRun = { script: 'a.py', failed: true, summary: 'Exited with code 1 after 0.4 s', stdout: ['RELIANCE 2950.5'], stderr: ['Traceback', "KeyError: 'close'"] };

  it('sends the error when asked, and the output only when ticked', () => {
    expect(runReport(run, true, false)).toEqual({ failed: true, summary: run.summary, errors: "Traceback\nKeyError: 'close'", output: null });
    expect(runReport(run, true, true)?.output).toBe('RELIANCE 2950.5');
    expect(runReport(run, false, false)).toBeNull();
    expect(runReport(null, true, true)).toBeNull();
  });

  it('keeps a redrawn progress bar as one line, per stream', () => {
    const c = newCapture('a.py');
    captureLine(c, 'stdout', '10%', true);
    captureLine(c, 'stderr', 'warning', false);
    captureLine(c, 'stdout', '50%', true);
    captureLine(c, 'stdout', '100%', false);
    captureLine(c, 'stdout', 'done', false);
    expect(c.stdout).toEqual(['100%', 'done']);
    expect(c.stderr).toEqual(['warning']);
  });

  it('keeps the newest lines that fit', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const text = tailText(lines);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_RUN_TEXT_BYTES + 40);
    expect(text.startsWith('… (earlier lines left out)')).toBe(true);
    expect(text.endsWith(`line 4999 ${'x'.repeat(20)}`)).toBe(true);
    expect(tailText(['one', 'two'])).toBe('one\ntwo');
    expect(tailText(['y'.repeat(100_000)], 1000).length).toBeLessThan(400);
  });
});

describe('the conversation’s history', () => {
  it('is text only, and says when an answer came with code', () => {
    const turns = assistHistory([
      { question: 'write a screen', reply: 'Here it is.', proposed: true, error: null },
      { question: 'oops', reply: null, proposed: false, error: 'Network' },
      { question: 'why RSI 14?', reply: 'It is the usual period.', proposed: false, error: null },
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'write a screen' },
      { role: 'assistant', text: `Here it is.\n\n${PROPOSED_NOTE}` },
      { role: 'user', text: 'why RSI 14?' },
      { role: 'assistant', text: 'It is the usual period.' },
    ]);
  });

  it('drops the oldest exchanges beyond twenty turns, keeping pairs whole', () => {
    const exchanges = Array.from({ length: 15 }, (_, i) => ({ question: `q${i}`, reply: `a${i}`, proposed: false, error: null }));
    const turns = assistHistory(exchanges);
    expect(turns).toHaveLength(20);
    expect(turns[0]).toEqual({ role: 'user', text: 'q5' });
  });
});

describe('the assistant’s answer', () => {
  const source = 'import protrade as pt\n';

  it('is a reply and the whole new script', () => {
    expect(parseAssistAnswer({ reply: ' Added RSI. ', code: 'import protrade as pt\nprint(1)', name: '' }, source)).toEqual({
      reply: 'Added RSI.',
      code: 'import protrade as pt\nprint(1)\n',
      name: null,
    });
  });

  it('means no change when the code is empty or the same script', () => {
    expect(parseAssistAnswer({ reply: 'RSI 14 is standard.', code: '', name: '' }, source).code).toBeNull();
    expect(parseAssistAnswer({ reply: 'Nothing to change.', code: 'import protrade as pt', name: '' }, source).code).toBeNull();
  });

  it('unwraps a fenced answer', () => {
    expect(stripFence('```python\nx = 1\n```')).toBe('x = 1');
    expect(stripFence('x = "```"')).toBe('x = "```"');
    expect(parseAssistAnswer({ reply: 'ok', code: '```python\r\nx = 1\r\n```\n', name: '' }, source).code).toBe('x = 1\n');
  });

  it('keeps a sensible suggested name and drops anything else', () => {
    const name = (n: string) => parseAssistAnswer({ reply: 'ok', code: 'x = 1', name: n }, source).name;
    expect(name('rsi_screen')).toBe('rsi_screen.py');
    expect(name('RSI screen.PY')).toBe('RSI screen.py');
    expect(name('../evil.py')).toBeNull();
    expect(name('C:\\x.py')).toBeNull();
  });

  it('refuses an answer that isn’t the shape asked for', () => {
    expect(() => parseAssistAnswer({ reply: 'ok' }, source)).toThrow();
    expect(() => parseAssistAnswer(null, source)).toThrow();
    expect(() => parseAssistAnswer({ reply: '', code: '', name: '' }, source)).toThrow();
    expect(() => parseAssistAnswer({ reply: 'ok', code: 'x'.repeat(300 * 1024), name: '' }, source)).toThrow();
  });

  it('names a new script without taking an existing one', () => {
    expect(newScriptName('rsi.py', 'screen.py', ['screen.py'])).toBe('rsi.py');
    expect(newScriptName('rsi.py', 'screen.py', ['RSI.py'])).toBe('rsi_2.py');
    expect(newScriptName(null, 'screen.py', ['screen.py', 'screen_2.py'])).toBe('screen_3.py');
    expect(newScriptName(null, 'screen_2.py', ['screen_2.py'])).toBe('screen_3.py');
  });
});
