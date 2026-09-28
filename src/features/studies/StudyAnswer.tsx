import { Plus } from 'lucide-react';
import type { Answer } from '../../studies/answer';

interface Props {
  answer: Answer;
  /** Opens the builder, from the fallback answer of a Study that measures nothing over time. */
  onAddMeasure?: () => void;
}

/** The answer a result opens with: one plain sentence per headline measure, and which events it
 *  covers. Sentences are text nodes: a label is the user's (or the AI's) words, never markup. */
export function StudyAnswer({ answer, onAddMeasure }: Props) {
  return (
    <section className={`study-answer-card${answer.fallback ? ' fallback' : ''}`} aria-label="Answer">
      <ul className="study-answer">
        {answer.lines.map((line, i) => (
          <li key={i}>
            {line.text}
            {line.coverage && <div className="study-coverage small muted">{line.coverage}</div>}
          </li>
        ))}
      </ul>
      {answer.fallback && onAddMeasure && (
        <button type="button" className="btn btn-tiny" onClick={onAddMeasure}>
          <Plus size={13} />
          Add a measure over time
        </button>
      )}
    </section>
  );
}
