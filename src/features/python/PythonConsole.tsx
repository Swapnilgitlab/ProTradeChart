import { useEffect, useRef } from 'react';
import { Eraser } from 'lucide-react';
import type { ConsoleLine } from '../../python/console';

interface Props {
  lines: readonly ConsoleLine[];
  /** How long the current run has been going, when one is. */
  runningFor: string | null;
  onClear: () => void;
}

/** What a script prints. Follows the newest line unless the reader has scrolled up to read
 *  something, in which case it stays put. */
export function PythonConsole({ lines, runningFor, onClear }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    if (following.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  return (
    <div className="pine-console python-console">
      <div className="pine-console-header">
        <span>{runningFor ? `Console · running ${runningFor}` : 'Console'}</span>
        <button type="button" className="icon-button" aria-label="Clear console" title="Clear console" onClick={onClear} disabled={lines.length === 0}>
          <Eraser size={13} />
        </button>
      </div>
      <div
        className="pine-console-lines python-console-lines"
        ref={scroller}
        role="log"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 && <div className="pine-console-empty">What your script prints appears here.</div>}
        {lines.map((line) => (
          <div key={line.id} className={`pine-console-line python-line ${line.stream}`}>
            {/* A blank line still takes a row's height. */}
            <span>{line.text === '' ? ' ' : line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
