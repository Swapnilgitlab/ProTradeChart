/** The Studies that ship with the app. Each is a complete Study Specification to clone and edit;
 *  none is special to the engine. Pure. */

import { normalizeSpec, type Condition, type StudySpec } from './spec';

export interface StudyTemplate {
  id: string;
  name: string;
  summary: string;
  spec: StudySpec;
}

/** What most templates measure: returns into the event, trend, the 52-week range, volume,
 *  volatility and relative strength. Distances from the averages rather than the averages
 *  themselves, because a ₹40 and a ₹4,000 stock's 200 EMA can't be compared. */
const METRICS = [
  'return_21',
  'return_63',
  'return_126',
  'return_252',
  'rsi_14',
  'atr_pct_14',
  'dist_ema_20',
  'dist_ema_50',
  'dist_ema_100',
  'dist_ema_200',
  'dist_high_252',
  'dist_low_252',
  'rvol_20',
  'avg_traded_value_50',
  'volatility_63',
  'max_drawdown_252',
  'rs_126',
];

const CHARACTERISTICS: Condition[] = [
  { label: 'Above 200 EMA', left: 'close', op: '>', right: 'ema_200' },
  { label: '50 EMA above 200 EMA', left: 'ema_50', op: '>', right: 'ema_200' },
  { label: 'Within 10% of 52W high', left: 'dist_high_252', op: '>=', right: -0.1 },
  { label: 'Rising 200-day SMA', left: 'slope_sma_200', op: '>', right: 0 },
  { label: 'Relative volume > 1.5', left: 'rvol_20', op: '>', right: 1.5 },
  { label: 'Relative volume > 2', left: 'rvol_20', op: '>', right: 2 },
];

const BEFORE_12M = { start: { offset: -252 }, end: { offset: 0 } };
const FROM_LOW = { start: { find: 'lowest', feature: 'close', within: 252 }, end: { offset: 0 } };
const UNTIL_BELOW_50 = {
  start: { offset: 0 },
  end: { find: 'first', conditions: [{ left: 'close', op: '<', right: 'sma_50' }], direction: 'after', within: 252, if_not_found: 'cap' },
};
const AFTER_6M = { start: { offset: 0 }, end: { offset: 126 } };

/** ₹1 Cr a day of average traded value: the liquidity floor the templates use in place of a
 *  market-cap floor, which no data source can supply. */
export const DEFAULT_MIN_TRADED_VALUE = 1e7;
export const DEFAULT_BENCHMARK = 'zerodha:NSE:NIFTY_500';

/** What a template changes from the base. Measures are written in their short form (defaults left
 *  out); `normalizeSpec` completes them. */
type Extra = Omit<Partial<StudySpec>, 'measures'> & { measures?: Record<string, unknown>[] };

function base(name: string, template: string, description: string, event: StudySpec['event'], extra: Extra = {}): StudySpec {
  return normalizeSpec({
    version: 1,
    name,
    description,
    template,
    universe: {
      source: 'instruments',
      provider: 'zerodha',
      exchanges: ['NSE'],
      series: ['EQ'],
      watchlist: null,
      symbols: [],
      market_cap_min: null,
      min_avg_traded_value: DEFAULT_MIN_TRADED_VALUE,
      min_price: null,
      max_symbols: null,
    },
    period: { start: '2018-01-01', end: null },
    event,
    pre_event_filters: [],
    lookback_windows: [252, 126, 63, 21],
    forward_windows: [63, 126, 252],
    metrics: METRICS,
    characteristics: CHARACTERISTICS,
    benchmark: DEFAULT_BENCHMARK,
    outcome: null,
    control_group: { enabled: true, samples_per_event: 2, seed: 42 },
    output: { max_events: 5000 },
    ...extra,
  });
}

