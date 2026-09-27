/** "Generate Python": a Study as a script an advanced user can read, change and run in the Python tab.
 *
 *  The script carries the spec it was made from and calls the engine one step at a time, so each
 *  stage can be inspected or replaced. It is generated, shown, and saved only when asked; never run
 *  by itself. Pure. */

import type { StudySpec } from './spec';

/** A JSON value as a Python literal: `null` → `None`, `true` → `True`. Strings are JSON-escaped,
 *  which is also a valid Python string (JSON's escapes are a subset of Python's). */
export function pythonLiteral(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 4);
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const flat = value.every((v) => v === null || typeof v !== 'object');
    const items = value.map((v) => pythonLiteral(v, indent + 4));
    if (flat && items.join(', ').length < 80) return `[${items.join(', ')}]`;
    return `[\n${items.map((i) => `${inner}${i},`).join('\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pythonLiteral(v, indent + 4)},`).join('\n')}\n${pad}}`;
}

/** A file name for the generated script that the scripts folder accepts: letters, digits and underscores. */
export function scriptName(spec: StudySpec): string {
  const stem = spec.name
    .toLowerCase()
    .replace(/%/g, 'pct')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `study_${stem || 'custom'}.py`;
}

export function generatePython(spec: StudySpec): string {
  return `"""${spec.name.replace(/"""/g, '"')} — generated from a Study Specification by ProTradeChart.

The Study Specification below is the source of truth; this script is one way to run it. Each step
can be inspected, changed or replaced. What it finds is historical association, not causation.
"""

from protrade.study import ResearchStudy

SPEC = ${pythonLiteral(spec)}

study = ResearchStudy(SPEC)

# 1. Universe: the symbols to study (instrument list, watchlist or a list of symbols).
universe = study.universe()

# 2. Historical data: daily bars from far enough back for every measurement, as the broker supplies them.
data = study.load(universe)

# 3. Event detection: every date the event conditions first held, with the filters judged at the time.
events = study.detect_events(data)

# 4. Comparison group: ${spec.outcome ? 'events split by whether they reached the outcome.' : 'random non-event dates from the same universe.'}
${
  spec.outcome
    ? 'events, control = study.split_by_outcome(events, data)'
    : 'control = study.control_group(data, events)'
}

# 5. Measurement: each metric at every observation point, each measure over its window, and what
#    happened afterwards.
results = study.measure(events, data)
control = study.measure(control, data) if len(control) else control

# 6. Aggregation: distributions, characteristics and forward returns; shown in the app.
summary = study.analyze(results, control, data)

# Everything is a pandas DataFrame from here on, e.g.:
# print(results.filter(like="@-63").describe())
`;
}
