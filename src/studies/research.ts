/** The research agent's rounds: a question → Claude's plan of Studies → the ones the user approves,
 *  run one after another → Claude's synthesis → follow-up questions, each of which needs a new plan
 *  and a new approval. What Claude sends is untrusted: `parsePlan` validates every spec the way
 *  `parseDraft` does, and nothing here runs anything — `queue` only records what the user approved
 *  and what became of it. Pure. */

import { parseDraft } from './assistant';
import type { StudySpec } from './spec';

/** The most Studies a plan may hold (`MAX_PLAN_STUDIES` in `ai/prompts.rs`). */
export const MAX_PLAN_STUDIES = 4;
const MAX_TEXT = 4_000;
const MAX_NOTE = 1_000;
const MAX_ITEMS = 12;
const MAX_FOLLOW_UPS = 5;
const MAX_SYNTHESIS = 16_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function strings(value: unknown, max: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .slice(0, count)
    .map((v) => clip(v, max));
}

/** Paragraphs of plain text, split on blank lines. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

export interface PlannedStudy {
  purpose: string;
  /** Valid by `normalizeSpec`, or null with the reason in `problem`. */
  spec: StudySpec | null;
  problem: string | null;
  assumptions: string[];
  unavailable: string[];
}

export interface ResearchPlan {
  summary: string;
  studies: PlannedStudy[];
  unavailable: string[];
}

/** Reads Claude's answer to `ai_plan_research`. Never throws. Names are made unique within the
 *  plan, because each Study is saved under its name. */
