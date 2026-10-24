import { describe, expect, it } from 'vitest';
import { defaultPrefs, loadPrefs } from '../src/app/prefs';
import { DEFAULT_SCALE, SCALES, cpx, getScale, snapScale } from '../src/ui/scale';

describe('interface scale', () => {
  it('defaults to 90 %', () => {
    expect(DEFAULT_SCALE).toBe(0.9);
    expect(getScale()).toBe(0.9);
    expect(defaultPrefs().uiScale).toBe(0.9);
    expect(SCALES).toContain(DEFAULT_SCALE);
  });

  it('snaps anything to an offered scale and rejects junk', () => {
    expect(snapScale(1)).toBe(1);
    expect(snapScale(1.2)).toBe(1.25);
    expect(snapScale(0.1)).toBe(SCALES[0]);
    expect(snapScale(9)).toBe(SCALES[SCALES.length - 1]);
    for (const bad of [undefined, null, 'big', NaN, Infinity]) expect(snapScale(bad)).toBe(DEFAULT_SCALE);
  });

  it('scales inline lengths through the stylesheet variable', () => {
    expect(cpx(10)).toBe('calc(10 * var(--px))');
  });

  it('reads the saved scale, falling back to the default', () => {
    expect(loadPrefs().uiScale).toBe(DEFAULT_SCALE);
  });
});
