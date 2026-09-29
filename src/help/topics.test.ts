import { describe, expect, it } from 'vitest';
import { FAMILIES, PLAIN } from '../studies/metrics';
import { HELP_GROUPS, HELP_TOPICS, inlineParts, searchHelp, SHORTCUTS, topicById } from './topics';

describe('the Help Center’s topics', () => {
  it('have unique ids, and every related topic exists', () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of HELP_TOPICS) for (const r of t.related ?? []) expect(topicById(r), `${t.id} → ${r}`).toBeDefined();
  });

  it('each have a title, a summary and content, in a known group; every group has topics', () => {
    for (const t of HELP_TOPICS) {
      expect(t.title && t.summary && t.sections.length > 0, t.id).toBeTruthy();
      expect(HELP_GROUPS).toContain(t.group);
      for (const s of t.sections) expect(s.blocks.length, `${t.id}: ${s.heading}`).toBeGreaterThan(0);
    }
    for (const g of HELP_GROUPS) expect(HELP_TOPICS.some((t) => t.group === g), g).toBe(true);
  });

  it('close every bold and code mark they open', () => {
    const texts = HELP_TOPICS.flatMap((t) =>
      t.sections.flatMap((s) =>
        s.blocks.flatMap((b) => (b.kind === 'table' ? b.rows.flat() : b.kind === 'steps' || b.kind === 'list' ? b.items : b.kind === 'code' ? [] : [b.text])),
      ),
    );
    for (const text of texts) {
      expect((text.match(/\*\*/g) ?? []).length % 2, text).toBe(0);
      expect((text.match(/`/g) ?? []).length % 2, text).toBe(0);
    }
  });

  it('cover every area reachable from the right rail and the tab bar', () => {
    for (const id of ['home', 'watchlists', 'alerts', 'ask-ai', 'pine', 'python', 'studies', 'screener', 'data-providers', 'ai-providers', 'layouts', 'import-csv', 'appearance', 'updates', 'schedules']) {
      expect(topicById(id), id).toBeDefined();
    }
  });

  it('list every feature the Screener and Studies accept in the indicator reference', () => {
    const rows = topicById('indicators')!.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === 'table' ? b.rows.map((r) => r[0]) : []));
    for (const f of FAMILIES) expect(rows.some((r) => r.startsWith(`\`${f}_N\``)), f).toBe(true);
    for (const f of PLAIN) expect(rows.some((r) => r.startsWith(`\`${f}\``)), f).toBe(true);
  });

  it('list the app’s shortcuts, F1 among them', () => {
    const table = topicById('shortcuts')!.sections[0].blocks[0];
    expect(table.kind === 'table' && table.rows).toEqual(SHORTCUTS);
    expect(SHORTCUTS.map((s) => s[0])).toContain('F1');
  });
});

describe('inlineParts', () => {
  it('splits bold and code from plain text', () => {
    expect(inlineParts('Press **Save** or `Ctrl+S` now.')).toEqual([
      { text: 'Press ', style: 'plain' },
      { text: 'Save', style: 'bold' },
      { text: ' or ', style: 'plain' },
      { text: 'Ctrl+S', style: 'code' },
      { text: ' now.', style: 'plain' },
    ]);
  });

  it('keeps an unclosed mark as text, and never produces markup', () => {
    expect(inlineParts('a ** b')).toEqual([{ text: 'a ** b', style: 'plain' }]);
    expect(inlineParts('<b>x</b>')).toEqual([{ text: '<b>x</b>', style: 'plain' }]);
  });
});

describe('searchHelp', () => {
  it('finds topics by title first, then by their content', () => {
    expect(searchHelp('zerodha')[0].topic.id).toBe('zerodha');
    expect(searchHelp('price alerts')[0].topic.id).toBe('alerts');
    expect(searchHelp('request_token').map((m) => m.topic.id)).toContain('zerodha');
  });

  it('needs every word, ignores case, and shows where it matched', () => {
    const hits = searchHelp('MISSED schedule');
    expect(hits[0].topic.id).toBe('schedules');
    expect(hits[0].snippet.toLowerCase()).toContain('missed');
    expect(searchHelp('zerodha xylophone')).toEqual([]);
    expect(searchHelp('   ')).toEqual([]);
  });
});
