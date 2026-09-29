import { describe, expect, it } from 'vitest';
import { clampPanelWidth, DEFAULT_PANEL_WIDTH, dragWidth, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, parsePanelWidth } from './panelWidth';

describe('the side panel’s width', () => {
  it('stays between its limits and leaves the chart room', () => {
    expect(clampPanelWidth(100, 1600)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(5000, 1600)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(420.4, 1600)).toBe(420);
    // A narrow window: the chart keeps 360px.
    expect(clampPanelWidth(600, 900)).toBe(540);
    // A tiny window still gets the minimum panel.
    expect(clampPanelWidth(600, 400)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('widens as its left edge is dragged left', () => {
    expect(dragWidth(300, 1000, 900, 1600)).toBe(400);
    expect(dragWidth(300, 1000, 1100, 1600)).toBe(MIN_PANEL_WIDTH);
  });

  it('reads the stored width, or the default', () => {
    expect(parsePanelWidth('412')).toBe(412);
    for (const bad of [null, undefined, '', 'wide', '-5']) expect(parsePanelWidth(bad)).toBe(DEFAULT_PANEL_WIDTH);
  });
});
