/** The Help Center's content: one topic per area of the app, as data. It is drawn as text by
 *  `features/help/HelpDialog.tsx` — never as HTML — with two marks inside a paragraph: `**bold**`
 *  for the names of buttons, menus and fields, and `` `code` `` for keys, symbols and code.
 *
 *  When a feature changes, change its topic here. `topics.test.ts` checks the structure (unique ids,
 *  related topics that exist) and that the keyboard shortcuts match the app's. Pure. */

import { FAMILY_MEANING, PLAIN_MEANING } from '../studies/assistant';
import { FAMILIES, PLAIN, featureLabel } from '../studies/metrics';

export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: [string, string]; rows: [string, string][] }
  | { kind: 'note'; text: string }
  | { kind: 'code'; text: string };

export interface HelpSection {
  heading: string;
  blocks: HelpBlock[];
}

export const HELP_GROUPS = ['Getting started', 'Charts', 'Watchlists and alerts', 'Research', 'Data and settings', 'Reference'] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

export interface HelpTopic {
  id: string;
  title: string;
  group: HelpGroup;
  /** One sentence: what the topic covers. Shown under the title and in search results. */
  summary: string;
  sections: HelpSection[];
  /** Other topics worth reading next, by id. */
  related?: string[];
}

const p = (text: string): HelpBlock => ({ kind: 'p', text });
const steps = (...items: string[]): HelpBlock => ({ kind: 'steps', items });
const list = (...items: string[]): HelpBlock => ({ kind: 'list', items });
const note = (text: string): HelpBlock => ({ kind: 'note', text });
const table = (head: [string, string], rows: [string, string][]): HelpBlock => ({ kind: 'table', head, rows });
const code = (text: string): HelpBlock => ({ kind: 'code', text });

/** The app's keyboard shortcuts. The About dialog lists these too. */
export const SHORTCUTS: [string, string][] = [
  ['F1', 'Open this Help Center'],
  ['Ctrl + T', 'New chart tab'],
  ['Ctrl + W', 'Close the current tab'],
  ['Ctrl + PageUp / PageDown', 'Previous / next tab'],
  ['Ctrl + K', 'Search for a symbol'],
  ['Ctrl + E', 'Open the Script Editor tab'],
  ['Ctrl + Shift + E', 'Show or hide the Strategy Tester under the chart'],
  ['Ctrl + Shift + Y', 'Open the Python tab'],
  ['Ctrl + Shift + N', 'New window'],
  ['Alt + W', 'Show or hide the watchlist panel'],
  ['Alt + A', 'New price alert for the chart'],
  ['↑ / ↓ (in the watchlist)', 'Step through symbols'],
  ['Right-click (in the watchlist)', 'Flag a symbol, add an alert, open it in a new tab, add a section'],
  ['Drag (in the watchlist)', 'Reorder symbols and sections'],
  ['? (on a chart)', "Vela's own shortcut list"],
];

/** Shortcuts that work inside one editor or panel. */
const EDITOR_SHORTCUTS: [string, string][] = [
  ['Ctrl + S (Script Editor, Python)', 'Save the script'],
  ['Ctrl + Enter (Script Editor)', 'Add the script to the chart, or apply your edits to it'],
  ['Ctrl + Enter (Python)', 'Run the script'],
  ['Ctrl + Enter (Ask AI)', 'Send your question'],
  ['Enter (search box)', 'Open the highlighted symbol'],
  ['Escape', 'Close a dialog or menu'],
];

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const indicatorRows = (): [string, string][] => [
  ...PLAIN.map((name): [string, string] => [`\`${name}\` — ${featureLabel(name)}`, sentence(PLAIN_MEANING[name])]),
  ...FAMILIES.map((family): [string, string] => [`\`${family}_N\``, sentence(FAMILY_MEANING[family])]),
];

