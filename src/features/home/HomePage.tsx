import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  Bell,
  CircleHelp,
  Compass,
  Database,
  FlaskConical,
  Info,
  Keyboard,
  KeyRound,
  List,
  ListFilter,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  Star,
} from 'lucide-react';
import { ThemeSelect } from '../../components/ThemeSelect';
import type { LayoutSummary } from '../layouts/LayoutMenu';

interface HomeCard {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}

interface Props {
  layouts: LayoutSummary[];
  onNewChart: () => void;
  onNewWindow: () => void;
  onOpenLayout: (id: string) => void;
  onOpenWatchlist: () => void;
  onOpenAlerts: () => void;
  onOpenAskAi: () => void;
  onOpenPython: () => void;
  onOpenStudies: () => void;
  onOpenScreener: () => void;
  onOpenDataProviders: () => void;
  onOpenAiProviders: () => void;
  onOpenImportData: () => void;
  onOpenAbout: () => void;
  onOpenHelp: (topicId?: string) => void;
}

function Card({ icon: Icon, title, description, onClick }: HomeCard) {
  return (
    <button type="button" className="home-card" onClick={onClick}>
      <Icon size={18} aria-hidden="true" />
      <span className="home-card-title">{title}</span>
      <span className="home-card-description">{description}</span>
    </button>
  );
}

function Section({ title, cards }: { title: string; cards: HomeCard[] }) {
  return (
    <section className="home-section">
      <h2>{title}</h2>
      <div className="home-grid">
        {cards.map((c) => (
          <Card key={c.title} {...c} />
        ))}
      </div>
    </section>
  );
}

/** The Home tab: an overview of the whole application, one click away from every other part of it —
 *  starting a chart, the research tools, connecting data, configuring the app, and About and Help.
 *  Nothing here holds state of its own; every card just does what its rail or tab-bar equivalent does. */
export function HomePage({
  layouts,
  onNewChart,
  onNewWindow,
  onOpenLayout,
  onOpenWatchlist,
  onOpenAlerts,
  onOpenAskAi,
  onOpenPython,
  onOpenStudies,
  onOpenScreener,
  onOpenDataProviders,
  onOpenAiProviders,
  onOpenImportData,
  onOpenAbout,
  onOpenHelp,
}: Props) {
  return (
    <div className="home-page">
      <div className="home-hero">
        <img src="/favicon-128.png" alt="" />
        <div>
          <h1>ProTradeChart</h1>
          <p className="muted">Free, open-source desktop charting and research.</p>
        </div>
      </div>

      <Section
        title="Charts"
        cards={[
          { icon: Plus, title: 'New chart tab', description: 'Start a chart on a fresh tab (Ctrl+T).', onClick: onNewChart },
          { icon: AppWindow, title: 'New window', description: 'Open another window (Ctrl+Shift+N).', onClick: onNewWindow },
        ]}
      />
      <section className="home-section">
        <h2>Your layouts</h2>
        {layouts.length === 0 ? (
          <p className="muted small">No saved layouts yet — save your first one from the Layout menu in the tab bar.</p>
        ) : (
          <div className="home-layouts">
            {layouts.map((l) => (
              <button key={l.id} type="button" className="home-layout-row" onClick={() => onOpenLayout(l.id)}>
                {l.isDefault && <Star size={12} className="default-star" aria-label="Default layout" />}
                <span className="grow">{l.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <Section
        title="Watchlists and alerts"
        cards={[
          { icon: List, title: 'Watchlist', description: 'Show the watchlist panel (Alt+W).', onClick: onOpenWatchlist },
          { icon: Bell, title: 'Price alerts', description: 'See and manage your price alerts.', onClick: onOpenAlerts },
        ]}
      />

      <Section
        title="Research"
        cards={[
          { icon: Sparkles, title: 'Ask AI', description: 'Ask questions and approve actions on the active chart.', onClick: onOpenAskAi },
          { icon: SquareTerminal, title: 'Python', description: "Screen and backtest with your broker's data (Ctrl+Shift+Y).", onClick: onOpenPython },
          { icon: FlaskConical, title: 'Studies', description: 'What stocks looked like around historical events.', onClick: onOpenStudies },
          { icon: ListFilter, title: 'Screener', description: 'Which stocks match your conditions today.', onClick: onOpenScreener },
        ]}
      />

      <Section
        title="Setup"
        cards={[
          { icon: Plug, title: 'Data providers', description: 'Where prices come from: crypto, Zerodha or Dhan.', onClick: onOpenDataProviders },
          { icon: KeyRound, title: 'AI providers', description: 'API keys for Claude and GPT, and which one to use.', onClick: onOpenAiProviders },
          { icon: Database, title: 'Import data', description: 'Chart your own data from a CSV file.', onClick: onOpenImportData },
        ]}
      />

      <section className="home-section">
        <h2>Config</h2>
        <div className="home-grid">
          <div className="home-card home-card-control">
            <span className="home-card-title">Theme</span>
            <span className="home-card-description">Light or dark, for every window.</span>
            <ThemeSelect />
          </div>
          <Card icon={Keyboard} title="Keyboard shortcuts" description="Every shortcut the app understands." onClick={() => onOpenHelp('shortcuts')} />
          <Card icon={RefreshCw} title="Updates" description="Your version, and whether a new one is ready." onClick={onOpenAbout} />
        </div>
      </section>

      <Section title="About" cards={[{ icon: Info, title: 'About ProTradeChart', description: 'Version, licence, source code and credits.', onClick: onOpenAbout }]} />

      <Section
        title="Help"
        cards={[
          { icon: CircleHelp, title: 'Help Center', description: 'How every part of the app works (F1).', onClick: () => onOpenHelp() },
          { icon: Compass, title: 'Getting started', description: 'A short walk-through for a first chart.', onClick: () => onOpenHelp('first-steps') },
        ]}
      />
    </div>
  );
}
