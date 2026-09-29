import { describe, expect, it } from 'vitest';
import { attributionInk, chosenBackground, isDarkBackground, isThemeBackground, normalizeColor } from './canvasBackground';

describe('canvas backgrounds', () => {
  it('spells a colour one way', () => {
    expect(normalizeColor(' #FFF ')).toBe('#ffffff');
    expect(normalizeColor('#151619ff')).toBe('#151619');
    expect(normalizeColor('rgb(21, 22, 25)')).toBe('#151619');
    expect(normalizeColor('rgba(255,255,255,1)')).toBe('#ffffff');
    expect(normalizeColor('rgba(0,0,0,0.5)')).toBe('#00000080');
    for (const bad of ['red', 'rgb(300,0,0)', '#12', '', null, 7]) expect(normalizeColor(bad)).toBeNull();
  });

  it('treats Vela’s dark and light defaults as the theme’s', () => {
    for (const theme of ['#151619', '#FFFFFF', 'rgb(255, 255, 255)', '#fff']) expect(isThemeBackground(theme)).toBe(true);
    for (const chosen of ['#0b1f3a', '#000000', '#fdf6e3']) expect(isThemeBackground(chosen)).toBe(false);
    // Nothing usable counts as "the theme's": there is nothing to keep.
    expect(isThemeBackground(undefined)).toBe(true);
  });

  it('reads the chosen background from a chart’s settings', () => {
    expect(chosenBackground({ layout: { background: '#0b1f3a', textColor: '#fff' } })).toBe('#0b1f3a');
    expect(chosenBackground({ layout: { background: '#151619' } })).toBeNull();
    expect(chosenBackground({ layout: {} })).toBeNull();
    expect(chosenBackground({})).toBeNull();
    expect(chosenBackground(null)).toBeNull();
  });

  it('inks the attribution mark for the background it sits on, as Vela does', () => {
    expect(isDarkBackground('#151619')).toBe(true);
    expect(isDarkBackground('#0b1f3a')).toBe(true);
    expect(isDarkBackground('#ffffff')).toBe(false);
    expect(isDarkBackground('#fdf6e3')).toBe(false);
    expect(isDarkBackground('not a colour')).toBe(true);
    expect(attributionInk('#0b1f3a').color).toBe('#ffffff');
    expect(attributionInk('#ffffff').color).toBe('#000000');
  });
});
