import { saveStudyResult } from '../../lib/ipc';
import { runSummary, type StudyResultData } from '../../studies/result';

/** Keeps a completed run so it reopens without running again. Resolves with its id. `studyId` ties
 *  it to a Study (saved or not); a run from a script uses a `script:` id of its own. */
export async function storeStudyRun(result: StudyResultData, studyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await saveStudyResult({
    id,
    studyId,
    name: result.spec.name,
    summaryJson: JSON.stringify(runSummary(result)),
    resultJson: JSON.stringify(result),
    executedAt: result.meta.executed_at || new Date().toISOString(),
  });
  return id;
}
