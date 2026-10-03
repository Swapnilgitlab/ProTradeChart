import { useEffect, useState } from 'react';
import {
  AppWindow,
  Bell,
  Check,
  CircleHelp,
  Code,
  Compass,
  Database,
  Download,
  FlaskConical,
  Info,
  Keyboard,
  KeyRound,
  LayoutTemplate,
  List,
  ListFilter,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  SquareTerminal,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { ThemeSelect } from '../../components/ThemeSelect';
import { listDatasets, marketDataStatus, pythonEnvStatus, type AiProviders } from '../../lib/ipc';
import { isDownloaded } from '../../lib/marketData';
import { useProviderState } from '../providers/useProviderState';
import type { LayoutSummary } from '../layouts/LayoutMenu';

/** A card worth marking done/pending is a first-time setup step with a real finished state;
 *  an ongoing action (importing another file, opening a tool) has none and stays unmarked. */
type CardStatus = 'done' | 'pending';

interface HomeCard {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  status?: CardStatus;
}

interface Props {
  layouts: LayoutSummary[];
  /** `null` while loading, so setup status isn't guessed as "pending" a moment too early. */
  aiProviders: AiProviders | null;
  onNewChart: () => void;
  onNewWindow: () => void;
  onOpenLayout: (id: string) => void;
  onOpenWatchlist: () => void;
  onOpenAlerts: () => void;
  onOpenAskAi: () => void;
  onOpenScriptEditor: () => void;
  onOpenPython: () => void;
  onOpenPythonSetup: () => void;
  onOpenStudies: () => void;
  onOpenScreener: () => void;
  onOpenDataProviders: () => void;
  onOpenAiProviders: () => void;
  onOpenImportData: () => void;
  onOpenAbout: () => void;
  onOpenHelp: (topicId?: string) => void;
}

function StatusBadge({ status }: { status: CardStatus }) {
  return (
    <span className={`home-card-status ${status}`}>
      {status === 'done' ? (
        <>
          <Check size={11} aria-hidden="true" /> Done
        </>
      ) : (
        'Pending'
      )}
    </span>
  );
}

function Card({ icon: Icon, title, description, onClick, status }: HomeCard) {
  return (
    <button type="button" className={`home-card${status ? ` home-card-${status}` : ''}`} onClick={onClick}>
      {status && <StatusBadge status={status} />}
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
 *  Every card just does what its rail or tab-bar equivalent does. The one thing it does hold is the
 *  Setup section's done/pending status — read fresh here (not from `Workspace.tsx`, since Home may
 *  be the first thing opened, before Python or a broker dialog has ever loaded anything). */
export function HomePage({
  layouts,
  aiProviders,
  onNewChart,
  onNewWindow,
  onOpenLayout,
  onOpenWatchlist,
  onOpenAlerts,
  onOpenAskAi,
  onOpenScriptEditor,
  onOpenPython,
  onOpenPythonSetup,
  onOpenStudies,
  onOpenScreener,
  onOpenDataProviders,
  onOpenAiProviders,
  onOpenImportData,
  onOpenAbout,
  onOpenHelp,
}: Props) {
  const providerState = useProviderState();
  const brokerConnected = providerState.providers.some((p) => p.id === 'zerodha' && p.enabled && p.configured);
  const aiConnected = aiProviders?.active != null;

  const [datasetCount, setDatasetCount] = useState<number | null>(null);
  const [pythonReady, setPythonReady] = useState<boolean | null>(null);
  const [historyDownloaded, setHistoryDownloaded] = useState<boolean | null>(null);
  useEffect(() => {
    listDatasets()
      .then((rows) => setDatasetCount(rows.length))
      .catch(() => setDatasetCount(null));
    pythonEnvStatus()
      .then((s) => setPythonReady(s.state === 'ready'))
      .catch(() => setPythonReady(null));
    marketDataStatus()
      .then((s) => setHistoryDownloaded(isDownloaded(s)))
      .catch(() => setHistoryDownloaded(null));
  }, []);
  // `undefined` while still loading: no card is marked pending on a guess before its answer is in.
  const statusOf = (known: boolean | null): CardStatus | undefined => (known == null ? undefined : known ? 'done' : 'pending');

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
          <div className="home-grid">
            {layouts.map((l) => (
              <button key={l.id} type="button" className="home-card" onClick={() => onOpenLayout(l.id)}>
                <LayoutTemplate size={18} aria-hidden="true" />
                <span className="home-card-title">
                  {l.name}
                  {l.isDefault && <Star size={12} className="default-star" aria-label="Default layout" />}
                </span>
                <span className="home-card-description">{l.isDefault ? 'Default layout — opens at launch.' : 'Open this saved layout.'}</span>
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
          { icon: Code, title: 'Script Editor', description: 'Write Pine Script indicators and strategies, and backtest them (Ctrl+E).', onClick: onOpenScriptEditor },
          { icon: SquareTerminal, title: 'Python', description: "Screen and backtest with your broker's data (Ctrl+Shift+Y).", onClick: onOpenPython },
          { icon: FlaskConical, title: 'Studies', description: 'What stocks looked like around historical events.', onClick: onOpenStudies },
          { icon: ListFilter, title: 'Screener', description: 'Which stocks match your conditions today.', onClick: onOpenScreener },
        ]}
      />

      <Section
        title="Setup"
        cards={[
          {
            icon: Plug,
            title: 'Data providers',
            description: brokerConnected ? 'Where prices come from: crypto or Zerodha.' : 'Crypto works already. Connect Zerodha for NSE, BSE, F&O and commodities.',
            onClick: onOpenDataProviders,
            status: statusOf(brokerConnected),
          },
          {
            icon: KeyRound,
            title: 'AI providers',
            description: 'API keys for Claude and GPT, and which one to use.',
            onClick: onOpenAiProviders,
            status: statusOf(aiConnected),
          },
          {
            icon: Database,
            title: 'Import data',
            description: 'Chart your own data from a CSV file.',
            onClick: onOpenImportData,
            status: datasetCount == null ? undefined : statusOf(datasetCount > 0),
          },
          {
            icon: Settings2,
            title: 'Python setup',
            description: 'Which Python runs your scripts, and where its data is kept.',
            onClick: onOpenPythonSetup,
            status: statusOf(pythonReady),
          },
          {
            icon: Download,
            title: 'Market data',
            description: 'Download five years of daily prices for every NSE stock once, so the Screener, Studies and Python read them from disk.',
            onClick: onOpenDataProviders,
            status: statusOf(historyDownloaded),
          },
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