export const HELP_TOPICS: HelpTopic[] = [
  // ---- Getting started --------------------------------------------------------------------------
  {
    id: 'welcome',
    title: 'Welcome to ProTradeChart',
    group: 'Getting started',
    summary: 'What the application does, and how its window is organised.',
    sections: [
      {
        heading: 'What ProTradeChart is',
        blocks: [
          p(
            'ProTradeChart is a free, open-source desktop application for charting and researching financial markets. It draws fast candlestick charts with indicators and drawing tools, keeps live watchlists and price alerts, runs Pine Script®-compatible indicators and strategy backtests, and offers research tools — a Screener, Python scripting and historical Studies — for Indian equities through your own broker account.',
          ),
          p(
            'The application itself needs no account or subscription of its own. Indian equities, indices, futures and commodities are available once you connect your own **Zerodha** account (which needs its own paid Kite Connect subscription), and you can chart any data of your own, free, by importing a CSV file.',
          ),
          note('ProTradeChart is for information and research only. Nothing in it is financial advice, and it never places orders.'),
        ],
      },
      {
        heading: 'The main window',
        blocks: [
          table(
            ['Area', 'What it holds'],
            [
              ['Tab bar (top)', 'The window’s title bar and its tabs in one: the application’s logo at the left (drag it, or the space beside the tabs, to move the window; double-click either to maximize or restore), then one tab per chart, each showing its symbol, live price and the day’s change, the Python, Studies, Screener and Home workspaces when open, and the **+** button for a new tab.'],
              ['Tab bar actions (top right)', 'The **Layout** menu, the symbol search box, the theme selector, and the window’s minimize, maximize and close.'],
              ['Chart area (centre)', 'The chart, or a grid of up to sixteen charts, with Vela’s toolbar for timeframe, chart type, indicators and drawings.'],
              ['Side panel (right)', 'The watchlist, the price alerts list or the Ask AI assistant — one at a time.'],
              ['Right rail (far right)', 'Icons that switch the side panel and open the tools described below, and further down, **Import data**, **New window**, **Data providers**, **AI providers**, **Help** and **About**.'],
            ],
          ),
        ],
      },
      {
        heading: 'The right rail',
        blocks: [
          p('The strip of icons down the right edge of the window gives you one-click access to every part of the application.'),
          table(
            ['Icon', 'What it does'],
            [
              ['**Watchlist**', 'Shows or hides the watchlist panel (`Alt+W`).'],
              ['**Price alerts**', 'Shows the list of alerts. A badge counts alerts that fired since you last looked.'],
              ['**Ask AI**', 'Opens the AI assistant, which answers questions and proposes actions you approve.'],
              ['**Home** (house)', 'Opens the Home tab, an overview of the application linking to everything else in it.'],
              ['**Script Editor**', 'Opens the Pine Script editor in a tab of its own (`Ctrl+E`).'],
              ['**Strategy Tester**', 'Shows or hides a strategy’s backtest under the chart (`Ctrl+Shift+E`).'],
              ['**Python**', 'Opens the Python workspace (`Ctrl+Shift+Y`).'],
              ['**Studies**', 'Opens the Studies workspace for historical research.'],
              ['**Screener**', 'Opens the Screener workspace.'],
              ['**Import data** (database)', 'Chart your own data from a CSV file.'],
              ['**New window**', 'Opens another window (`Ctrl+Shift+N`).'],
              ['**Data providers** (plug)', 'Chooses and configures where prices come from.'],
              ['**AI providers** (key)', 'Holds the API keys for Claude or GPT.'],
              ['**Help**', 'Opens this Help Center (`F1`).'],
              ['**About** (info)', 'Version, licence, source code, credits and the keyboard shortcuts. A dot means an update is ready.'],
            ],
          ),
          p('Pressing the icon of the panel that is showing folds it away, giving the chart the full width. The application remembers your choice.'),
          p('To make the side panel wider or narrower, drag its left edge. Double-click the edge to return to the standard width. The width is remembered.'),
        ],
      },
      {
        heading: 'Where your data is kept',
        blocks: [
          p(
            'Everything you create — layouts, watchlists, alerts, scripts, Studies, screens and imported data — is stored in a single database file on your computer. Its location is shown under **About → Your data**. Broker credentials and AI keys are kept separately, in your operating system’s secure credential store. See **Privacy and security** for details.',
          ),
        ],
      },
    ],
    related: ['home', 'first-steps', 'symbols', 'privacy'],
  },
  {
    id: 'home',
    title: 'The Home tab',
    group: 'Getting started',
    summary: 'A landing page linking to every part of the application, one click away.',
    sections: [
      {
        heading: 'Opening it',
        blocks: [
          p(
            'Click the **Home** icon (a house) in the right rail, above the Script Editor, to open the Home tab. Like the Python, Studies and Screener tabs, at most one is open at a time; clicking the icon again just shows it.',
          ),
        ],
      },
      {
        heading: 'What it holds',
        blocks: [
          list(
            '**Charts** — start a new chart tab or window, and open any of your saved layouts with one click.',
            '**Watchlists and alerts** — show the watchlist panel or the price alerts list.',
            '**Research** — Ask AI, Python, Studies and the Screener.',
            '**Setup** — Data providers, AI providers, importing your own data, Python setup, and **Market data** (five years of every NSE stock’s daily prices on this computer). Each shows **Done** once it is, or a highlighted **Pending** while it isn’t.',
            '**Config** — the theme, the keyboard shortcut list and where to check for updates.',
            '**About** and **Help** — the same dialogs the right rail opens.',
          ),
          p('Every card does exactly what its equivalent button elsewhere in the application does.'),
        ],
      },
    ],
    related: ['welcome', 'first-steps', 'layouts'],
  },
  {
    id: 'first-steps',
    title: 'First steps',
    group: 'Getting started',
    summary: 'A short walk-through: load a symbol, change the view, and save your workspace.',
    sections: [
      {
        heading: 'Load your first chart',
        blocks: [
          steps(
            'Click the search box at the top of the window, or press `Ctrl+K`.',
            'Type a symbol, for example `BTCUSDT`, and choose it from the list with the mouse or the arrow keys and `Enter`.',
            'The active chart switches to that symbol. Use the chart’s own toolbar to change the timeframe (for example 1D or 15m) and the chart type.',
          ),
          p('Scroll back or zoom out on the chart and older candles load automatically for as long as the data source has them.'),
        ],
      },
      {
        heading: 'Add indicators and drawings',
        blocks: [
          p(
            'Open **Indicators** in the chart toolbar to add any of the 70+ built-in studies — moving averages, RSI, MACD, Bollinger Bands and many more. Vela’s drawing tools add lines, shapes, text annotations and more. Press `?` on a chart to see Vela’s full list of chart shortcuts.',
          ),
        ],
      },
      {
        heading: 'Connect Indian market data (optional)',
        blocks: [
          p(
            'To chart NSE, BSE, NFO or MCX instruments, and to use the Screener, Python and Studies, connect a broker account you already have: open **Data providers** from the plug icon at the bottom of the right rail and follow **Connecting Zerodha**.',
          ),
        ],
      },
      {
        heading: 'Save your workspace',
        blocks: [
          steps(
            'Open more tabs with `Ctrl+T`, and arrange each chart as you like.',
            'Open the **Layout** menu in the tab bar and choose **Save as new layout…**.',
            'Choose **Set as default** in the same menu to open this layout every time the application starts.',
          ),
        ],
      },
    ],
    related: ['charts', 'layouts', 'data-providers'],
  },
  {
    id: 'symbols',
    title: 'Symbols and searching',
    group: 'Getting started',
    summary: 'How symbols are written, how search works, and what the default data source means.',
    sections: [
      {
        heading: 'How a symbol is written',
        blocks: [
          p(
            'Every symbol names its data source and its ticker, separated by a colon: `provider:TICKER`. Broker symbols also name their exchange. The application shows symbols in their short form — `RELIANCE` rather than `zerodha:NSE:RELIANCE` — and hides `NSE` because it is the default exchange; other exchanges stay visible, because `BSE:RELIANCE` is a different instrument.',
          ),
          table(
            ['Source', 'Examples'],
            [
              ['Zerodha', '`zerodha:NSE:RELIANCE`, `zerodha:NSE:NIFTY_50`, `zerodha:BSE:TCS`'],
              ['Imported data', '`csv:MY_DATA`'],
            ],
          ),
        ],
      },
      {
        heading: 'Searching',
        blocks: [
          list(
            'Press `Ctrl+K` or click the search box, then type part of a ticker or a company name.',
            'Results come from every data source that is switched on, grouped by source.',
            'A ticker typed without a source uses the **default provider**, Zerodha, so typing `RELIANCE` opens the NSE listing (another default can be chosen in **Data providers** → **Make default**, once more than one source is set up).',
            'Options contracts are not listed (there are too many to search usefully); futures are.',
          ),
        ],
      },
      {
        heading: 'Symbols that can no longer load',
        blocks: [
          p(
            'Binance, Coinbase and Hyperliquid were removed as data sources. Symbols saved from them (`binance:…`, `coinbase:…`, `hyperliquid:…`) stay in your watchlists, layouts and alerts but cannot be loaded. Opening a layout that contains one moves that chart to a working symbol and tells you; saving the layout again removes the old symbol. To chart crypto, US or other world markets, import your own data file.',
          ),
        ],
      },
    ],
    related: ['data-providers', 'import-csv'],
  },

  // ---- Charts -----------------------------------------------------------------------------------
  {
    id: 'charts',
    title: 'Working with charts',
    group: 'Charts',
    summary: 'Timeframes, chart types, indicators, drawings and how history is loaded.',
    sections: [
      {
        heading: 'The chart toolbar',
        blocks: [
          p(
            'Charts are drawn by Vela. The toolbar across the top of each chart controls the symbol, the timeframe (from one minute to monthly), the chart type (candles, bars, line, area, baseline and Heikin Ashi), indicators, the grid layout and chart settings, and the drawing tools add lines, shapes and text annotations. Press `?` on a chart for Vela’s own keyboard shortcuts.',
          ),
        ],
      },
      {
        heading: 'Indicators',
        blocks: [
          list(
            '**Built-in indicators.** Open **Indicators** and choose from more than seventy. Each indicator’s legend row lets you open its settings, hide it or remove it.',
            '**Bundled scripts.** Pine scripts that ship with the application appear in the Indicators dialog, grouped by folder (for example **Trend → Moving average ribbon**).',
            '**Your own scripts.** Write or paste a Pine Script in the Script Editor and add it to the chart. See **Script Editor (Pine Script)**.',
          ),
        ],
      },
      {
        heading: 'Drawings belong to the symbol',
        blocks: [
          p(
            'Drawings are kept with the symbol they were drawn on. A trend line drawn on RELIANCE appears on every chart of RELIANCE — in any tab, window or layout, and at every timeframe — and disappears when a chart switches to another symbol. Switch back and it returns. A change made on one chart of a symbol appears on its other charts.',
          ),
          list(
            'Drawings are saved automatically a moment after each change.',
            'Removing every drawing from a symbol leaves it clear; it stays clear when a layout is reopened.',
            'Drawings saved in layouts before this behaviour was introduced are taken over by their symbol the first time the layout is opened.',
            'Vela’s **Sync drawings on all charts** switch in the drawing toolbar additionally mirrors drawings across the charts of a grid while you draw.',
          ),
        ],
      },
      {
        heading: 'History',
        blocks: [
          p(
            'A chart opens with about 500 bars — roughly two years of daily candles. As you scroll or zoom towards the oldest bar, the application loads older history in the background, for as long as the source has any. There is nothing to click. Broker bars you have loaded are kept in a small local cache so that a chart can still be drawn when you are offline.',
          ),
        ],
      },
      {
        heading: 'Time and prices',
        blocks: [
          list(
            'Each chart uses your computer’s time zone. Daily, weekly and monthly bars are stamped with the exchange’s calendar date; intraday bars keep their exact time.',
            'Broker timeframes the broker does not serve directly (such as 2 hours, 4 hours, weekly and monthly) are built from finer bars, with each intraday bucket starting at the session open.',
            'Prices are shown as the data source supplies them. Broker history is adjusted for corporate actions by the broker.',
          ),
        ],
      },
      {
        heading: 'Adding the symbol to a watchlist',
        blocks: [
          p(
            'Right-click the chart and point to **Add SYMBOL to watchlist** (for example **Add RELIANCE to watchlist**). A list of your watchlists opens beside it, each with a checkbox, ticked where the list already holds the chart’s symbol. Tick a box to add the symbol to that list, or untick it to take the symbol off; the menu stays open, so you can tick several lists at once. Your quick-access watchlists are listed first. **New watchlist…** at the bottom puts the symbol on a new list. See **Watchlists**.',
          ),
        ],
      },
      {
        heading: 'Setting an alert from the chart',
        blocks: [
          p(
            'Right-click the chart and choose **Add alert here…**, or right-click the price axis and choose **Add alert at this price…**; the price under the cursor is filled in. The **Alert** button in the chart toolbar and `Alt+A` open the same form. See **Price alerts**.',
          ),
        ],
      },
    ],
    related: ['grids', 'pine', 'alerts'],
  },
  {
    id: 'grids',
    title: 'Chart grids and synchronisation',
    group: 'Charts',
    summary: 'Show up to sixteen charts in one tab and link their symbol, interval, crosshair and style.',
    sections: [
      {
        heading: 'Choosing a grid',
        blocks: [
          steps(
            'Open the **Layout** button in the chart’s own toolbar (beside the timeframe and style buttons).',
            'Choose a grid from 1×1 up to 4×4. New charts start on the tab’s current symbol.',
            'Click a chart to make it the active one; it is outlined. Searching for a symbol or clicking a watchlist row changes only the active chart, and the tab’s label follows it.',
          ),
        ],
      },
      {
        heading: 'Synchronising charts',
        blocks: [
          p(
            'The sync switches in the same dropdown link the charts of the grid: **symbol** (every chart follows the active one), **interval**, **crosshair** (the crosshair moves across all charts together) and **style**. A common arrangement is one symbol at four timeframes, with symbol and crosshair linked.',
          ),
          note('A grid is saved with the tab when you save a layout.'),
        ],
      },
    ],
    related: ['charts', 'layouts', 'tabs-windows'],
  },
  {
    id: 'tabs-windows',
    title: 'Tabs and windows',
    group: 'Charts',
    summary: 'Chart tabs, workspace tabs, live tab prices and additional windows.',
    sections: [
      {
        heading: 'Chart tabs',
        blocks: [
          list(
            '`Ctrl+T` or the **+** button opens a new chart tab. If you have a default layout, the new tab starts as a copy of its first chart — symbol, indicators, drawings and style — so the default layout doubles as a template.',
            '`Ctrl+W`, the tab’s **×** or a middle-click closes a tab. The last chart tab cannot be closed, because the watchlist, alerts, Script Editor and Strategy Tester always work with a chart.',
            '`Ctrl+PageUp` and `Ctrl+PageDown` move between tabs.',
            'Each tab shows its symbol’s latest price and the day’s change. Tabs whose chart streams live update tick by tick; the others refresh about every 20 seconds.',
            'As more tabs open they narrow to share the space: first the price is hidden, then the day’s change, then the close button on tabs you are not on (hover a tab to see it). The tab you are on always shows its name, and hovering any tab shows its full name.',
            'When even narrowed tabs do not fit, arrows appear at the ends of the tab strip to scroll it, and the mouse wheel scrolls it too. The tab you are on is always kept in view, and the **+** button stays beside the tabs.',
          ),
        ],
      },
      {
        heading: 'Workspace tabs',
        blocks: [
          p(
            'Python, Studies and the Screener open as tabs of their own beside your charts, at most one of each. They keep working while you look at a chart — a running script, Study or screen continues, and its output is there when you return. Workspace tabs are not saved in layouts, and loading a layout leaves them open.',
          ),
        ],
      },
      {
        heading: 'More windows',
        blocks: [
          p(
            '`Ctrl+Shift+N` or **New window** in the right rail opens another window, useful on a second monitor. All windows share your layouts, watchlists and alerts. Only the first (main) window checks alerts and runs background tasks, so nothing happens twice.',
          ),
        ],
      },
    ],
    related: ['layouts', 'grids'],
  },
  {
    id: 'layouts',
    title: 'Layouts',
    group: 'Charts',
    summary: 'Save and restore your whole charting session.',
    sections: [
      {
        heading: 'What a layout contains',
        blocks: [
          p(
            'A layout records every chart tab: its grid, and each chart’s symbol, timeframe, indicators (including your Pine scripts), drawings and settings, plus which tab was active. It does not record the theme, which remains your own preference — except a canvas background you chose for a chart, which the layout keeps. It does not include the Python, Studies or Screener tabs.',
          ),
        ],
      },
      {
        heading: 'Using the Layout menu',
        blocks: [
          table(
            ['Action', 'Result'],
            [
              ['**Save as new layout…**', 'Type a name and press `Enter` to save the current session as a new layout.'],
              ['**Save**', 'Overwrites the layout you are working in with the current session.'],
              ['Choose a layout', 'Replaces the chart tabs with the saved ones.'],
              ['**Set as default**', 'Opens this layout whenever the application starts, and uses its first chart as the template for new tabs.'],
              ['**Delete**', 'Removes a saved layout. Your charts stay open.'],
            ],
          ),
          note('A layout stores the script’s source with the chart, so it still opens correctly even if you later delete the script from your library.'),
        ],
      },
    ],
    related: ['tabs-windows', 'pine'],
  },
  {
    id: 'pine',
    title: 'Script Editor (Pine Script)',
    group: 'Charts',
    summary: 'Write, save and run your own Pine Script® indicators and strategies.',
    sections: [
      {
        heading: 'Opening the editor',
        blocks: [
          p(
            'Press `Ctrl+E` or the **Script Editor** icon on the right rail. The editor opens in a tab of its own, like Python: your scripts, the scripts bundled with the app and examples to start from are listed on the left, the editor and its **Console** beside them. The pencil icon on a script’s legend row opens that script’s code there.',
          ),
          p(
            'Scripts are added to the chart tab you looked at last, named on the button in the editor’s toolbar; click it to go to that chart.',
          ),
        ],
      },
      {
        heading: 'Writing and running a script',
        blocks: [
          steps(
            'Press **+ Indicator** or **+ Strategy** at the top of the list on the left to start a new script, or start from **New from an example**, reopen one of **My scripts** (its bin deletes it), or view a script **Bundled with the app**.',
            'Write or paste your script. The editor highlights Pine syntax.',
            'Press **Add to chart** (`Ctrl+Enter`). The script is added only if it compiles; errors and warnings appear in the editor’s **Console**.',
            'Edit and press `Ctrl+Enter` again to update the script on the chart in place.',
            'Press **Save** (`Ctrl+S`) to keep it in your script library.',
          ),
          p('A script’s inputs and properties can be changed from its legend row on the chart, like any built-in indicator. Scripts on a chart are saved with the layout, including any inputs you changed.'),
        ],
      },
      {
        heading: 'Indicators and strategies',
        blocks: [
          p(
            'The editor detects whether a script is an **Indicator** (`indicator(...)`) or a **Strategy** (`strategy(...)`) from its declaration. Adding a strategy opens the **Strategy Tester** under its chart.',
          ),
          note(
            'Scripts run on PineTS, an open-source Pine Script engine. Most scripts behave as they do on TradingView, but some functions and behaviours differ. Pine Script is a trademark of TradingView, Inc.; ProTradeChart is not affiliated with TradingView.',
          ),
        ],
      },
    ],
    related: ['strategy-tester', 'charts'],
  },
  {
    id: 'strategy-tester',
    title: 'Strategy Tester',
    group: 'Charts',
    summary: 'Backtest a Pine strategy against the chart’s history.',
    sections: [
      {
        heading: 'Reading a backtest',
        blocks: [
          p(
            'The Strategy Tester sits in a panel under the chart. **Strategy Tester** on the right rail (`Ctrl+Shift+E`) shows or hides it, and adding a strategy from the Script Editor opens it. When a strategy is on the active chart, it shows its equity curve, a performance summary (net profit, maximum drawdown, run-up, percent profitable, profit factor and more) and the list of trades with their entry and exit, size, signal and profit. With several strategies on the chart, choose which one to show.',
          ),
        ],
      },
      {
        heading: 'Things to know',
        blocks: [
          list(
            '**The backtest covers only the bars the chart has loaded.** To test a longer period, scroll the chart back so that more history loads; the tester updates.',
            '**Results are approximate.** PineTS simulates orders differently from TradingView in some details, and equity, run-up and drawdown are measured on bar closes.',
            '**Margin calls.** A strategy that orders 100% of its equity and also pays commission can be closed immediately by a margin call. The tester detects this and explains it; reduce the order size to fix it.',
          ),
        ],
      },
    ],
    related: ['pine'],
  },

  // ---- Watchlists and alerts --------------------------------------------------------------------
  {
    id: 'watchlists',
    title: 'Watchlists',
    group: 'Watchlists and alerts',
    summary: 'Keep lists of symbols with live prices, sections, colour flags and your own order.',
    sections: [
      {
        heading: 'Creating a list and adding symbols',
        blocks: [
          steps(
            'Show the watchlist with `Alt+W` or the **Watchlist** icon on the right rail.',
            'Use **New watchlist** to create a list, or the list selector at the top to switch between lists.',
            'Type in **Add symbol…** to search and add a symbol.',
          ),
          p('Click a row to open that symbol on the active chart. `↑` and `↓` step through the list. To add the symbol on a chart to a watchlist, right-click the chart and point to **Add SYMBOL to watchlist**.'),
        ],
      },
      {
        heading: 'Flagging a symbol',
        blocks: [
          p(
            'Each row has a flag button before its ticker. A flagged symbol shows its flag in colour; on an unflagged row the flag appears as an outline, in the colour you last used, when you point at the row.',
          ),
          list(
            '**Click** the flag of an unflagged symbol to flag it with the colour you last used (red, until you choose another).',
            '**Right-click** the flag, or click the flag of a symbol that is already flagged, to choose any colour — red, orange, yellow, green, blue or purple — or **Remove flag**. The colour you choose becomes the one a click applies next time.',
            'The same choices are in the row’s right-click menu.',
          ),
          p(
            'A flag belongs to the symbol, not to one list: a symbol flagged red is red on every watchlist it is on.',
          ),
        ],
      },
      {
        heading: 'Flagged lists',
        blocks: [
          p(
            'Each colour has a list of its own — **Red flag**, **Orange flag**, **Yellow flag**, **Green flag**, **Blue flag** and **Purple flag** — holding every symbol flagged with that colour, most recently flagged first. Open them from the **Flagged** group at the bottom of the list selector.',
          ),
          list(
            'Adding a symbol to a flagged list (with **Add symbol…**) flags it with that colour.',
            'Removing a symbol from a flagged list, or changing its colour, takes it off the list.',
            'A flagged list keeps its own order and has no sections, so it can’t be reordered, renamed or deleted.',
          ),
        ],
      },
      {
        heading: 'Quick access',
        blocks: [
          p(
            'Up to five watchlists can be starred for quick access. They appear as buttons across the top of the watchlist panel, so one click switches between them, and they are listed first when you add a symbol from a chart’s right-click menu (**Add to watchlist**).',
          ),
          list(
            'Star a list in **Browse all watchlists**, or choose **Add to quick access** in the list’s **More** (⋯) menu.',
            'Starring a sixth list is refused until one is unstarred. Deleting a starred list removes it from quick access.',
          ),
        ],
      },
      {
        heading: 'Browsing all watchlists',
        blocks: [
          p(
            'The **All watchlists** button in the panel header, or **Browse all watchlists…** at the bottom of the list selector, opens a dialog listing every watchlist with its number of symbols. From there you can search the lists, open one, star it for quick access, rename or delete it, create a new one, and create the Indices watchlist.',
          ),
        ],
      },
      {
        heading: 'The Indices watchlist',
        blocks: [
          p(
            'With Zerodha connected, **Create Indices watchlist** in the browse dialog builds a watchlist of Indian market indices from your broker’s instrument list, in three sections: **Broad market** (Nifty 50, Sensex, Nifty Next 50, the midcap and smallcap indices, India VIX and others), **Sectors** (Nifty Bank, IT, Pharma, Auto, FMCG, Metal, Realty, Energy, Healthcare and the other sector indices) and **Themes** (Defence, Infrastructure, CPSE, Consumption, EV and others). Follow a sector’s performance through its index. Indices your broker does not list are skipped.',
          ),
          note('The application has no data on which stocks belong to each sector, so it does not build sector-by-sector stock lists. You can make your own with sections, or from the Screener’s results.'),
        ],
      },
      {
        heading: 'The row menu',
        blocks: [
          p('Right-click a row for its menu:'),
          table(
            ['Item', 'What it does'],
            [
              ['**Flag**', 'Marks the symbol with a colour (red, orange, yellow, green, blue or purple), or clears the mark. The flag shows on every list the symbol is on.'],
              ['**Add alert…**', 'Opens the price alert form for that symbol.'],
              ['**Open in new tab**', 'Opens the symbol in a new chart tab.'],
              ['**Move to top**', 'Moves the symbol to the top of the list.'],
              ['**Add section above**', 'Inserts a section heading above the row.'],
              ['**Remove**', 'Removes the symbol from the list.'],
            ],
          ),
        ],
      },
      {
        heading: 'Sections, order and sorting',
        blocks: [
          list(
            '**Sections** group the symbols that follow them, up to the next section. Click a section’s name to fold or unfold it; its menu renames it or deletes it (**Delete section (keep its symbols)**).',
            '**Drag** any row, or a whole section with its symbols, to a new position.',
            '**Sort** by clicking a column heading (symbol, last price or change). While a list is sorted, sections are hidden and rows cannot be dragged; click the heading again to return to your own order.',
          ),
        ],
      },
      {
        heading: 'The list menu',
        blocks: [
          p('The **More** (⋯) menu beside the list selector renames or deletes the list, adds a section, adds it to or removes it from quick access, and imports symbols.'),
          list(
            '**Import from file…** reads a TradingView watchlist export or a CSV file with a `Symbol` column. Crypto exchanges are mapped automatically, NSE and BSE symbols are mapped when a broker is set up, and anything that cannot be mapped is reported.',
            'Lists can also be filled from the Screener, from a Python script’s results, from a Study’s results, or kept up to date by a scheduled script (see **Scheduled scripts**).',
          ),
        ],
      },
    ],
    related: ['alerts', 'screener', 'schedules'],
  },
  {
    id: 'alerts',
    title: 'Price alerts',
    group: 'Watchlists and alerts',
    summary: 'Be notified when a price crosses a level you choose.',
    sections: [
      {
        heading: 'Creating an alert',
        blocks: [
          list(
            'On a chart: right-click and choose **Add alert here…**, or right-click the price axis and choose **Add alert at this price…**.',
            'From the chart toolbar’s **Alert** button, or press `Alt+A`.',
            'From a watchlist row’s menu (**Add alert…**), or the **New alert** button in the Alerts panel.',
          ),
          p('The form asks for:'),
          table(
            ['Field', 'Meaning'],
            [
              ['**Alert me when the price is**', '**Crossing up** (rising through the level), **Crossing down** (falling through it) or **Crossing** (either way). A sensible choice is suggested from where the price is now.'],
              ['**Price**', 'The level to watch.'],
              ['**How often**', '**Only once**, or **Every time it crosses** (at most once a minute).'],
              ['**Note**', 'Optional text shown when the alert fires.'],
            ],
          ),
        ],
      },
      {
        heading: 'When an alert fires',
        blocks: [
          p(
            'You receive a system notification (so it reaches you while the application is minimised), a message inside the application and a short sound. The sound can be switched off with **Play a sound** in the Alerts panel.',
          ),
        ],
      },
      {
        heading: 'Managing alerts',
        blocks: [
          p(
            'The **Price alerts** icon on the right rail shows every alert, with a badge counting those that fired since you last looked. From the list you can **Pause** and **Resume** an alert, **Edit** it, re-arm a fired alert (**Watch for it again**), **Delete** it, and click it to chart its symbol.',
          ),
        ],
      },
      {
        heading: 'How crossings are judged',
        blocks: [
          list(
            'Alerts work with every data source and are checked about every 20 seconds while the application is open. Because prices are sampled, a spike that comes and goes between two checks can be missed.',
            'A crossing is measured from the price when the alert was set. If the price was already beyond the level, the alert waits for it to come back and cross again.',
            'If the level was crossed while the application was closed, the alert fires when it next opens.',
            'Pausing, editing or re-arming an alert starts it afresh from the current price.',
          ),
        ],
      },
    ],
    related: ['watchlists', 'charts'],
  },

  // ---- Research ---------------------------------------------------------------------------------
  {
    id: 'screener',
    title: 'Screener',
    group: 'Research',
    summary: 'Find which stocks meet your conditions today, and save screens to run again.',
    sections: [
      {
        heading: 'Overview',
        blocks: [
          p(
            'The Screener lists the stocks that meet a set of conditions on their latest daily bar, with the columns you choose. Open it from the **Screener** icon on the right rail. It uses the same indicators as Studies, so its numbers match a Study’s.',
          ),
          note('The Screener needs Python (set up once in the Python tab) and a connected Zerodha account.'),
          p('The collapse icon above **My screens** tucks the saved-screens list away to a thin strip, for more room; click it again to bring the list back.'),
        ],
      },
      {
        heading: 'Building a screen',
        blocks: [
          steps(
            'Start from a preset on the left (for example **Near 52-week high** or **Volume spike**), or press **New screen**.',
            'Under **Filters**, press **+** and pick a filter from the list — grouped into Price (price, **Price change**, **Change %**, **Gap %**, **Gap up %**, **Gap down %**, 52-week high and low), Volume (volume, **Relative volume**, average volume, **Average traded value**), Moving averages, Oscillators, Performance and Volatility — or type to search it. It is added as a chip such as `Chg > 2%` or `Price ≥ EMA, 50`; the chip’s own **×** removes it.',
            'Click a chip to open its editor. Under the title, choose the length (14, 50, 200…) or period (1 day, 3 months…) and the interval: **1 day**, **1 week** or **1 month** (weekly and monthly bars are built from the daily ones; a week ends on Friday). Then pick the condition — **Above**, **Above or equal**, **Below**, **Below or equal**, **Crosses above**, **Crosses below**, **Between** or **Outside** — and a value, a range, or another indicator or price (with its own length and interval). A stock matches when every filter holds on its latest bar; **Crosses above** and **crosses below** mean the cross happened on that bar — or, for a weekly or monthly filter, this week or month compared with the last. With no filters, every stock in the universe is listed.',
            'Under **Columns**, press **+** and pick the values to show for each match, such as `return_63` or `ema_50`, from the list — it stays open so you can add several. The features your filters read are shown as well.',
            'Choose **Order by** and a direction.',
            'The **Broker instruments / Watchlist / Symbol list** pill, and, for broker instruments, the **NSE**/**BSE** toggle, set the universe quickly. Open **More options** for the rest: renaming the screen, which broker, a symbol cap, including BE/SME listings, a symbol list you type by hand, and **Before it runs**.',
            'Open **More options**, check **Before it runs**, then press **Run**.',
          ),
          p('Percentages are typed as percentages: enter `-5` for −5%. **Gap %** is the open against the previous close; **Gap up %** and **Gap down %** are its size in that direction (0 otherwise), so `Gap down % ≥ 2%` finds stocks that opened at least 2% lower. See **Indicator reference** for every feature you can use. Weekly and monthly filters are for the Screener only: a Study reads daily bars.'),
          p(
            'The toolbar’s screen name is a dropdown to switch between your saved screens without the side list. The universe pill and **More options**’s own universe fields write the same settings — changing one changes the other too, there is no separate state to keep in sync. The refresh icon reruns the current screen, same as **Run**.',
          ),
        ],
      },
      {
        heading: 'Results',
        blocks: [
          list(
            'The table shows the matches, as of the latest trading day in the data. Click a column heading to sort; click a row to open that stock’s chart.',
            '**Charts** (beside **Table**, above the results) shows the matches as daily candlestick charts instead, in the table’s current order: pick **1 × 1**, **1 × 2**, **2 × 1** or **2 × 2**, page through with the arrows, and press a stock’s name above the charts to open it in a chart tab. Above the charts, **1M**, **3M**, **6M**, **1Y**, **5Y** and **All** choose how much history each chart shows (a chart’s own toolbar still changes its interval). Each match has a flag: in the table it is before the symbol (it shows when you point at the row, or when set), and above the charts it is beside each stock’s name. Click it to pick a colour, or to remove the flag. A flag is the symbol’s own, so it shows on every watchlist and in that colour’s flag list. While the charts are shown, the **Filters** and **Columns** sections fold to one line each to give them room; click either heading to open it again.',
            '**Add to a watchlist** puts every match on a new or existing watchlist. **CSV** saves the table in its current order.',
            'Symbols with too little history for a filter, or that have not traded for a week (suspended or delisted), are left out and counted in a note above the table.',
          ),
        ],
      },
      {
        heading: 'Saving and speed',
        blocks: [
          list(
            '**Save** keeps the screen under **My screens**. A saved screen keeps its last result, which reappears when you open it.',
            'With **Market data** downloaded (Data providers → **Market data**), a screen reads every NSE stock’s history from this computer in one go and finishes in a couple of seconds. Without it, the very first screen over a whole exchange fetches every stock’s full history at the broker’s rate limit — about 12 minutes for NSE through Zerodha — and later runs top up each stock with one quick batched quote check.',
            '**Before it runs** estimates how many broker requests, and quick quote checks, the run needs and how long they take. Use **Try it on the first 100 symbols first** for a quick trial.',
          ),
        ],
      },
    ],
    related: ['indicators', 'python', 'schedules', 'studies'],
  },
  {
    id: 'python',
    title: 'Python scripts',
    group: 'Research',
    summary: 'Screen, backtest and analyse your broker’s data with your own Python code.',
    sections: [
      {
        heading: 'Setting up',
        blocks: [
          steps(
            'Install Python 3.10 or newer on your computer if you do not have it.',
            'Open the Python tab with `Ctrl+Shift+Y` or the **Python** icon on the right rail.',
            'Press **Set up Python**. The application creates a private environment in its data folder and installs pandas and numpy into it.',
          ),
          p(
            'To use an environment of your own instead (for example conda or uv), open the gear icon (**Python settings**) and choose its interpreter. The settings also show how much market data scripts have caused the application to keep, and can clear it.',
          ),
        ],
      },
      {
        heading: 'The workspace',
        blocks: [
          table(
            ['Part', 'Purpose'],
            [
              ['**Scripts** (left)', 'Your scripts, stored as ordinary `.py` files. **+** creates one; **Open folder** shows them on disk so you can use any editor or version control.'],
              ['Editor (centre)', 'Edit the open script. `Ctrl+S` saves; `Ctrl+Enter` runs.'],
              ['**Run** / **Stop**', 'Runs the script; Stop ends it and anything it started.'],
              ['**Console**', 'Everything the script prints, with errors highlighted.'],
              ['**Results**', 'Tables, backtest reports and figures the script shows (see below).'],
              ['**Schedules**', 'Runs scripts automatically at set times. See **Scheduled scripts**.'],
            ],
          ),
          p('Example scripts are provided to start from: a greeting, four screens (above the 200-day average, RSI oversold, 52-week highs, and six-month momentum read with `pt.panel`) and a moving-average crossover backtest.'),
        ],
      },
      {
        heading: 'The protrade package',
        blocks: [
          p('Scripts reach market data through the `protrade` package, which the application provides automatically:'),
          code(
            'import protrade as pt\n\ndf = pt.bars("zerodha:NSE:RELIANCE", "D", start="2024-01-01")\npanel = pt.bars_many(pt.universe("Nifty 50"), "D", limit=250, errors="skip")\npt.show(table, title="Above the 200-day average")',
          ),
          table(
            ['Function', 'Purpose'],
            [
              ['`pt.bars(symbol, interval, start, end, limit)`', 'Price history for one symbol, as a pandas DataFrame.'],
              ['`pt.bars_many(symbols, …)`', 'History for many symbols: a dictionary of DataFrames. Daily bars the market data holds come in one read; the rest are fetched in parallel.'],
              ['`pt.panel(symbols, start, end, bars)`', 'Stored daily bars for many symbols in one read from the market data on this computer. `.frame(symbol)` is one symbol’s DataFrame, `.wide("close")` a dates × symbols table, and `.missing` the symbols it doesn’t hold yet.'],
              ['`pt.universe(name)` / `pt.watchlist(name)`', 'The symbols of a watchlist.'],
              ['`pt.watchlists()` / `pt.instruments(provider, …)`', 'Your watchlists, or a broker’s instrument list.'],
              ['`pt.resample(df, rule)`', 'Builds coarser bars, starting each bucket at the session open.'],
              ['`pt.show(df, title)`', 'Shows a sortable table in **Results**. A `symbol` column becomes clickable, and the list can be added to a watchlist.'],
              ['`pt.report(trades=…, equity=…)`', 'Shows a backtest report: return, drawdown, CAGR, Sharpe ratio, win rate, an equity curve and the trades.'],
              ['`pt.plot()`', 'Shows the current matplotlib figure.'],
              ['`pt.set_watchlist(name, symbols, mode)`', 'Creates or refreshes one of your watchlists. See **Scheduled scripts**.'],
            ],
          ),
        ],
      },
      {
        heading: 'Things to know',
        blocks: [
          list(
            '**Data sources.** Scripts can read Zerodha and your imported CSV data, only for reading. Crypto data is not available to scripts.',
            '**Timeframes.** Zerodha serves 1, 3, 5, 10, 15, 30 and 60 minutes and daily. Use `pt.resample` for others.',
            '**Speed.** With **Market data** downloaded, `pt.panel` and `pt.bars_many` read daily bars for every NSE stock from this computer in one request. Anything else is fetched from your broker at its pace (Zerodha allows about three a second) and kept, so later runs are fast.',
            '**Your credentials stay in the application.** A script never receives a broker key or token; it asks the application for data over a private local connection.',
          ),
          note('Python is not a sandbox. A script runs with your own permissions, exactly as if you ran it from a terminal. Run only code you trust. Nothing in the Python tab places orders.'),
        ],
      },
    ],
    related: ['schedules', 'screener', 'studies'],
  },
  {
    id: 'schedules',
    title: 'Scheduled scripts and watchlist refresh',
    group: 'Research',
    summary: 'Run a Python script automatically at set times, for example to refresh a watchlist every evening.',
    sections: [
      {
        heading: 'Creating a schedule',
        blocks: [
          steps(
            'In the Python tab, open the script you want to run and press **Schedule** in the toolbar. The **Schedules** tab opens with a new schedule for that script.',
            'Choose the **Days** (or press **Weekdays** or **Every day**).',
            'Choose **Once, at** a time, or **Repeatedly** every so many minutes between two times — for example every 15 minutes from 09:15 to 15:30.',
            'Leave **Switched on** ticked and press **Create schedule**.',
          ),
          p('All times are Indian Standard Time (IST), the same clock as the markets the application reads.'),
        ],
      },
      {
        heading: 'Managing schedules',
        blocks: [
          list(
            'Each schedule shows its rule, when it runs next, and how its last run ended.',
            'The checkbox switches a schedule on or off. **Run now** runs it immediately; **Stop** ends a run in progress; the pencil edits it; the bin deletes it with its history.',
            'The arrow beside a schedule shows its history. Click a run to read what the script printed; a failed run shows the reason, and the main window also tells you when a scheduled run fails.',
          ),
        ],
      },
      {
        heading: 'When schedules run',
        blocks: [
          list(
            'Schedules run only while the application is open. A run that came due while it was closed, or while the computer was asleep, is recorded as **Missed** and is not made up. Starting the application never runs a script.',
            'If a run is still going when the next one comes due, the next one is **Skipped**.',
            'A scheduled run is exactly like pressing Run: the same Python, the same data access and the same permissions.',
          ),
          note('Only you can create a schedule, using this form. The AI assistant, scripts and layouts cannot create one.'),
        ],
      },
      {
        heading: 'Keeping a watchlist up to date',
        blocks: [
          p('A script can create or refresh one of your watchlists with `pt.set_watchlist`:'),
          code(
            'import protrade as pt\n\nbars = pt.bars_many(pt.universe("Nifty 50"), "D", limit=260, errors="skip")\nabove = [s for s, df in bars.items()\n         if len(df) > 200 and df.close.iloc[-1] > df.close.rolling(200).mean().iloc[-1]]\npt.set_watchlist("Above the 200-day", above)',
          ),
          list(
            'The watchlist is created if it does not exist. Names are matched without regard to capital letters.',
            'With `mode="replace"` (the default) the list ends up holding exactly these symbols: symbols no longer listed are removed; those that remain keep their position and colour flag; new ones are added at the end. Section headings are left untouched.',
            'With `mode="append"` new symbols are only added.',
            'You can pass a list, a pandas Series, or a DataFrame with a `symbol` column. `zerodha:TCS` is read as `zerodha:NSE:TCS`.',
            'The script prints what changed, and the watchlist panel updates at once.',
          ),
          p('Schedule such a script for after the market close — for example weekdays at 16:00 — and the list is fresh every evening.'),
        ],
      },
    ],
    related: ['python', 'watchlists'],
  },
  {
    id: 'studies',
    title: 'Studies: building and running',
    group: 'Research',
    summary: 'Ask what stocks looked like before and after historical market events.',
    sections: [
      {
        heading: 'What a Study is',
        blocks: [
          p(
            'A Study examines every occasion in history when a set of conditions first held for a stock — for example, *its 12-month return crossed +100%* — and measures what the stocks looked like before, on and after those events. It is research into historical association, not a screen of today’s market and not a trading backtest.',
          ),
          p('Open **Studies** from the flask icon on the right rail. Studies need Python and a connected Zerodha account.'),
        ],
      },
      {
        heading: 'Starting a Study',
        blocks: [
          p(
            'Pick a template on the left — 100% Winners, 200% Winners, Breakout Winners, Post-Consolidation Breakouts, Volume Expansion, Trend Transition, Relative Strength Leaders, Drawdown Recovery, How Winners Got There, After the Breakout — or **New Study** for a blank one. Any Study can be edited, duplicated and saved under **My Studies**.',
          ),
        ],
      },
      {
        heading: 'The builder',
        blocks: [
          table(
            ['Section', 'What you set'],
            [
              ['**Study**', 'A name, the question the Study answers (shown above its answer) and a description.'],
              ['**Universe**', 'A broker’s NSE/BSE list, a watchlist, or symbols you list; optional floors on average traded value and price; an optional limit on the number of symbols for a quick trial.'],
              ['**Study period**', 'The dates within which events are looked for.'],
              ['**Event**', 'Conditions that must all hold together, and a cooldown so that one move counts as one event.'],
              ['**What to measure**', 'Measures read over a window of bars around each event: how often a condition held, the longest run, the return, the maximum drawdown, and so on. A window can be fixed (the 12 months before) or run between a bar found near the event and the event itself (from its 12-month low).'],
              ['**Event-day snapshot**', 'Pre-event conditions, observation points before the event, forward windows after it, metrics and yes/no characteristics.'],
              ['**Comparison**', 'A control group of random non-event dates, or an outcome that splits events into those that went on to a gain and those that did not.'],
            ],
          ),
          p('Beside the form, the builder reads the Study back in plain words and lists the data it needs.'),
        ],
      },
      {
        heading: 'Data readiness',
        blocks: [
          list(
            'The readiness panel shows what is available: prices and volume from your broker, index data for relative strength, and how many stocks will be loaded, how many are already stored and roughly how long the rest will take.',
            '**Market cap, sectors and historical index membership are not available** from these data sources. A Study that needs market cap cannot run; the builder offers a floor on average traded value instead, applied only if you choose it.',
            'Results carry a survivorship-bias warning: today’s instrument list does not include companies delisted in the past.',
            'With **Market data** downloaded (Data providers → **Market data**), a Study reads NSE stocks’ history from this computer in batches instead of asking the broker. Anything it doesn’t hold (BSE listings, history older than five years) is fetched at the broker’s rate limit — about 12 minutes for all of NSE through Zerodha, several times longer with BSE — and kept, so reruns take seconds.',
          ),
        ],
      },
      {
        heading: 'Running',
        blocks: [
          p(
            'Press **Run Study**. A progress bar shows each stage and the time remaining; **Stop** cancels. When the run finishes, its result is stored and opens automatically. Nothing runs until you press Run Study.',
          ),
        ],
      },
    ],
    related: ['study-results', 'ai-studies', 'indicators'],
  },
  {
    id: 'study-results',
    title: 'Studies: reading results',
    group: 'Research',
    summary: 'The answer, the charts, each stock, the details, comparisons, notebooks and exports.',
    sections: [
      {
        heading: 'The results page',
        blocks: [
          table(
            ['Part', 'What it shows'],
            [
              ['Question and answer', 'The Study’s question, and an answer written from the numbers: for the typical stock, what each headline measure came to, the middle half of values, and how it compares with the comparison group.'],
              ['Chart', 'How a measure is spread across the stocks, or, for a condition, the share of stocks in which it held day by day.'],
              ['**Stock by stock**', 'Every event with its measures. Click a row to open that stock’s chart framed around the event, with the event marked. **Add to a watchlist** adds every stock.'],
              ['**Details**', 'The earlier, fuller tables: measures, summary, the event table and timeline, distributions at each observation point, before and after, results by liquidity, the comparison and a stock explorer.'],
            ],
          ),
        ],
      },
      {
        heading: 'Significance',
        blocks: [
          p(
            'When a Study has a comparison group, every difference is tested (Mann–Whitney for measurements, a difference in proportions for characteristics) and adjusted for the number of comparisons the Study makes. **What stands out** lists the clear differences in words.',
          ),
          note('Results describe historical association. They do not show that any characteristic caused a price move.'),
        ],
      },
      {
        heading: 'Comparing runs and keeping notes',
        blocks: [
          list(
            'Every run is stored under **Recent results** (the last 20 of each Study). Open one at any time without running again.',
            'To compare two runs, press the compare icon on one result and then on another; the comparison shows what differs in their specifications and their figures side by side.',
            '**Research Notebooks** group Studies and results with your own notes. Use **Notebook** in the toolbar to add the open Study or result. A result in a notebook is never removed automatically.',
          ),
        ],
      },
      {
        heading: 'Exporting',
        blocks: [
          p(
            '**Export** saves the Study Specification (JSON), a Python version of the Study, the events, stock summary and metric statistics as CSV, the full result as JSON, or a written report (Markdown). **Generate Python** shows the Study as a script you can open, change and run in the Python tab.',
          ),
        ],
      },
    ],
    related: ['studies', 'ai-studies'],
  },
  {
    id: 'ai-studies',
    title: 'AI in Studies',
    group: 'Research',
    summary: 'Draft and revise Studies in plain language, explain results, and plan research with AI.',
    sections: [
      {
        heading: 'Drafting and revising a Study',
        blocks: [
          p(
            'Above the builder, describe the Study you want in plain words — for example, “what did stocks look like three months before a 52-week-high breakout on double volume?” — or ask for a change to the current one (“use NSE and BSE, and add ADX”). The assistant proposes a specification and shows what it changed, what it assumed and what cannot be studied with the available data. **Open as a new Study** or **Apply to this Study** loads the proposal into the builder for you to review; nothing runs until you press Run Study.',
          ),
        ],
      },
      {
        heading: 'Explaining a result',
        blocks: [
          p('On a result, **Explain with AI** writes a plain-language reading of it, with its caveats. It is given only summary figures — counts, medians and test results — never the individual events, symbols or prices.'),
        ],
      },
      {
        heading: 'Research with AI',
        blocks: [
          steps(
            'Choose **Research with AI** at the top of the Studies list and ask a broad question.',
            'The assistant proposes up to four Studies that together address it, each with its purpose and a data check.',
            'Tick the Studies to run and press **Run N approved Studies**. They run one after another; **Stop** skips the rest.',
            'Press **Write the synthesis of N results** for a reading across the results, where the evidence is thin, and follow-up questions. A follow-up becomes a new plan that needs your approval.',
          ),
          p('The question, plans, Studies, results and synthesis are recorded in a Research Notebook as they happen.'),
          note('These features use your own Claude or GPT API key and are billed to your account. See **AI providers**.'),
        ],
      },
    ],
    related: ['studies', 'ai-providers', 'ask-ai'],
  },
  {
    id: 'ask-ai',
    title: 'Ask AI',
    group: 'Research',
    summary: 'An assistant that answers questions and proposes actions for you to approve.',
    sections: [
      {
        heading: 'Asking a question',
        blocks: [
          p(
            'Open **Ask AI** from the right rail, type a question or a request, and press **Ask** (`Ctrl+Enter`). The assistant can explain how to use the application and answer general questions. It needs an AI provider key (see **AI providers**).',
          ),
        ],
      },
      {
        heading: 'Actions you approve',
        blocks: [
          p('The assistant can propose these actions. Each appears as a card, and nothing happens until you press **Approve** on it:'),
          list(
            'Open a symbol on the active chart, or change its timeframe.',
            'Add or remove a built-in indicator on the active chart.',
            'Create a watchlist, or add or remove a symbol in one.',
            'Create a price alert at a level you specify.',
          ),
          p('**Reject**, or leaving a card alone, does nothing. The assistant cannot delete a watchlist or layout, change settings or credentials, or use Python, Studies or the Screener.'),
        ],
      },
      {
        heading: 'What is sent',
        blocks: [
          p(
            'Your conversation, the active chart’s symbol and timeframe, the labels of your open tabs and the names of your watchlists are sent to the AI provider you chose. The contents of your watchlists, your credentials and broker tokens are never sent.',
          ),
        ],
      },
    ],
    related: ['ai-providers', 'ai-studies'],
  },

  // ---- Data and settings ------------------------------------------------------------------------
  {
    id: 'data-providers',
    title: 'Data providers',
    group: 'Data and settings',
    summary: 'Choose where prices come from, and set up broker accounts.',
    sections: [
      {
        heading: 'Sources',
        blocks: [
          table(
            ['Source', 'Coverage'],
            [
              ['**Zerodha** (your account)', 'NSE, BSE, NFO and MCX equities, indices, futures and commodities; history and a live tick feed. Needs a paid Kite Connect subscription.'],
              ['**Imported data**', 'Your own CSV files.'],
            ],
          ),
          note('Zerodha is the only broker today. Binance, Coinbase and Hyperliquid were removed as data sources — see **Symbols that can no longer load**.'),
        ],
      },
      {
        heading: 'The Data providers screen',
        blocks: [
          p('Open it from the plug icon at the bottom of the right rail. For each source you can:'),
          list(
            'Switch it on or off. Imported data starts on; brokers start off until configured.',
            'Enter credentials and press **Save**. Secret values are stored in your operating system’s credential store and are never shown again.',
            'Press **Test connection** to confirm the credentials work.',
            'Press **Make default** to decide which source a ticker typed without a source uses.',
            'See the state of its **Instrument list** (used for symbol search), which is refreshed weekly.',
          ),
          p('Below the sources, **Market data** downloads every NSE stock’s daily history to this computer. See **Market data on this computer**.'),
          note('Market data from your broker account is licensed for your own use. Do not rebroadcast it, for example on a public stream or website.'),
        ],
      },
    ],
    related: ['market-data', 'zerodha', 'import-csv'],
  },
  {
    id: 'market-data',
    title: 'Market data on this computer',
    group: 'Data and settings',
    summary: 'Five years of every NSE stock’s daily prices, downloaded once and kept current, so research runs in seconds.',
    sections: [
      {
        heading: 'What it is',
        blocks: [
          p(
            'The Screener, Studies and Python scripts look at hundreds or thousands of stocks at once. Asking your broker for each one is slow — Zerodha allows about three history requests a second. **Market data** keeps five years of daily prices for every NSE stock (regular EQ series) and every NSE index on this computer instead, so a whole-market screen reads them in a second or two.',
          ),
          p('Daily, weekly and monthly charts of those stocks draw from it too, fetching only the latest bar. Intraday charts (1 minute, 5 minutes…) still come from your broker as before.'),
        ],
      },
      {
        heading: 'Downloading it',
        blocks: [
          steps(
            'Connect Zerodha under **Data providers** — the history comes from your own account.',
            'In the same dialog, under **Market data on this computer**, press **Download**. It takes about 10–15 minutes at the broker’s pace.',
            'Keep working: charts always go ahead of the download at the broker. **Stop** pauses it; **Resume download** carries on from where it stopped.',
          ),
          p('The Home tab’s **Market data** card shows **Done** once the download has finished.'),
        ],
      },
      {
        heading: 'Keeping it current',
        blocks: [
          list(
            'With **Update after each trading day** on, the application brings the data up to date by itself once each session has settled (after 4 PM IST), whenever it is open — or a couple of minutes after you open it, if it missed a day. It never runs during startup. **Update now** does it straight away.',
            'Each update adds the latest prices, downloads the history of any newly listed stock (an IPO), and, after a split or bonus, reads that stock’s whole history again so old and adjusted prices are never mixed.',
            'A holiday is noticed from the market itself and costs nothing.',
            'A Zerodha login lasts until the next morning. If it has expired, the update says so and waits; log in again under **Data providers**.',
          ),
          note('Prices are your broker’s, as it supplies them. The store holds about 150–200 MB.'),
        ],
      },
    ],
    related: ['data-providers', 'screener', 'studies', 'python'],
  },
  {
    id: 'zerodha',
    title: 'Connecting Zerodha',
    group: 'Data and settings',
    summary: 'Set up Kite Connect for history, a live feed and the research tools.',
    sections: [
      {
        heading: 'Before you start',
        blocks: [
          p(
            'You need a Kite Connect app with a market-data subscription, created at developers.kite.trade. Note its **API key** and **API secret**, and set the app’s **redirect URL** to `http://127.0.0.1:47821` exactly. The application shows this address with a copy button beside the login button.',
          ),
        ],
      },
      {
        heading: 'Setting up',
        blocks: [
          steps(
            'Open **Data providers → Zerodha**, enter the API key and secret, and press **Save**.',
            'Press **Log in with Zerodha** and sign in on the page that opens. The application receives Zerodha’s reply itself and stores the access token; there is nothing to copy.',
            'Zerodha switches on and downloads its instrument list. **Test connection** confirms that everything works.',
            'Optionally press **Make default**, so that typing `RELIANCE` opens `NSE:RELIANCE`.',
          ),
        ],
      },
      {
        heading: 'Daily login',
        blocks: [
          p(
            'Zerodha’s access tokens expire every morning at around 06:00 IST. Each day’s first session needs a fresh login — one button and a few seconds. The dialog shows roughly how long today’s token has left, and charts tell you when it has expired.',
          ),
          p(
            'You can log in from three places: **Data providers → Zerodha**, the **Zerodha** row at the top of the **Home** tab (which also shows how long today’s login has left), or the **Log in to Zerodha** window that appears when you open the application after your login has expired. That window appears once per launch; **Not now** dismisses it until next time. It never appears if you haven’t logged in before or have switched Zerodha off.',
          ),
          p(
            'If your Kite app must redirect elsewhere, use **Paste the address instead** in **Data providers** (the Home tab’s **Other ways to log in** opens it): sign in, then paste the complete address your browser was sent to (it contains `request_token=`). A request token works once, for a few minutes.',
          ),
        ],
      },
      {
        heading: 'Security',
        blocks: [
          list(
            'While you log in, the application listens only on `127.0.0.1:47821`, which only programs on your computer can reach, and stops as soon as the token arrives or after five minutes.',
            'The API secret and access token are kept in your operating system’s credential store and are used only by the application’s backend. The secret is used only to sign the login.',
            'One live feed connection is shared by every chart, tab and window.',
          ),
        ],
      },
    ],
    related: ['data-providers'],
  },
  {
    id: 'import-csv',
    title: 'Importing your own data',
    group: 'Data and settings',
    summary: 'Chart any instrument from a CSV file of prices.',
    sections: [
      {
        heading: 'Importing a file',
        blocks: [
          steps(
            'Press **Import data** (database icon) in the right rail and choose **Choose CSV file…**.',
            'Check the detected columns and **Bar size**, and correct them if needed.',
            'Give the data a **Ticker** and, optionally, a description, then import it.',
            'Open it by searching for its ticker, or from the list of **Imported datasets** in the same dialog.',
          ),
          p('Imported data can be charted at its own bar size or any coarser one: one-minute data can be viewed as 5-minute, hourly, daily, weekly or monthly. It is also available to Python scripts as `csv:TICKER`.'),
        ],
      },
      {
        heading: 'File format',
        blocks: [
          code('time,open,high,low,close,volume\n2024-01-02,187.15,188.44,183.89,185.64,82488700\n2024-01-03,184.22,185.88,183.43,184.25,58414500'),
          list(
            'A header row is required; column names are matched regardless of capitals. Volume is optional.',
            'The time column may be called `time`, `date`, `datetime` or `timestamp`, and may be written as `2024-01-02`, `2024-01-02 09:15`, ISO 8601, `YYYYMMDD`, epoch seconds or milliseconds, or `DD/MM/YYYY` or `MM/DD/YYYY` (the order is worked out from the data). A time without a time zone is read in your local time zone.',
            'Commas, semicolons or tabs may separate columns; decimal commas and quoted fields are accepted.',
            'Rows are sorted and de-duplicated. Rows with a missing or non-positive price are skipped and reported.',
          ),
        ],
      },
    ],
    related: ['symbols', 'data-providers'],
  },
  {
    id: 'ai-providers',
    title: 'AI providers',
    group: 'Data and settings',
    summary: 'Add your own Claude or GPT API key for Ask AI and the AI features in Studies.',
    sections: [
      {
        heading: 'Adding a key',
        blocks: [
          steps(
            'Open **AI providers** from the key icon at the bottom of the right rail.',
            'Paste your Anthropic (Claude) or OpenAI (GPT) API key and save it. The key is checked with the provider before it is stored.',
            'With both configured, choose which one to **Use for AI features**.',
          ),
        ],
      },
      {
        heading: 'Privacy and cost',
        blocks: [
          list(
            'Keys are kept in your operating system’s credential store, used only by the application’s backend, and never shown again or written to logs.',
            'Requests are sent to the provider you chose under your own account and are billed to it.',
            'Each feature says what it sends. Ask AI sends your conversation and a small description of your workspace; Studies send the question, the specification and summary figures — never individual prices or events.',
          ),
        ],
      },
    ],
    related: ['ask-ai', 'ai-studies'],
  },
  {
    id: 'appearance',
    title: 'Appearance and themes',
    group: 'Data and settings',
    summary: 'Choose one of six colour themes.',
    sections: [
      {
        heading: 'Themes',
        blocks: [
          p(
            'Choose a theme from the selector in the tab bar: **Daylight**, **Paper**, **Midnight**, **Graphite**, **Ocean** or **Terminal**. The first theme follows your operating system’s light or dark setting. The theme applies to every window and is not stored in layouts. Colours you set yourself on a chart, such as candle colours, are kept.',
          ),
        ],
      },
      {
        heading: 'Chart background',
        blocks: [
          p(
            'A chart’s background follows the theme unless you choose one for it in the chart’s settings (**Chart settings → Canvas**). A background you choose belongs to the chart: it is saved with the layout, restored when the layout opens, and kept when you change the theme. The chart’s text colour adjusts so it stays readable.',
          ),
          note('A background chosen to be exactly the dark theme’s or the light theme’s own colour cannot be told apart from the theme’s, and follows the theme.'),
        ],
      },
    ],
    related: ['welcome'],
  },
  {
    id: 'updates',
    title: 'Updates and About',
    group: 'Data and settings',
    summary: 'Keep the application up to date, and find version and licence information.',
    sections: [
      {
        heading: 'Updates',
        blocks: [
          list(
            'The application checks for a newer release about once a day and offers to install it. A dot on the **About** button and a message tell you when one is waiting.',
            '**About → Updates** checks now, installs a waiting update and switches the daily check on or off.',
            'Every update is verified against a signing key built into the application before it is installed.',
          ),
        ],
      },
      {
        heading: 'About',
        blocks: [
          p(
            'The **About** dialog (the information icon in the right rail) shows the version, the location of your data, the licence (GNU AGPL-3.0, free software with no warranty), the source code, credits and the keyboard shortcuts.',
          ),
        ],
      },
    ],
    related: ['privacy'],
  },

  // ---- Reference --------------------------------------------------------------------------------
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    group: 'Reference',
    summary: 'Every keyboard shortcut in the application.',
    sections: [
      { heading: 'Application', blocks: [table(['Keys', 'Action'], SHORTCUTS)] },
      { heading: 'Editors and panels', blocks: [table(['Keys', 'Action'], EDITOR_SHORTCUTS)] },
      { heading: 'Charts', blocks: [p('Press `?` on a chart for Vela’s own shortcuts for drawing, zooming and navigating.')] },
      {
        heading: 'On macOS',
        blocks: [p('Use `Cmd` in place of `Ctrl` and `Option` in place of `Alt`.')],
      },
    ],
    related: ['welcome'],
  },
  {
    id: 'indicators',
    title: 'Indicator reference (Screener and Studies)',
    group: 'Reference',
    summary: 'Every feature name the Screener and Studies understand, and what it measures.',
    sections: [
      {
        heading: 'How features are named',
        blocks: [
          p(
            'A feature is a name, usually followed by a window in bars: `ema_200` is the 200-bar exponential moving average, `return_63` the return over 63 bars (about three months), `rsi_14` the 14-bar RSI. Windows run from 1 to 1,000 bars; with daily bars, 21 is about one month and 252 about one year. Friendly aliases are accepted too, such as `return_12m`, `high_52w`, `distance_from_52w_high` and `relative_volume`.',
          ),
          p('Returns, distances, slopes and volatilities are fractions: `0.25` means +25%. The forms accept them as percentages. A feature has no value until its window is full.'),
        ],
      },
      { heading: 'Features', blocks: [table(['Name', 'Meaning'], indicatorRows())] },
      {
        heading: 'Conditions',
        blocks: [
          p(
            'A condition compares a feature with a number or with another feature, using `>`, `>=`, `<`, `<=`, `crosses_above` or `crosses_below`, or with a range using `between` (both ends included) or `outside`. For example `close crosses_above prior_high_252` means the close rose above the previous 52-week high, and `rsi_14 between 40 and 60` that RSI is in the middle of its range. In the Screener a feature can also be on weekly or monthly bars (`rsi_14@W`, `ema_50@M`).',
          ),
        ],
      },
    ],
    related: ['screener', 'studies'],
  },
  {
    id: 'privacy',
    title: 'Privacy and security',
    group: 'Reference',
    summary: 'What the application stores, what it sends, and how credentials are protected.',
    sections: [
      {
        heading: 'What stays on your computer',
        blocks: [
          list(
            'There is no account and no telemetry. Layouts, watchlists, alerts, scripts, Studies, screens, imported data and cached prices are kept in one database file on your computer.',
            'Broker credentials and AI keys are kept in your operating system’s credential store (Windows Credential Manager, macOS Keychain or the Linux Secret Service). If none is available, the application stores them in its database and clearly warns that they are unencrypted.',
            'Credentials are read only by the application’s backend. The user interface, Python scripts and the AI assistant never receive them.',
          ),
        ],
      },
      {
        heading: 'What the application contacts',
        blocks: [
          list(
            'The data sources you switch on, for market data.',
            'GitHub, to check for updates (the daily check can be switched off).',
            'The AI provider you configured, only when you use an AI feature.',
          ),
        ],
      },
      {
        heading: 'Scripts',
        blocks: [
          p(
            'Python scripts run with your own permissions and are not sandboxed. A script runs only when you press Run or when a schedule you created comes due while the application is open. The local connection scripts use for data is available only on your computer, protected by a token that only scripts started by the application receive, and it never returns a credential.',
          ),
        ],
      },
    ],
    related: ['python', 'schedules', 'ai-providers'],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    group: 'Reference',
    summary: 'Solutions to common problems.',
    sections: [
      {
        heading: 'A chart is empty or says the data is unavailable',
        blocks: [
          list(
            'Check that the symbol’s data source is switched on in **Data providers**.',
            'For Zerodha, log in again: tokens expire every morning.',
            'Messages about a plan or subscription mean your broker account does not include market data.',
            'Symbols from a data source the app no longer has (`binance:…`, `coinbase:…`, `hyperliquid:…`) can no longer be loaded; see **Symbols and searching**.',
          ),
        ],
      },
      {
        heading: 'Python, the Screener or a Study will not run',
        blocks: [
          list(
            'Open the Python tab and follow the banner: install Python 3.10 or newer, then press **Set up Python**.',
            'Make sure Zerodha is connected and its token is current.',
            'Read **Before it runs**, under **More options** for the Screener, or the readiness panel for Studies, which names anything blocking the run.',
            'If a result cannot be read after an update, restart the application so that it uses the current engine.',
          ),
        ],
      },
      {
        heading: 'A run takes a long time',
        blocks: [
          p(
            'The first run over many symbols is limited by your broker’s rate limit. The estimate before a run shows how long it will take; use a trial on 100 symbols or a watchlist universe to try an idea quickly. Data is kept, so the second run is fast.',
          ),
        ],
      },
      {
        heading: 'An alert did not fire',
        blocks: [
          list(
            'Alerts are checked only while the application is open, about every 20 seconds; a brief spike between checks can be missed.',
            'An alert set on the far side of the price waits for the price to come back and cross the level.',
            'Check that the alert is not paused, and that system notifications are allowed for ProTradeChart.',
          ),
        ],
      },
      {
        heading: 'A scheduled script did not run',
        blocks: [
          list(
            'Schedules run only while the application is open and the computer is awake; otherwise the run is recorded as **Missed**.',
            'Check that the schedule is switched on, and read its history for the reason a run failed.',
            'A run is **Skipped** if the previous run is still going.',
          ),
        ],
      },
    ],
    related: ['data-providers', 'python', 'alerts', 'schedules'],
  },
];

