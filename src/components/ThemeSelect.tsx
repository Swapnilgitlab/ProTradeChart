import { THEMES } from '../theme/themes';
import { useTheme } from '../theme/ThemeProvider';

/** A flat dropdown over every registered theme. */
export function ThemeSelect() {
  const { theme, setTheme } = useTheme();

  return (
    <select className="theme-select" value={theme.key} onChange={(e) => setTheme(e.currentTarget.value)} aria-label="Theme" title="Theme">
      {THEMES.map((t) => (
        <option key={t.key} value={t.key}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
