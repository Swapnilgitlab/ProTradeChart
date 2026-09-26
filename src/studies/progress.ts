/** The engine reports its stage as console lines — `[progress]  62% Detecting events` — which read
 *  fine in a terminal and which the Studies tab turns into a progress bar. Pure. */

export interface StudyProgress {
  percent: number;
  stage: string;
}

const LINE = /^\[progress\]\s+(\d{1,3})%\s+(.+)$/;

export function parseProgress(line: string): StudyProgress | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  return { percent: Math.min(100, Number(m[1])), stage: m[2].trim().slice(0, 120) };
}
