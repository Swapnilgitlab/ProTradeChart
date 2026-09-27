import { describe, expect, it } from 'vitest';
import { progressText } from './assistant';
import {
  appendNotes,
  finished,
  isRunning,
  newQueue,
  nextQueued,
  parsePlan,
  parseSynthesis,
  queue,
  roundNotes,
  synthesisContext,
  synthesisNotes,
  type QueueItem,
} from './research';
import { TEMPLATES } from './templates';

const spec = (i = 0) => structuredClone(TEMPLATES[i].spec) as Record<string, any>;

describe('reading a plan', () => {
  it('validates every spec and keeps what it assumed', () => {
    const bad = spec();
    bad.metrics = ['nonsense'];
    const plan = parsePlan({
      summary: 'Two angles.',
      studies: [
        { purpose: 'The event.', spec: spec(), assumptions: ['NSE only'], unavailable: [] },
        { purpose: 'Broken.', spec: bad, assumptions: [], unavailable: [] },
        { purpose: 'No spec.', spec: null, assumptions: [], unavailable: ['Sector data'] },
      ],
      unavailable: ['Market cap'],
    });
    expect(plan.summary).toBe('Two angles.');
    expect(plan.studies[0]).toMatchObject({ purpose: 'The event.', problem: null, assumptions: ['NSE only'] });
    expect(plan.studies[0].spec?.template).toBeNull();
    expect(plan.studies[1].spec).toBeNull();
    expect(plan.studies[1].problem).toMatch(/unknown feature/);
    expect(plan.studies[2].problem).toMatch(/no specification/);
    expect(plan.unavailable).toEqual(['Market cap']);
  });

  it('holds at most four Studies, each with its own name', () => {
    const plan = parsePlan({ summary: '', studies: Array.from({ length: 6 }, () => ({ purpose: 'p', spec: spec() })), unavailable: [] });
    expect(plan.studies).toHaveLength(4);
    const names = plan.studies.map((s) => s.spec!.name);
    expect(new Set(names).size).toBe(4);
    expect(names[1]).toBe(`${names[0]} (2)`);
  });

  it('reads specs sent as JSON text, and an empty one as none', () => {
    const plan = parsePlan({
      summary: '',
      studies: [
        { purpose: 'a', spec: JSON.stringify(spec()) },
        { purpose: 'b', spec: '' },
      ],
      unavailable: [],
    });
    expect(plan.studies[0].spec?.name).toBe(TEMPLATES[0].spec.name);
    expect(plan.studies[1].spec).toBeNull();
    expect(plan.studies[1].problem).toMatch(/no specification/);
  });

  it('survives junk', () => {
    expect(parsePlan('nope').studies).toEqual([]);
    expect(parsePlan({ studies: 'x' }).studies).toEqual([]);
  });
});

describe('reading a synthesis', () => {
  it('matches notes to the round’s Studies by index and drops the rest', () => {
    const s = parseSynthesis(
      {
        synthesis: 'First.\n\nSecond\nline.',
        notes: [
          { index: 1, note: 'B' },
          { index: 0, note: 'A' },
          { index: 5, note: 'out of range' },
          { index: 0, note: 'duplicate' },
          { index: 1.5, note: 'not an index' },
        ],
        caveats: ['Survivorship'],
        follow_ups: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
      3,
    )!;
    expect(s.paragraphs).toEqual(['First.', 'Second line.']);
    expect(s.notes).toEqual(['A', 'B', null]);
    expect(s.followUps).toHaveLength(5);
    expect(parseSynthesis({ synthesis: ' ' }, 1)).toBeNull();
    expect(synthesisContext(s)).toBe('First.\n\nSecond line.\n\nCaveat: Survivorship');
  });
});

describe('notebook notes', () => {
  it('records each round and its synthesis as plain text', () => {
    const plan = parsePlan({ summary: 'Look at winners.', studies: [], unavailable: ['Sector'] });
    const round = roundNotes(1, ' Why do stocks double? ', plan, '2026-09-26');
    expect(round).toBe('Round 1 (2026-09-26): Why do stocks double?\n\nPlan: Look at winners.\n\nNot studied (no data):\n- Sector');
    const synthesis = parseSynthesis({ synthesis: 'They trended.', caveats: [], follow_ups: ['On BSE?'] }, 0)!;
    const notes = appendNotes(appendNotes('', round), synthesisNotes(1, synthesis));
    expect(notes).toContain('———');
    expect(notes).toContain("Round 1: Claude's synthesis (historical association, not causation)");
    expect(notes).toContain('- On BSE?');
  });
});

describe('the run queue', () => {
  const three = () => newQueue(parsePlan({ summary: '', studies: [0, 1, 2].map((i) => ({ purpose: '', spec: spec(i) })), unavailable: [] }));

  it('runs only what was approved, when Run is pressed', () => {
    let q: QueueItem[] = three();
    q = queue(q, { type: 'toggle', index: 0, runnable: true });
    q = queue(q, { type: 'toggle', index: 1, runnable: false });
    q = queue(q, { type: 'toggle', index: 2, runnable: true });
    expect(q.map((i) => i.status)).toEqual(['approved', 'proposed', 'approved']);
    expect(nextQueued(q)).toBe(-1);
    q = queue(q, { type: 'queue', studyIds: ['s0', 's1', 's2'] });
    expect(q.map((i) => i.status)).toEqual(['queued', 'proposed', 'queued']);
    expect(q[1].studyId).toBeNull();
    expect(nextQueued(q)).toBe(0);
    expect(isRunning(q)).toBe(true);
    q = queue(q, { type: 'toggle', index: 0, runnable: true });
    expect(q[0].status).toBe('queued');
  });

  it('carries on after a failure, and Stop skips what hasn’t started', () => {
    let q: QueueItem[] = three();
    for (const index of [0, 1, 2]) q = queue(q, { type: 'toggle', index, runnable: true });
    q = queue(q, { type: 'queue', studyIds: ['a', 'b', 'c'] });
    q = queue(q, { type: 'running', index: 0 });
    q = queue(q, { type: 'failed', index: 0, error: 'broker down' });
    expect(nextQueued(q)).toBe(1);
    q = queue(q, { type: 'running', index: 1 });
    q = queue(q, { type: 'done', index: 1, resultId: 'r1' });
    q = queue(q, { type: 'stop' });
    expect(q.map((i) => i.status)).toEqual(['failed', 'done', 'skipped']);
    expect(isRunning(q)).toBe(false);
    expect(finished(q)).toEqual([1]);
  });
});

describe('progress text', () => {
  it('says what a streaming answer is doing', () => {
    expect(progressText(null)).toBe('Thinking…');
    expect(progressText({ stage: 'writing', chars: 420 })).toBe('Writing… 420 characters');
    expect(progressText({ stage: 'writing', chars: 2140 })).toBe('Writing… 2.1k characters');
  });
});
