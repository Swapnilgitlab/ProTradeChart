import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Search, X } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { HELP_GROUPS, HELP_TOPICS, inlineParts, searchHelp, topicById, type HelpBlock, type HelpTopic } from '../../help/topics';

interface Props {
  /** The topic to open on, when a caller knows what the user is looking at. */
  initialTopic?: string;
  onClose: () => void;
}

/** The topic last read, so Help reopens where you left it (for as long as the app runs). */
let lastTopic = 'welcome';

/** Text with its `**bold**` and `` `code` `` marks, drawn as React text — never as HTML. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) =>
        part.style === 'bold' ? <strong key={i}>{part.text}</strong> : part.style === 'code' ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case 'note':
      return (
        <div className="help-note">
          <Info size={14} aria-hidden="true" />
          <p>
            <Inline text={block.text} />
          </p>
        </div>
      );
    case 'code':
      return <pre className="help-code">{block.text}</pre>;
    case 'steps':
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Inline text={item} />
        </li>
      ));
      return block.kind === 'steps' ? <ol className="help-steps">{items}</ol> : <ul className="help-list">{items}</ul>;
    }
    case 'table':
      return (
        <table className="help-table">
          <thead>
            <tr>
              <th>{block.head[0]}</th>
              <th>{block.head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map(([a, b], i) => (
              <tr key={i}>
                <td>
                  <Inline text={a} />
                </td>
                <td>
                  <Inline text={b} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/** The Help Center: every topic, grouped, with search, and the chosen topic beside them. */
export function HelpDialog({ initialTopic, onClose }: Props) {
  const [topicId, setTopicId] = useState(() => (initialTopic && topicById(initialTopic) ? initialTopic : lastTopic));
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const topic: HelpTopic = topicById(topicId) ?? HELP_TOPICS[0];
  const matches = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  const open = (id: string) => {
    setTopicId(id);
    lastTopic = id;
  };

  // A new topic starts at its top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [topicId]);

  return (
    <Dialog title="Help" onClose={onClose} className="help-dialog">
      <div className="help-center">
        <nav className="help-nav" aria-label="Help topics">
          <label className="help-search">
            <Search size={14} aria-hidden="true" />
            <input
              className="python-input"
              value={query}
              placeholder="Search help"
              aria-label="Search help"
              spellCheck={false}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {searching && (
              <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>
          {searching ? (
            <div className="help-results">
              {matches.length === 0 && <p className="muted small">No topic mentions “{query.trim()}”.</p>}
              {matches.map((m) => (
                <button key={m.topic.id} type="button" className={`help-result${m.topic.id === topic.id ? ' active' : ''}`} onClick={() => open(m.topic.id)}>
                  <span className="help-result-title">{m.topic.title}</span>
                  <span className="muted small">{m.snippet}</span>
                </button>
              ))}
            </div>
          ) : (
            HELP_GROUPS.map((group) => (
              <div key={group} className="help-group">
                <div className="help-group-title">{group}</div>
                {HELP_TOPICS.filter((t) => t.group === group).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`help-topic-link${t.id === topic.id ? ' active' : ''}`}
                    aria-current={t.id === topic.id ? 'page' : undefined}
                    onClick={() => open(t.id)}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            ))
          )}
        </nav>

        <article className="help-content" ref={contentRef} aria-labelledby="help-topic-title">
          <div className="help-breadcrumb muted small">{topic.group}</div>
          <h1 id="help-topic-title">{topic.title}</h1>
          <p className="help-summary">{topic.summary}</p>
          {topic.sections.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </section>
          ))}
          {topic.related && topic.related.length > 0 && (
            <section className="help-related">
              <h2>Related topics</h2>
              <div>
                {topic.related.map((id) => {
                  const r = topicById(id);
                  return (
                    r && (
                      <button key={id} type="button" className="link-button" onClick={() => open(id)}>
                        {r.title}
                      </button>
                    )
                  );
                })}
              </div>
            </section>
          )}
        </article>
      </div>
    </Dialog>
  );
}
