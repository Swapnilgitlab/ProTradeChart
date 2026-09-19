import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, Trash2 } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import { detectTimeframeString, parseOhlcvCsv, sanitizeTicker, type CsvParseResult } from '../../lib/csv';
import { confirmDelete } from '../../lib/dialogs';
import { formatDate } from '../../lib/format';
import { deleteDataset, errorMessage, listDatasets, saveDataset, type DatasetInfo } from '../../lib/ipc';
import { joinSymbol } from '../../lib/symbols';

interface Props {
  onClose: () => void;
  /** Loads a `csv:TICKER` symbol into the active chart. */
  onOpenSymbol: (symbol: string) => void;
}

const TIMEFRAME_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: '1 minute' },
  { value: '2', label: '2 minutes' },
  { value: '3', label: '3 minutes' },
  { value: '5', label: '5 minutes' },
  { value: '10', label: '10 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
  { value: 'D', label: '1 day' },
  { value: 'W', label: '1 week' },
  { value: 'M', label: '1 month' },
];

function timeframeLabel(tf: string): string {
  return TIMEFRAME_OPTIONS.find((o) => o.value === tf)?.label ?? tf;
}

interface Pending {
  fileName: string;
  result: CsvParseResult;
}

/** Import an OHLCV CSV as a local dataset, and manage the ones already
 *  imported. Datasets are stored in the app's database and chart offline as
 *  `csv:TICKER`. */
export function ImportDataDialog({ onClose, onOpenSymbol }: Props) {
  const toast = useToast();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ticker, setTicker] = useState('');
  const [description, setDescription] = useState('');
  const [timeframe, setTimeframe] = useState('D');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDatasets(await listDatasets());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setError(null);
    try {
      const result = parseOhlcvCsv(await file.text());
      setPending({ fileName: file.name, result });
      if (!result.error) {
        setTicker(sanitizeTicker(file.name));
        setDescription('');
        setTimeframe(detectTimeframeString(result.bars.map((b) => b.time)));
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const cleanTicker = sanitizeTicker(ticker);
  const replacing = datasets.some((d) => d.ticker === cleanTicker);
  const canImport = pending && !pending.result.error && cleanTicker !== '' && !saving;

  async function doImport() {
    if (!pending || pending.result.error || !cleanTicker) return;
    setSaving(true);
    setError(null);
    try {
      const info = await saveDataset({
        ticker: cleanTicker,
        description: description.trim() || null,
        baseTf: timeframe,
        bars: pending.result.bars,
      });
      toast(`Imported ${info.barCount.toLocaleString()} bars as csv:${info.ticker}.`, 'success');
      onOpenSymbol(joinSymbol('csv', info.ticker));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function doDelete(d: DatasetInfo) {
    if (!(await confirmDelete(`Delete the imported dataset "${d.ticker}"? Charts using it will go blank.`))) return;
    try {
      await deleteDataset(d.ticker);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const bars = pending?.result.bars ?? [];

  return (
    <Dialog
      wide
      title="Import data"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {pending && !pending.result.error && (
            <button type="button" className="btn btn-primary" disabled={!canImport} onClick={doImport}>
              {saving ? 'Importing…' : replacing ? `Replace ${cleanTicker}` : 'Import & open'}
            </button>
          )}
        </>
      }
    >
      <p className="secondary" style={{ marginTop: 0 }}>
        Chart your own OHLCV data. Imported files are stored locally and work fully offline.
      </p>

      {error && <p className="notice error">{error}</p>}

      <div className="drop-zone">
        <FileUp size={22} />
        <span>
          A CSV with a header row: <strong>time</strong> (or date), <strong>open</strong>, <strong>high</strong>,{' '}
          <strong>low</strong>, <strong>close</strong> and optionally <strong>volume</strong>.
        </span>
        <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
          Choose CSV file…
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,.txt,.tsv" style={{ display: 'none' }} onChange={onFilePicked} />
      </div>

      {pending?.result.error && <p className="notice error" style={{ marginTop: 12 }}>{pending.result.error}</p>}

      {pending && !pending.result.error && (
        <>
          <div className="file-name">{pending.fileName}</div>
          <div className="stat-grid">
            <div className="stat">
              <div className="label">Rows imported</div>
              <div className="value">{bars.length.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">From</div>
              <div className="value">{formatDate(bars[0]?.time)}</div>
            </div>
            <div className="stat">
              <div className="label">To</div>
              <div className="value">{formatDate(bars[bars.length - 1]?.time)}</div>
            </div>
          </div>

          {pending.result.warnings.length > 0 && (
            <div className="notice">
              {pending.result.rowsSkipped.toLocaleString()} row(s) skipped:
              <ul>
                {pending.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="field-row">
            <div className="field">
              <label htmlFor="import-ticker">Ticker</label>
              <input id="import-ticker" type="text" value={ticker} onChange={(e) => setTicker(e.currentTarget.value)} spellCheck={false} />
              <span className="field-hint">
                Charted as <code>csv:{cleanTicker || '…'}</code>
                {replacing && ' — replaces the existing dataset with this name.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="import-tf">Bar size</label>
              <select id="import-tf" value={timeframe} onChange={(e) => setTimeframe(e.currentTarget.value)}>
                {TIMEFRAME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="field-hint">Detected from the file. Coarser timeframes are built automatically.</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="import-desc">Description (optional)</label>
            <input id="import-desc" type="text" value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          </div>
        </>
      )}

      <div className="section-title">Imported datasets</div>
      {datasets.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Nothing imported yet.</p>
      ) : (
        <div className="dataset-list">
          {datasets.map((d) => (
            <div key={d.ticker} className="dataset-row">
              <div className="info">
                <span className="ticker">{d.ticker}</span>{' '}
                <span className="muted small">
                  {d.barCount.toLocaleString()} × {timeframeLabel(d.baseTf)} · {formatDate(d.firstTime)} – {formatDate(d.lastTime)}
                </span>
                {d.description && <div className="secondary small">{d.description}</div>}
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onOpenSymbol(joinSymbol('csv', d.ticker));
                  onClose();
                }}
              >
                Open
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${d.ticker}`} onClick={() => doDelete(d)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
