import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { explainSummary, parseDraft, parseExplanation, SPEC_SCHEMA, specReference } from './assistant';
import { specChanges } from './compare';
import { ALIASES, FAMILIES, PLAIN } from './metrics';
import { parseStudyResult } from './result';
import { TEMPLATES } from './templates';

type Schema = Record<string, any>;

/** Checks a value against the subset of JSON Schema `SPEC_SCHEMA` uses. */
function matches(schema: Schema, value: unknown): boolean {
  if (schema.anyOf) return schema.anyOf.some((s: Schema) => matches(s, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value) && value.every((v) => matches(schema.items, v));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (!schema.required.every((k: string) => k in record)) return false;
      return Object.entries(record).every(([k, v]) => k in schema.properties && matches(schema.properties[k], v));
    }
    default:
      return false;
  }
}

/** Every keyword in a schema, at any depth. */
function keywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((s) => keywords(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      out.add(k);
      if (k === 'properties') Object.values(v as object).forEach((s) => keywords(s, out));
      else keywords(v, out);
    }
  }
  return out;
}

/** Every object schema, at any depth. */
function objects(schema: unknown, out: Schema[] = []): Schema[] {
  if (Array.isArray(schema)) schema.forEach((s) => objects(s, out));
  else if (schema && typeof schema === 'object') {
    if ((schema as Schema).type === 'object') out.push(schema as Schema);
    Object.values(schema).forEach((v) => objects(v, out));
  }
  return out;
}

const withLabels = (spec: object) =>
  JSON.parse(JSON.stringify(spec), (_key, value) =>
    // A condition's label is optional in the app and required-but-nullable in the schema.
    value && typeof value === 'object' && 'op' in value && !('label' in value) ? { ...value, label: null } : value,
  );

describe('the spec schema sent to Claude', () => {
  it('describes every template the app ships', () => {
    for (const t of TEMPLATES) expect(matches(SPEC_SCHEMA, withLabels(t.spec)), t.id).toBe(true);
  });

  it('uses only what structured outputs accept, with every object closed', () => {
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'format']);
    for (const k of keywords(SPEC_SCHEMA)) expect(allowed.has(k), k).toBe(true);
    for (const o of objects(SPEC_SCHEMA)) {
      expect(o.additionalProperties).toBe(false);
      for (const k of o.required) expect(o.properties).toHaveProperty(k);
    }
  });

  it('never lets Claude set a market-cap floor', () => {
    expect((SPEC_SCHEMA.properties.universe as Schema).properties.market_cap_min).toEqual({ type: 'null' });
  });
});

describe('the spec reference', () => {
  it('names every feature family, plain feature and alias', () => {
    const text = specReference();
    for (const f of FAMILIES) expect(text).toContain(`- ${f}_N: `);
    for (const p of PLAIN) expect(text).toContain(`- ${p}: `);
    for (const a of Object.keys(ALIASES)) expect(text).toContain(a);
    expect(text).toContain(JSON.stringify(SPEC_SCHEMA));
  });
});

describe('reading a draft', () => {
  const spec = () => structuredClone(TEMPLATES[0].spec) as Record<string, any>;

  it('accepts a valid spec, normalised, and never as a template', () => {
    const d = parseDraft({ reply: 'Here it is.', spec: spec(), assumptions: ['Period: 5 years'], unavailable: [] });
    expect(d.problem).toBeNull();
    expect(d.spec?.name).toBe(TEMPLATES[0].spec.name);
    expect(d.spec?.template).toBeNull();
    expect(d.assumptions).toEqual(['Period: 5 years']);
  });

  it("refuses a spec the app wouldn't run, and says why", () => {
    const bad = spec();
    bad.metrics = ['made_up_feature'];
    const d = parseDraft({ reply: 'x', spec: bad, assumptions: [], unavailable: [] });
    expect(d.spec).toBeNull();
    expect(d.problem).toMatch(/unknown feature/);
  });

  it('reads a spec sent as JSON text, as the API returns it', () => {
    const d = parseDraft({ reply: 'ok', spec: JSON.stringify(spec()), assumptions: [], unavailable: [] });
    expect(d.problem).toBeNull();
    expect(d.spec?.name).toBe(TEMPLATES[0].spec.name);
    expect(parseDraft({ reply: 'none', spec: '  ', assumptions: [], unavailable: [] })).toMatchObject({ spec: null, problem: null });
    expect(parseDraft({ reply: 'x', spec: '{"version":1,', assumptions: [], unavailable: [] }).problem).toMatch(/valid JSON/);
    const bad = spec();
    bad.period = { start: 'soon' };
    expect(parseDraft({ reply: 'x', spec: JSON.stringify(bad), assumptions: [], unavailable: [] }).problem).toMatch(/period.start/);
  });

  it('keeps no spec when the question cannot be studied', () => {
    const d = parseDraft({ reply: 'No sector data.', spec: null, assumptions: [], unavailable: ['Sector'] });
    expect(d).toMatchObject({ spec: null, problem: null, unavailable: ['Sector'] });
  });

  it('caps and filters what it shows', () => {
    const d = parseDraft({ reply: 'r'.repeat(5000), spec: null, assumptions: [1, '', 'ok', ...Array(30).fill('a')], unavailable: 'no' });
    expect(d.reply.length).toBeLessThanOrEqual(2000);
    expect(d.assumptions[0]).toBe('ok');
    expect(d.assumptions.length).toBe(12);
    expect(d.unavailable).toEqual([]);
    expect(parseDraft('junk').problem).toBeTruthy();
  });
});

describe('explanations', () => {
  it('splits paragraphs and keeps caveats', () => {
    const e = parseExplanation({ explanation: 'One\nline.\n\nTwo.', caveats: ['Survivorship'] });
    expect(e).toEqual({ paragraphs: ['One line.', 'Two.'], caveats: ['Survivorship'] });
    expect(parseExplanation({ explanation: '  ' })).toBeNull();
    expect(parseExplanation(null)).toBeNull();
  });

  it('are given counts, tests and medians, never events or symbols', () => {
    const result = parseStudyResult(engineResult)!;
    const summary = explainSummary(result);
    const text = JSON.stringify(summary);
    expect(summary).toHaveProperty('summary.events', result.summary.events);
    expect(summary).not.toHaveProperty('events');
    for (const row of result.events.rows.slice(0, 20)) {
      const symbol = row[result.events.columns.indexOf('symbol')];
      if (typeof symbol === 'string') expect(text).not.toContain(symbol);
    }
  });
});

describe('what a revision changed', () => {
  it('describes the parts that differ', () => {
    const a = TEMPLATES[0].spec;
    const b = { ...a, universe: { ...a.universe, exchanges: ['NSE', 'BSE'] as ('NSE' | 'BSE')[] } };
    expect(specChanges(a, a)).toEqual([]);
    expect(specChanges(a, b).map((d) => d.part)).toEqual(['Universe']);
  });
});
