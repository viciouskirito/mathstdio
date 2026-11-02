import { describe, expect, it } from 'vitest';

import { compileExpression } from '../src/core/expression';
import {
  analyzeSampledKeyPoints,
  calculateVector,
  computeDerivative,
  fitYRange,
  validateRange,
  validateVector,
} from '../src/core/math';
import type { CompiledExpression, VectorValues } from '../src/types';

function expression(source: string): CompiledExpression {
  const result = compileExpression(source, 'x');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('range utilities', () => {
  it('accepts zero boundaries and valid ranges', () => {
    expect(validateRange({ xMin: 0, xMax: 10, yMin: 0, yMax: 1 })).toEqual({
      ok: true,
      value: { xMin: 0, xMax: 10, yMin: 0, yMax: 1 },
    });
  });

  it.each([
    [{ xMin: 2, xMax: 1, yMin: -1, yMax: 1 }, '最大值必须大于最小值'],
    [{ xMin: 0, xMax: 1e-7, yMin: -1, yMax: 1 }, '范围过小'],
    [{ xMin: 0, xMax: 1e6 + 1, yMin: -1, yMax: 1 }, '不能超过'],
    [{ xMin: Number.NaN, xMax: 1, yMin: -1, yMax: 1 }, '有限数字'],
  ])('rejects invalid range %#', (range, message) => {
    const result = validateRange(range);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });

  it('fits a robust visible y range', () => {
    expect(validateRange({ xMin: 1e13, xMax: 1e13 + 1, yMin: 0, yMax: 1 }).ok).toBe(false);
    expect(validateRange({ xMin: 1e12 - 0.001, xMax: 1e12, yMin: 0, yMax: 1 }).ok).toBe(false);
    const fitted = fitYRange([expression('100000*x')], -10, 10);
    expect(validateRange({ xMin: -10, xMax: 10, yMin: fitted[0], yMax: fitted[1] }).ok).toBe(true);
    const [minimum, maximum] = fitYRange([expression('x^2')], -2, 2);
    expect(minimum).toBeLessThanOrEqual(0);
    expect(maximum).toBeGreaterThan(3.5);
    expect(fitYRange([], -1, 1)).toEqual([-7, 7]);
  });
});

describe('key point analysis', () => {
  it.each(['1/(x-0.123)', 'tan(x)', 'floor(x)+0.5'])(
    'does not report poles or jumps as roots: %s',
    (source) => {
      const compiled = expression(source);
      const samples = Array.from({ length: 201 }, (_, index) => {
        const x = -2 + index * 0.02;
        return { x, y: compiled.evaluate(x) };
      });
      const roots = analyzeSampledKeyPoints(compiled, samples, -2, 2).filter(
        (p) => p.type === 'root',
      );
      for (const root of roots)
        expect(Math.abs(compiled.evaluate(root.x))).toBeLessThanOrEqual(1e-9);
      if (!source.startsWith('tan')) expect(roots).toHaveLength(0);
    },
  );
  it('finds roots, extrema and the y-intercept', () => {
    const compiled = expression('x^2-1');
    const samples = Array.from({ length: 401 }, (_, index) => {
      const x = -2 + index / 100;
      return { x, y: compiled.evaluate(x) };
    });
    const points = analyzeSampledKeyPoints(compiled, samples, -2, 2);
    const roots = points.filter((point) => point.type === 'root').map((point) => point.x);
    expect(roots).toEqual(expect.arrayContaining([expect.closeTo(-1, 5), expect.closeTo(1, 5)]));
    expect(points.some((point) => point.type === 'minimum' && Math.abs(point.x) < 0.02)).toBe(true);
    expect(points.some((point) => point.type === 'y-intercept' && point.y === -1)).toBe(true);
  });

  it('handles discontinuity gaps and sign-change roots', () => {
    const compiled = expression('x-0.123');
    const samples = Array.from({ length: 41 }, (_, index) => {
      const x = -1 + index * 0.05;
      return index === 2 ? null : { x, y: compiled.evaluate(x) };
    });
    const root = analyzeSampledKeyPoints(compiled, samples, -1, 1).find(
      (point) => point.type === 'root',
    );
    expect(root?.x).toBeCloseTo(0.123, 8);
  });
});

describe('derivative calculation', () => {
  it('computes accurate numerical derivatives for polynomials and trigonometric functions', () => {
    const quad = expression('x^2');
    expect(computeDerivative(quad, 2)).toBeCloseTo(4, 4);
    expect(computeDerivative(quad, 0)).toBeCloseTo(0, 4);
    expect(computeDerivative(quad, -3)).toBeCloseTo(-6, 4);

    const sinFn = expression('sin(x)');
    expect(computeDerivative(sinFn, 0)).toBeCloseTo(1, 4);
    expect(computeDerivative(sinFn, Math.PI / 2)).toBeCloseTo(0, 4);
    expect(computeDerivative(sinFn, Math.PI)).toBeCloseTo(-1, 4);
  });

  it('handles non-finite values safely', () => {
    const fn = expression('1/x');
    expect(Number.isFinite(computeDerivative(fn, Number.NaN))).toBe(false);
  });
});

describe('vector operations', () => {
  const base: Omit<VectorValues, 'operation'> = { a: [3, 2, 1], b: [1, 3, 2] };

  it('adds vectors', () => {
    expect(calculateVector({ ...base, operation: 'add' })).toMatchObject({
      vector: [4, 5, 3],
      helperEndpoint: [1, 3, 2],
    });
  });

  it('subtracts vectors and uses -B as the helper endpoint', () => {
    expect(calculateVector({ ...base, operation: 'subtract' })).toMatchObject({
      vector: [2, -1, -1],
      helperEndpoint: [-1, -3, -2],
    });
  });

  it('calculates the dot product and angle', () => {
    const result = calculateVector({ ...base, operation: 'dot' });
    expect(result.scalar).toBe(11);
    expect(result.angleDegrees).toBeCloseTo(38.213, 3);
  });

  it('calculates the cross product', () => {
    const result = calculateVector({ ...base, operation: 'cross' });
    expect(result.vector).toEqual([1, -5, 7]);
    expect(result.magnitude).toBeCloseTo(Math.sqrt(75), 12);
  });

  it('handles zero vectors and rejects non-finite or oversized components', () => {
    const zeroDot = calculateVector({ a: [0, 0, 0], b: [1, 2, 3], operation: 'dot' });
    expect(zeroDot.scalar).toBe(0);
    expect(zeroDot.angleDegrees).toBeUndefined();
    expect(validateVector({ a: [0, 0, 0], b: [1, 2, 3], operation: 'add' })).toBeNull();
    expect(validateVector({ a: [Number.NaN, 0, 0], b: [0, 0, 0], operation: 'add' })).toContain(
      '有限',
    );
    expect(validateVector({ a: [1e6 + 1, 0, 0], b: [0, 0, 0], operation: 'add' })).toContain(
      '1,000,000',
    );
  });
});
