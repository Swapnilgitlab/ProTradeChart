import { describe, expect, it } from 'vitest';
import { stripOverflow } from './tabStrip';

describe('stripOverflow', () => {
  it('says nothing is hidden when every tab fits', () => {
    expect(stripOverflow(0, 600, 800)).toEqual({ left: false, right: false });
    expect(stripOverflow(0, 800, 800)).toEqual({ left: false, right: false });
  });

  it('says which side has hidden tabs', () => {
    expect(stripOverflow(0, 1500, 800)).toEqual({ left: false, right: true });
    expect(stripOverflow(300, 1500, 800)).toEqual({ left: true, right: true });
    expect(stripOverflow(700, 1500, 800)).toEqual({ left: true, right: false });
  });

  it('allows for a fraction of a pixel at either end', () => {
    expect(stripOverflow(0.5, 1500, 800)).toEqual({ left: false, right: true });
    expect(stripOverflow(699.4, 1500, 800)).toEqual({ left: true, right: false });
  });
});