export function parsePlan(answer: unknown): ResearchPlan {
  if (!isRecord(answer)) return { summary: '', studies: [], unavailable: ["Claude's plan wasn't in the expected form."] };
  const taken = new Set<string>();
  const studies = (Array.isArray(answer.studies) ? answer.studies : []).slice(0, MAX_PLAN_STUDIES).map((raw): PlannedStudy => {
    const item = isRecord(raw) ? raw : {};
    const draft = parseDraft({ reply: '', spec: item.spec ?? null, assumptions: item.assumptions, unavailable: item.unavailable });
    let spec = draft.spec;
    if (spec) {
      let name = spec.name;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${spec.name.slice(0, 110)} (${n})`;
      taken.add(name.toLowerCase());
      spec = { ...spec, name };
    }
    return {
      purpose: typeof item.purpose === 'string' ? clip(item.purpose, MAX_NOTE) : '',
      spec,
      problem: draft.problem ?? (item.spec ? null : 'Claude proposed no specification for this Study.'),
      assumptions: draft.assumptions,
      unavailable: draft.unavailable,
    };
  });
  return {
    summary: typeof answer.summary === 'string' ? clip(answer.summary, MAX_TEXT) : '',
    studies,
    unavailable: strings(answer.unavailable, MAX_NOTE, MAX_ITEMS),
  };
}

export interface Synthesis {
  paragraphs: string[];
  /** Per Study of the round, by its position in the round's `ran` list; null when Claude gave none. */
  notes: (string | null)[];
  caveats: string[];
  followUps: string[];
}

/** Reads Claude's answer to `ai_synthesize_research` about `count` Studies. Null when there is no
 *  synthesis in it. Notes for an index outside the round are dropped. */
export function parseSynthesis(answer: unknown, count: number): Synthesis | null {
  if (!isRecord(answer) || typeof answer.synthesis !== 'string' || !answer.synthesis.trim()) return null;
  const notes: (string | null)[] = Array.from({ length: count }, () => null);
  if (Array.isArray(answer.notes)) {
    for (const n of answer.notes) {
      if (!isRecord(n) || typeof n.note !== 'string' || !n.note.trim()) continue;
      const i = n.index;
      if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count && notes[i] === null) notes[i] = clip(n.note, MAX_NOTE);
    }
  }
  return {
    paragraphs: paragraphs(clip(answer.synthesis, MAX_SYNTHESIS)),
    notes,
    caveats: strings(answer.caveats, MAX_NOTE, MAX_ITEMS),
    followUps: strings(answer.follow_ups, MAX_NOTE, MAX_FOLLOW_UPS),
  };
}

/** The synthesis as the next round's plan is given it. */
export function synthesisContext(synthesis: Synthesis): string {
  return [...synthesis.paragraphs, ...synthesis.caveats.map((c) => `Caveat: ${c}`)].join('\n\n');
}

/** What a round adds to its notebook's notes: plain text, as the notebook shows it. */
export function roundNotes(round: number, question: string, plan: ResearchPlan, date: string): string {
  const lines = [`Round ${round} (${date}): ${question.trim()}`];
  if (plan.summary) lines.push('', `Plan: ${plan.summary}`);
  if (plan.unavailable.length) lines.push('', 'Not studied (no data):', ...plan.unavailable.map((u) => `- ${u}`));
  return lines.join('\n');
}

export function synthesisNotes(round: number, synthesis: Synthesis): string {
  const lines = [`Round ${round}: Claude's synthesis (historical association, not causation)`, '', synthesis.paragraphs.join('\n\n')];
  if (synthesis.caveats.length) lines.push('', 'Caveats:', ...synthesis.caveats.map((c) => `- ${c}`));
  if (synthesis.followUps.length) lines.push('', 'Follow-up questions:', ...synthesis.followUps.map((f) => `- ${f}`));
  return lines.join('\n');
}

/** Appends a block to a notebook's notes, separated from what's there. */
export function appendNotes(notes: string, block: string): string {
  return notes.trim() ? `${notes.trimEnd()}\n\n———\n\n${block}` : block;
}

// ---- The run queue ----------------------------------------------------------------------------

/** proposed → approved (ticked) → queued (Run pressed) → running → done | failed; queued → skipped
 *  on Stop. A Study never moves past `approved` without the user pressing Run. */
export type ItemStatus = 'proposed' | 'approved' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface QueueItem {
  status: ItemStatus;
  /** The saved Study, once Run was pressed. */
  studyId: string | null;
  resultId: string | null;
  error: string | null;
}

export type QueueAction =
  | { type: 'toggle'; index: number; runnable: boolean }
  | { type: 'queue'; studyIds: (string | null)[] }
  | { type: 'running'; index: number }
  | { type: 'done'; index: number; resultId: string | null }
  | { type: 'failed'; index: number; error: string }
  | { type: 'stop' };

export function newQueue(plan: ResearchPlan): QueueItem[] {
  return plan.studies.map(() => ({ status: 'proposed', studyId: null, resultId: null, error: null }));
}

export function queue(items: QueueItem[], action: QueueAction): QueueItem[] {
  const set = (index: number, patch: Partial<QueueItem>) => items.map((it, i) => (i === index ? { ...it, ...patch } : it));
  switch (action.type) {
    case 'toggle': {
      const it = items[action.index];
      if (!it || (it.status !== 'proposed' && it.status !== 'approved')) return items;
      if (it.status === 'proposed' && !action.runnable) return items;
      return set(action.index, { status: it.status === 'proposed' ? 'approved' : 'proposed' });
    }
    case 'queue':
      return items.map((it, i) => (it.status === 'approved' ? { ...it, status: 'queued', studyId: action.studyIds[i] ?? it.studyId } : it));
    case 'running':
      return items[action.index]?.status === 'queued' ? set(action.index, { status: 'running' }) : items;
    case 'done':
      return set(action.index, { status: 'done', resultId: action.resultId, error: null });
    case 'failed':
      return set(action.index, { status: 'failed', error: action.error });
    case 'stop':
      return items.map((it) => (it.status === 'queued' ? { ...it, status: 'skipped' } : it));
  }
}

/** The next Study to run, or -1. */
export const nextQueued = (items: QueueItem[]) => items.findIndex((it) => it.status === 'queued');

export const isRunning = (items: QueueItem[]) => items.some((it) => it.status === 'queued' || it.status === 'running');

/** The round's finished Studies, in order: what a synthesis covers. */
export const finished = (items: QueueItem[]) => items.flatMap((it, i) => (it.status === 'done' && it.resultId ? [i] : []));
