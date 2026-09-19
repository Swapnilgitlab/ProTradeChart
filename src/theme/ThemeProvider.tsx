import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getPreference, setPreference } from '../lib/ipc';
import { defaultThemeKey, getTheme, type ThemeDefinition } from './themes';

const PREF_KEY = 'theme';

interface ThemeContextValue {
  theme: ThemeDefinition;
  setTheme: (key: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Every token is applied on every switch — including back to a previous
 *  theme — so no stale inline value from an earlier theme can linger. */
function applyTheme(theme: ThemeDefinition) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.key);
  root.style.colorScheme = theme.baseMode;
  for (const [prop, value] of Object.entries(theme.tokens)) root.style.setProperty(prop, value);
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeKey, setThemeKey] = useState<string | null>(null);

  // Nothing renders until the saved theme is known, so the window never
  // flashes the wrong colours first.
  useEffect(() => {
    let cancelled = false;
    getPreference(PREF_KEY)
      .then((stored) => !cancelled && setThemeKey(stored ?? defaultThemeKey(prefersDark())))
      .catch(() => !cancelled && setThemeKey(defaultThemeKey(prefersDark())));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (themeKey) applyTheme(getTheme(themeKey));
  }, [themeKey]);

  if (!themeKey) return null;

  function setTheme(key: string) {
    setThemeKey(key);
    setPreference(PREF_KEY, key).catch(() => {});
  }

  return <ThemeContext.Provider value={{ theme: getTheme(themeKey), setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
