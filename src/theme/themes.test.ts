import { describe, expect, it } from 'vitest';
import { defaultThemeKey, getTheme, THEMES } from './themes';

describe('themes', () => {
  it('have unique keys', () => {
    expect(new Set(THEMES.map((t) => t.key)).size).toBe(THEMES.length);
  });

  it('every theme defines the same complete set of tokens', () => {
    const reference = Object.keys(THEMES[0].tokens).sort();
    for (const theme of THEMES) expect(Object.keys(theme.tokens).sort(), theme.key).toEqual(reference);
  });

  it('offer both a light and a dark base', () => {
    expect(THEMES.some((t) => t.baseMode === 'light')).toBe(true);
    expect(THEMES.some((t) => t.baseMode === 'dark')).toBe(true);
  });

  it('fall back to the first theme for an unknown key', () => {
    expect(getTheme('nope')).toBe(THEMES[0]);
  });

  it('pick a default that matches the OS preference', () => {
    expect(getTheme(defaultThemeKey(true)).baseMode).toBe('dark');
    expect(getTheme(defaultThemeKey(false)).baseMode).toBe('light');
  });
});
