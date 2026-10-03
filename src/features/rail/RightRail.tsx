import type { LucideIcon } from 'lucide-react';
import type { RailPanelId } from './railPanel';

/** A button that shows a panel beside the chart. */
export interface RailPanelButton {
  id: RailPanelId;
  label: string;
  /** Shown in the tooltip, e.g. `Alt+W`. */
  shortcut?: string;
  icon: LucideIcon;
  /** A count worth noticing (alerts that fired while you weren't looking). */
  badge?: number;
}

/** A button that does something — opens a tab, a dock or a dialog — rather than showing a side panel. */
export interface RailAction {
  id: string;
  label: string;
  /** The tooltip, when it should say more than the label. */
  title?: string;
  icon: LucideIcon;
  onClick: () => void;
  /** Set for something that is either showing or not (the Script Editor, the Python tab): the button is lit
   *  while it shows. Left out for a button that only opens something (a dialog). */
  pressed?: boolean;
  /** A small dot in the corner — something worth noticing (an update is ready), not a count. */
  dot?: boolean;
}

interface Props {
  panels: readonly RailPanelButton[];
  /** The panel showing now, if any. */
  activePanel: RailPanelId | null;
  /** A panel button was pressed: show its panel, or hide it when it is the one showing. */
  onTogglePanel: (id: RailPanelId) => void;
  /** Buttons for the tools that live outside the side panels, under the panels. */
  tools?: readonly RailAction[];
  /** Buttons pinned to the bottom of the rail. */
  footer?: readonly RailAction[];
}

interface IconButtonProps {
  label: string;
  title: string;
  icon: LucideIcon;
  badge?: number;
  dot?: boolean;
  /** Lit, and announced as pressed. `undefined` means the button isn't a toggle. */
  pressed?: boolean;
  onClick: () => void;
}

function RailIconButton({ label, title, icon: Icon, badge, dot, pressed, onClick }: IconButtonProps) {
  return (
    <button type="button" className={`rail-button${pressed ? ' active' : ''}`} aria-label={label} aria-pressed={pressed} title={title} onClick={onClick}>
      <Icon size={18} />
      {badge != null && badge > 0 && <span className="icon-badge">{badge > 9 ? '9+' : badge}</span>}
      {dot && <span className="update-dot" aria-hidden="true" />}
    </button>
  );
}

/** A slim strip of icons down the right edge of the window. It is always there.
 *
 *  At the top, one button per side panel: the panel it opens sits between the rail and the chart, and pressing
 *  the same icon again folds it away. Below them, the tools that open elsewhere (the Script Editor, the Python
 *  tab); and at the bottom, the settings-like ones (where prices come from). */
export function RightRail({ panels, activePanel, onTogglePanel, tools = [], footer = [] }: Props) {
  const action = (a: RailAction) => (
    <RailIconButton key={a.id} label={a.label} title={a.title ?? a.label} icon={a.icon} pressed={a.pressed} dot={a.dot} onClick={a.onClick} />
  );
  return (
    <nav className="right-rail" aria-label="Side panels and tools">
      {panels.map(({ id, label, shortcut, icon, badge }) => (
        <RailIconButton
          key={id}
          label={label}
          title={shortcut ? `${label} (${shortcut})` : label}
          icon={icon}
          badge={badge}
          pressed={activePanel === id}
          onClick={() => onTogglePanel(id)}
        />
      ))}
      {tools.length > 0 && <span className="rail-divider" role="separator" />}
      {tools.map(action)}
      <span className="rail-spacer" />
      {footer.map(action)}
    </nav>
  );
}
