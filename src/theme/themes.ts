/** The theme registry. Every theme supplies every token (TypeScript enforces
 *  it), and `ThemeProvider` applies them as inline custom properties on
 *  <html>. `baseMode` is the nearest light/dark flag Vela's own chrome and
 *  canvas understand — Vela accepts only `'light' | 'dark'`, never a custom
 *  theme name.
 *
 *  To add a theme: append an entry here. Nothing else needs to change. */

export type BaseMode = 'light' | 'dark';

export interface ThemeTokens {
  '--bg-base': string;
  '--surface-1': string;
  '--surface-hover': string;
  '--border': string;
  '--border-soft': string;
  '--text-primary': string;
  '--text-secondary': string;
  '--text-muted': string;
  '--accent': string;
  '--accent-soft': string;
  '--on-accent': string;
  '--loss': string;
  '--loss-soft': string;
  '--profit': string;
  '--shadow-pop': string;
  '--font-ui': string;
  '--r-sm': string;
  '--r-md': string;
  '--r-lg': string;
}

export interface ThemeDefinition {
  key: string;
  label: string;
  baseMode: BaseMode;
  tokens: ThemeTokens;
}

const SANS = '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Mono", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace';
const ROUND = { '--r-sm': '4px', '--r-md': '8px', '--r-lg': '12px' } as const;

export const DEFAULT_LIGHT_THEME = 'daylight';
export const DEFAULT_DARK_THEME = 'midnight';

export const THEMES: ThemeDefinition[] = [
  {
    key: 'daylight',
    label: 'Daylight',
    baseMode: 'light',
    tokens: {
      ...ROUND,
      '--font-ui': SANS,
      '--bg-base': '#f5f6f8',
      '--surface-1': '#ffffff',
      '--surface-hover': '#edf0f4',
      '--border': '#dde1e8',
      '--border-soft': '#eceff3',
      '--text-primary': '#12161c',
      '--text-secondary': '#586273',
      '--text-muted': '#8993a3',
      '--accent': '#2962ff',
      '--accent-soft': 'rgba(41, 98, 255, 0.10)',
      '--on-accent': '#ffffff',
      '--loss': '#d92d20',
      '--loss-soft': 'rgba(217, 45, 32, 0.10)',
      '--profit': '#0f8a5f',
      '--shadow-pop': '0 6px 20px rgba(16, 24, 40, 0.12)',
    },
  },
  {
    key: 'paper',
    label: 'Paper',
    baseMode: 'light',
    tokens: {
      ...ROUND,
      '--font-ui': SANS,
      '--bg-base': '#f3efe7',
      '--surface-1': '#fbf9f4',
      '--surface-hover': '#ebe5d8',
      '--border': '#dcd4c3',
      '--border-soft': '#e9e3d5',
      '--text-primary': '#241f17',
      '--text-secondary': '#665e4e',
      '--text-muted': '#978e7b',
      '--accent': '#b3541e',
      '--accent-soft': 'rgba(179, 84, 30, 0.11)',
      '--on-accent': '#ffffff',
      '--loss': '#b42318',
      '--loss-soft': 'rgba(180, 35, 24, 0.10)',
      '--profit': '#2c7a4b',
      '--shadow-pop': '0 6px 20px rgba(60, 45, 20, 0.14)',
    },
  },
  {
    key: 'midnight',
    label: 'Midnight',
    baseMode: 'dark',
    tokens: {
      ...ROUND,
      '--font-ui': SANS,
      '--bg-base': '#0a0d13',
      '--surface-1': '#11161f',
      '--surface-hover': '#1a2130',
      '--border': '#232c3b',
      '--border-soft': '#1a212d',
      '--text-primary': '#e6ebf2',
      '--text-secondary': '#95a1b4',
      '--text-muted': '#606c7e',
      '--accent': '#4c8dff',
      '--accent-soft': 'rgba(76, 141, 255, 0.14)',
      '--on-accent': '#ffffff',
      '--loss': '#f0656b',
      '--loss-soft': 'rgba(240, 101, 107, 0.14)',
      '--profit': '#3fce81',
      '--shadow-pop': '0 12px 32px rgba(0, 0, 0, 0.55)',
    },
  },
  {
    key: 'graphite',
    label: 'Graphite',
    baseMode: 'dark',
    tokens: {
      ...ROUND,
      '--font-ui': SANS,
      '--bg-base': '#131316',
      '--surface-1': '#1b1b1f',
      '--surface-hover': '#26262b',
      '--border': '#33333a',
      '--border-soft': '#26262b',
      '--text-primary': '#ececef',
      '--text-secondary': '#9c9ca6',
      '--text-muted': '#686872',
      '--accent': '#8aa4ff',
      '--accent-soft': 'rgba(138, 164, 255, 0.14)',
      '--on-accent': '#0d0f18',
      '--loss': '#f26d72',
      '--loss-soft': 'rgba(242, 109, 114, 0.14)',
      '--profit': '#4fd08d',
      '--shadow-pop': '0 12px 32px rgba(0, 0, 0, 0.6)',
    },
  },
  {
    key: 'ocean',
    label: 'Ocean',
    baseMode: 'dark',
    tokens: {
      ...ROUND,
      '--font-ui': SANS,
      '--bg-base': '#07131a',
      '--surface-1': '#0c1d27',
      '--surface-hover': '#122a37',
      '--border': '#1b3746',
      '--border-soft': '#122a37',
      '--text-primary': '#dcecf3',
      '--text-secondary': '#8eb0c0',
      '--text-muted': '#5b8094',
      '--accent': '#2dd4bf',
      '--accent-soft': 'rgba(45, 212, 191, 0.14)',
      '--on-accent': '#04231f',
      '--loss': '#fb7185',
      '--loss-soft': 'rgba(251, 113, 133, 0.14)',
      '--profit': '#34d399',
      '--shadow-pop': '0 12px 32px rgba(0, 0, 0, 0.55)',
    },
  },
  {
    key: 'terminal',
    label: 'Terminal',
    baseMode: 'dark',
    tokens: {
      '--r-sm': '2px',
      '--r-md': '2px',
      '--r-lg': '3px',
      '--font-ui': MONO,
      '--bg-base': '#050505',
      '--surface-1': '#0d0d0d',
      '--surface-hover': '#1a1a1a',
      '--border': '#2a2a2a',
      '--border-soft': '#171717',
      '--text-primary': '#eaeaea',
      '--text-secondary': '#9a9a9a',
      '--text-muted': '#636363',
      '--accent': '#ffffff',
      '--accent-soft': 'rgba(255, 255, 255, 0.14)',
      '--on-accent': '#0a0a0a',
      '--loss': '#ff5c5c',
      '--loss-soft': 'rgba(255, 92, 92, 0.14)',
      '--profit': '#3ddc84',
      '--shadow-pop': '0 8px 24px rgba(0, 0, 0, 0.7)',
    },
  },
];

export function getTheme(key: string): ThemeDefinition {
  return THEMES.find((t) => t.key === key) ?? THEMES[0];
}

/** The theme to start in when nothing has been saved yet: follow the OS. */
export function defaultThemeKey(prefersDark: boolean): string {
  return prefersDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}