export const TEMPLATES: readonly StudyTemplate[] = [
  {
    id: 'winners_100',
    name: '100% Winners',
    summary: 'Stocks whose 12-month return crossed +100%: what they looked like 12, 6, 3 and 1 months before.',
    spec: base(
      '100% Winners',
      'winners_100',
      'Every date a stock’s 12-month return crossed +100%, and its price, volume and technical state before and after.',
      { label: '12M return crosses +100%', conditions: [{ left: 'return_252', op: 'crosses_above', right: 1 }], cooldown_days: 252 },
      {
        question: 'What did stocks look like on the way to doubling in a year, and what happened next?',
        measures: [
          {
            label: 'Closed above its 50 EMA',
            stat: 'share',
            headline: true,
            conditions: [{ left: 'close', op: '>', right: 'ema_50' }],
            window: { start: { offset: -252 }, end: { offset: 0 } },
          },
          {
            label: 'The run from its 12-month low',
            stat: 'length',
            headline: true,
            window: { start: { find: 'lowest', feature: 'close', within: 252 }, end: { offset: 0 } },
          },
          { label: 'Worst fall on the way up', stat: 'max_drawdown', window: { start: { offset: -252 }, end: { offset: 0 } } },
          { label: 'Worst fall in the 6 months after', stat: 'max_drawdown', window: { start: { offset: 0 }, end: { offset: 126 } } },
        ],
      },
    ),
  },
  {
    id: 'winners_200',
    name: '200% Winners',
    summary: 'Stocks whose 12-month return crossed +200%.',
    spec: base(
      '200% Winners',
      'winners_200',
      'Every date a stock’s 12-month return crossed +200%.',
      { label: '12M return crosses +200%', conditions: [{ left: 'return_252', op: 'crosses_above', right: 2 }], cooldown_days: 252 },
      {
        question: 'How did stocks that tripled in a year get there?',
        measures: [
          { label: 'Closed above its 50 EMA', stat: 'share', headline: true, conditions: [{ left: 'close', op: '>', right: 'ema_50' }], window: BEFORE_12M },
          { label: 'The run from its 12-month low', stat: 'length', headline: true, window: FROM_LOW },
          { label: 'Worst fall on the way up', stat: 'max_drawdown', window: BEFORE_12M },
        ],
      },
    ),
  },
  {
    id: 'breakout_winners',
    name: 'Breakout Winners',
    summary: 'New 52-week-high breakouts that went on to gain 30% within 6 months, against the breakouts that didn’t.',
    spec: base(
      'Breakout Winners',
      'breakout_winners',
      'Closes above the previous 52-week high. Breakouts that rose 30% or more within six months are compared with those that did not.',
      { label: 'Close breaks the prior 52W high', conditions: [{ left: 'close', op: 'crosses_above', right: 'prior_high_252' }], cooldown_days: 63 },
      {
        outcome: { window: 126, min_return: 0.3 },
        question: 'What set apart the 52-week-high breakouts that went on to gain 30%?',
        measures: [
          { label: 'Within 10% of its 52-week high', stat: 'share', headline: true, conditions: [{ left: 'dist_high_252', op: '>=', right: -0.1 }], window: { start: { offset: -126 }, end: { offset: 0 } } },
          { label: 'Tightness of the 3 months before (average range)', stat: 'mean', feature: 'atr_pct_14', window: { start: { offset: -63 }, end: { offset: 0 } } },
        ],
      },
    ),
  },
  {
    id: 'consolidation_breakouts',
    name: 'Post-Consolidation Breakouts',
    summary: 'Breakouts from a 3-month range under 25% wide, split by whether they gained 30% within 6 months.',
    spec: base(
      'Post-Consolidation Breakouts',
      'consolidation_breakouts',
      'A close above the prior 3-month high after three months inside a range less than 25% wide.',
      { label: 'Breakout from a 3M consolidation', conditions: [{ left: 'close', op: 'crosses_above', right: 'prior_high_63' }], cooldown_days: 63 },
      {
        pre_event_filters: [{ at: 1, left: 'range_63', op: '<=', right: 0.25, label: '3M range ≤ 25% the day before' }],
        metrics: [...METRICS, 'range_63', 'bb_width_20'],
        outcome: { window: 126, min_return: 0.3 },
      },
    ),
  },
  {
    id: 'volume_expansion',
    name: 'Volume Expansion',
    summary: 'Days of at least twice the 50-day average volume on an up day, split by whether 20% followed within 3 months.',
    spec: base(
      'Volume Expansion',
      'volume_expansion',
      'Volume at least 2× its 50-day average on an up day. Those followed by a 20% rise within three months are compared with the rest.',
      {
        label: 'Volume > 2× the 50-day average, on an up day',
        conditions: [
          { left: 'rvol_50', op: '>=', right: 2 },
          { left: 'return_1', op: '>', right: 0 },
        ],
        cooldown_days: 63,
      },
      { metrics: [...METRICS, 'rvol_50'], outcome: { window: 63, min_return: 0.2 } },
    ),
  },
  {
    id: 'trend_transition',
    name: 'Trend Transition',
    summary: 'Stocks crossing above their 200 EMA after three months below it.',
    spec: base(
      'Trend Transition',
      'trend_transition',
      'A close crossing above the 200-day EMA by a stock that was below it three months earlier.',
      { label: 'Close crosses above the 200 EMA', conditions: [{ left: 'close', op: 'crosses_above', right: 'ema_200' }], cooldown_days: 126 },
      { pre_event_filters: [{ at: 63, left: 'close', op: '<', right: 'ema_200', label: 'Below the 200 EMA 3M before' }], metrics: [...METRICS, 'slope_ema_200'] },
    ),
  },
  {
    id: 'rs_leaders',
    name: 'Relative Strength Leaders',
    summary: 'Stocks outperforming the Nifty 500 by more than 30 points over 6 months.',
    spec: base(
      'Relative Strength Leaders',
      'rs_leaders',
      'The 6-month return beat the Nifty 500’s by more than 30 percentage points.',
      { label: '6M return beats the Nifty 500 by 30 points', conditions: [{ left: 'rs_126', op: 'crosses_above', right: 0.3 }], cooldown_days: 126 },
    ),
  },
  {
    id: 'drawdown_recovery',
    name: 'Drawdown Recovery',
    summary: 'Stocks that fell 30% or more within a year and then closed at a new 52-week high.',
    spec: base(
      'Drawdown Recovery',
      'drawdown_recovery',
      'A new 52-week closing high by a stock that fell at least 30% from a peak within the past year.',
      {
        label: 'New 52W high after a 30% drawdown',
        conditions: [
          { left: 'close', op: 'crosses_above', right: 'prior_high_252' },
          { left: 'max_drawdown_252', op: '<=', right: -0.3 },
        ],
        cooldown_days: 252,
      },
    ),
  },
  {
    id: 'how_winners_got_there',
    name: 'How Winners Got There',
    summary: 'The journey of stocks that doubled in a year: how long the run from their low took, how often they held their averages, how deep the pullbacks went.',
    spec: base(
      'How Winners Got There',
      'how_winners_got_there',
      'For every stock whose 12-month return crossed +100%, the run from its 12-month low to that day, measured day by day.',
      { label: '12M return crosses +100%', conditions: [{ left: 'return_252', op: 'crosses_above', right: 1 }], cooldown_days: 252 },
      {
        question: 'On the way to doubling, how did winners behave: how long did the run take, and how often did they sit near their 21 EMA?',
        metrics: [],
        characteristics: [],
        measures: [
          { label: 'The run from its 12-month low', stat: 'length', headline: true, window: FROM_LOW },
          {
            label: 'Closed within 3% above its 21 EMA',
            stat: 'share',
            headline: true,
            conditions: [
              { left: 'dist_ema_21', op: '>=', right: 0 },
              { left: 'dist_ema_21', op: '<=', right: 0.03 },
            ],
            window: FROM_LOW,
          },
          { label: 'Pullbacks to within 3% of its 21 EMA', stat: 'runs', conditions: [{ left: 'dist_ema_21', op: '<=', right: 0.03 }], window: FROM_LOW },
          { label: 'Longest streak above its 50 SMA', stat: 'longest_run', conditions: [{ left: 'close', op: '>', right: 'sma_50' }], window: FROM_LOW },
          { label: 'Worst fall on the way up', stat: 'max_drawdown', window: FROM_LOW },
          { label: 'Return from the low', stat: 'return', window: FROM_LOW },
        ],
      },
    ),
  },
  {
    id: 'after_the_breakout',
    name: 'After the Breakout',
    summary: 'What happened after a new 52-week high: how long the trend held above the 50 SMA, and how far it fell.',
    spec: base(
      'After the Breakout',
      'after_the_breakout',
      'Every close above the previous 52-week high, and the six months that followed.',
      { label: 'Close breaks the prior 52W high', conditions: [{ left: 'close', op: 'crosses_above', right: 'prior_high_252' }], cooldown_days: 63 },
      {
        question: 'After breaking out to a new 52-week high, how long did stocks hold their trend, and how deep did they fall?',
        metrics: [],
        characteristics: [],
        measures: [
          { label: 'The trend until its first close below the 50 SMA', stat: 'length', headline: true, window: UNTIL_BELOW_50 },
          { label: 'Worst fall in the 6 months after', stat: 'max_drawdown', headline: true, window: AFTER_6M },
          { label: 'Closed above its 21 EMA', stat: 'share', conditions: [{ left: 'close', op: '>', right: 'ema_21' }], window: AFTER_6M },
          { label: 'Biggest rise in the 6 months after', stat: 'max_gain', window: AFTER_6M },
          { label: 'Return over the 6 months after', stat: 'return', window: AFTER_6M },
        ],
      },
    ),
  },
  {
    id: 'custom',
    name: 'Custom Study',
    summary: 'Start from a blank event and define every part yourself.',
    spec: base(
      'Custom Study',
      'custom',
      '',
      { label: '', conditions: [{ left: 'return_63', op: 'crosses_above', right: 0.5 }], cooldown_days: 63 },
      { metrics: ['return_21', 'return_63', 'rsi_14', 'dist_high_252', 'rvol_20'], characteristics: [], benchmark: null },
    ),
  },
];

/** A fresh copy of a template, to edit without touching the original. */
export function fromTemplate(id: string): StudySpec {
  const template = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
  return structuredClone(template.spec);
}
