import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';

interface Props {
  title: string;
  /** Loads the text: a lazy `?raw` import, so it only becomes part of the page when shown. */
  load: () => Promise<string>;
  onClose: () => void;
}

/** Shows one of the licence files the app carries, so they can be read without leaving it. */
export function LicenseTextDialog({ title, load, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((body) => !cancelled && setText(body))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <Dialog
      wide
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {failed ? (
        <p className="notice error">
          This file couldn&rsquo;t be opened. It is also installed next to the app, and in the project&rsquo;s repository.
        </p>
      ) : (
        <pre className="license-text">{text ?? 'Loading…'}</pre>
      )}
    </Dialog>
  );
}
