import { describe, expect, it } from 'vitest';
import { generatePython, pythonLiteral, scriptName } from './codegen';
import { fromTemplate } from './templates';

describe('pythonLiteral', () => {
  it('writes JSON values as Python', () => {
    expect(pythonLiteral(null)).toBe('None');
    expect(pythonLiteral(true)).toBe('True');
    expect(pythonLiteral([1, 'a', false])).toBe('[1, "a", False]');
    expect(pythonLiteral({ a: { b: null } })).toBe('{\n    "a": {\n        "b": None,\n    },\n}');
    expect(pythonLiteral('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });
});

describe('generatePython', () => {
  it('carries the spec and calls each step', () => {
    const code = generatePython(fromTemplate('winners_100'));
    expect(code).toContain('from protrade.study import ResearchStudy');
    expect(code).toContain('"name": "100% Winners"');
    expect(code).toContain('"market_cap_min": None');
    expect(code).toContain('study.detect_events(data)');
    expect(code).toContain('study.control_group(data, events)');
    expect(code).not.toContain('null');
  });

  it('uses the outcome split when the spec has one', () => {
    expect(generatePython(fromTemplate('breakout_winners'))).toContain('study.split_by_outcome(events, data)');
  });

  it('names the script so the scripts folder accepts it', () => {
    expect(scriptName(fromTemplate('winners_100'))).toBe('study_100pct_winners.py');
    const odd = fromTemplate('custom');
    odd.name = '***';
    expect(scriptName(odd)).toBe('study_custom.py');
  });
});
