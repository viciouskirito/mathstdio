import { describe, expect, it } from 'vitest';
import { compileExpression } from '../src/core/expression';
import { samplePlot, type PlotPoint } from '../src/core/sampling';

const range = { xMin: -10, xMax: 10, yMin: -7, yMax: 7 };
function sample(source: string, custom = range, budget = 16_000) {
  const expression = compileExpression(source, 'x');
  if (!expression.ok) throw new Error(expression.error.message);
  return samplePlot(expression.value, custom, 800, 500, budget);
}
function edges(points: Array<PlotPoint | null>) {
  return points.flatMap((point, index) => {
    const previous = points[index - 1];
    return point && previous ? [[previous, point] as const] : [];
  });
}

describe('screen-space sampling', () => {
  it.each([
    '1/x',
    '1/(x-0.12345)',
    'tan(x)',
    'exp(x)',
    'ln(x)',
    'sqrt(x)',
    'sin(100/x)',
    'floor(x)',
  ])('only returns finite coordinates for %s', (source) => {
    const result = sample(source);
    expect(result.evaluations).toBeLessThanOrEqual(16_000);
    expect(result.points.filter(Boolean).length).toBeGreaterThan(10);
    for (const point of result.points) {
      if (point) expect(Object.values(point).every(Number.isFinite)).toBe(true);
    }
  });
  it.each([0, 0.12345, -1.41421356])('does not draw across the pole at %s', (pole) => {
    const result = sample(`1/(x-(${pole}))`);
    expect(edges(result.points).some(([a, b]) => a.x < pole && b.x > pole)).toBe(false);
    expect(result.envelopes).toHaveLength(0);
  });
  it('does not bridge removable holes or a finite-width excluded domain', () => {
    for (const source of ['sin(x)/x', 'sqrt((x-0.005)^2-0.000016)']) {
      const result = sample(source);
      const excludedX = source.startsWith('sin') ? 0 : 0.005;
      expect(edges(result.points).some(([a, b]) => a.x < excludedX && b.x > excludedX)).toBe(false);
    }
    expect(sample('sin(x)/x').points.some((p) => p?.x === 0)).toBe(false);
  });
  it('keeps steep continuous lines connected through the viewport', () => {
    const result = sample('10000*(x-0.12345)');
    expect(edges(result.points).some(([a, b]) => a.y < -7 && b.y > 7)).toBe(true);
    expect(result.envelopes).toHaveLength(0);
  });
  it('breaks step jumps without inventing oscillation bands', () => {
    const result = sample('floor(x)');
    expect(edges(result.points).every(([a, b]) => a.y === b.y)).toBe(true);
    expect(result.envelopes).toHaveLength(0);
  });
  it('uses local observed bands for dense oscillation and retains both sides', () => {
    const result = sample('sin(100/x)');
    expect(result.envelopes.length).toBeGreaterThan(0);
    expect(result.envelopes.every((band) => band.rightCx - band.leftCx <= 1)).toBe(true);
    expect(result.points.some((p) => p && p.x > 9)).toBe(true);
    expect(result.points.some((p) => p && p.x < -9)).toBe(true);
    const segments = edges(result.points);
    for (const direction of [-1, 1]) {
      const covered = segments
        .filter(([a, b]) => direction * a.x >= 2 && direction * b.x >= 2)
        .reduce((total, [a, b]) => total + b.x - a.x, 0);
      expect(covered).toBeGreaterThan(7.7);
    }
  });
  it('respects a tight budget and never connects an unresolved pole', () => {
    const result = sample('sin(1000/x)+1/(x-0.12345)', range, 3300);
    expect(result.evaluations).toBeLessThanOrEqual(3300);
    expect(result.limited).toBe(true);
    expect(edges(result.points).some(([a, b]) => a.x < 0.12345 && b.x > 0.12345)).toBe(false);
  });
  it('handles overflow and a wholly undefined domain without fake curves', () => {
    expect(sample('sqrt(-1)').points.filter(Boolean)).toHaveLength(0);
    const result = sample('exp(x)', { xMin: 700, xMax: 720, yMin: -1, yMax: 1 });
    expect(edges(result.points)).toHaveLength(0);
  });
});
