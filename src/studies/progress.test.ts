import { describe, expect, it } from 'vitest';
import { parseProgress } from './progress';

describe('parseProgress', () => {
  it('reads the engine’s progress lines and nothing else', () => {
    expect(parseProgress('[progress]  62% Detecting events')).toEqual({ percent: 62, stage: 'Detecting events' });
    expect(parseProgress('[progress] 100% Complete')).toEqual({ percent: 100, stage: 'Complete' });
    expect(parseProgress('fetched 3/10')).toBeNull();
    expect(parseProgress('x [progress] 5% y')).toBeNull();
  });
});