export const topicById = (id: string): HelpTopic | undefined => HELP_TOPICS.find((t) => t.id === id);

/** A text span inside a paragraph: plain, bold (`**…**`) or code (`` `…` ``). */
export interface InlinePart {
  text: string;
  style: 'plain' | 'bold' | 'code';
}

/** Splits a paragraph at its `**bold**` and `` `code` `` marks. An unclosed mark is kept as text. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), style: 'plain' });
    parts.push(m[1] !== undefined ? { text: m[1], style: 'bold' } : { text: m[2], style: 'code' });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), style: 'plain' });
  return parts;
}

/** A topic's words as plain text, for searching. */
function topicText(topic: HelpTopic): string {
  const blockText = (b: HelpBlock): string[] => {
    switch (b.kind) {
      case 'p':
      case 'note':
      case 'code':
        return [b.text];
      case 'steps':
      case 'list':
        return b.items;
      case 'table':
        return [...b.head, ...b.rows.flat()];
    }
  };
  return [topic.title, topic.summary, ...topic.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap(blockText)])]
    .join(' ')
    .replace(/\*\*|`/g, '');
}

export interface HelpMatch {
  topic: HelpTopic;
  /** The words around the first match in the body, or the summary when the title matched. */
  snippet: string;
}

/** Topics containing every word of `query`, best first: matches in the title, then the summary, then the body. */
export function searchHelp(query: string): HelpMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { match: HelpMatch; score: number }[] = [];
  for (const topic of HELP_TOPICS) {
    const text = topicText(topic);
    const lower = text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const title = topic.title.toLowerCase();
    const summary = topic.summary.toLowerCase();
    const score = words.reduce((s, w) => s + (title.includes(w) ? 10 : summary.includes(w) ? 3 : 1), 0);
    let snippet = topic.summary;
    if (!words.every((w) => title.includes(w))) {
      const at = lower.indexOf(words[0]);
      const start = Math.max(0, at - 50);
      snippet = `${start > 0 ? '…' : ''}${text.slice(start, at + 90).trim()}…`;
    }
    scored.push({ match: { topic, snippet }, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.match);
}
