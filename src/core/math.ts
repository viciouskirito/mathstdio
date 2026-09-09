import type { CompiledExpression, VectorOperation, VectorValues, ViewRange } from '../types';

export const MIN_RANGE_SPAN = 1e-6;
export const MAX_RANGE_SPAN = 1e6;
export const MAX_RANGE_COORDINATE = 1e12;
export const MAX_VECTOR_COMPONENT = 1e6;

export type RangeValidation = { ok: true; value: ViewRange } | { ok: false; message: string };

export function validateRange(range: ViewRange): RangeValidation {
  const values = [range.xMin, range.xMax, range.yMin, range.yMax];
  if (!values.every(Number.isFinite)) return { ok: false, message: '视图范围必须是有限数字' };
  if (values.some((value) => Math.abs(value) > MAX_RANGE_COORDINATE)) {
    return { ok: false, message: '视图坐标绝对值不能超过 1,000,000,000,000，以保证数值精度' };
  }
  const xSpan = range.xMax - range.xMin;
  const ySpan = range.yMax - range.yMin;
  if (xSpan <= 0 || ySpan <= 0) return { ok: false, message: '最大值必须大于最小值' };
  if (xSpan < MIN_RANGE_SPAN || ySpan < MIN_RANGE_SPAN) {
    return { ok: false, message: '视图范围过小，请扩大后重试' };
  }
  if (xSpan > MAX_RANGE_SPAN || ySpan > MAX_RANGE_SPAN) {
    return { ok: false, message: '视图范围不能超过 1,000,000' };
  }
  if (
    xSpan < Math.max(Math.abs(range.xMin), Math.abs(range.xMax)) * Number.EPSILON * 32 ||
    ySpan < Math.max(Math.abs(range.yMin), Math.abs(range.yMax)) * Number.EPSILON * 32
  ) {
    return { ok: false, message: '当前坐标下范围过小，已达到浮点精度限制，请扩大范围' };
  }
  return { ok: true, value: { ...range } };
}

export function fitYRange(
  expressions: CompiledExpression[],
  xMin: number,
  xMax: number,
  sampleCount = 600,
): [number, number] {
  const values: number[] = [];
  for (const expression of expressions) {
    for (let index = 0; index <= sampleCount; index += 1) {
      const x = xMin + (index / sampleCount) * (xMax - xMin);
      const y = expression.evaluate(x);
      if (Number.isFinite(y) && Math.abs(y) <= MAX_RANGE_SPAN) values.push(y);
    }
  }
  if (values.length < 4) return [-7, 7];
  values.sort((a, b) => a - b);
  const low = values[Math.floor(values.length * 0.02)] ?? values[0] ?? -7;
  const high =
    values[Math.min(values.length - 1, Math.ceil(values.length * 0.98))] ?? values.at(-1) ?? 7;
  const span = Math.max(high - low, 1e-3);
  const padding = Math.max(span * 0.15, 0.5);
  const center = low + (high - low) / 2;
  const halfSpan = Math.min(MAX_RANGE_SPAN / 2, (high - low) / 2 + padding);
  return [center - halfSpan, center + halfSpan];
}

export interface SampleValue {
  x: number;
  y: number;
}

export interface FunctionKeyPoint extends SampleValue {
  type: 'root' | 'maximum' | 'minimum' | 'y-intercept';
}

export function analyzeSampledKeyPoints(
  expression: CompiledExpression,
  samples: Array<SampleValue | null>,
  xMin: number,
  xMax: number,
): FunctionKeyPoint[] {
  const points: FunctionKeyPoint[] = [];
  const xTolerance = Math.max((xMax - xMin) / Math.max(samples.length, 2), 1e-10);
  const add = (point: FunctionKeyPoint): void => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const duplicate = points.some(
      (existing) => existing.type === point.type && Math.abs(existing.x - point.x) <= xTolerance,
    );
    if (!duplicate) points.push(point);
  };

  for (let index = 1; index < samples.length - 1; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const next = samples[index + 1];
    if (!previous || !current || !next) continue;

    if (Math.abs(current.y) <= 1e-9) {
      add({ type: 'root', x: current.x, y: current.y });
    } else if (previous.y * current.y < 0) {
      const x = bisectRoot(expression, previous.x, current.x);
      const y = expression.evaluate(x);
      if (Number.isFinite(x) && Number.isFinite(y)) add({ type: 'root', x, y });
    }

    const leftSlope = current.y - previous.y;
    const rightSlope = next.y - current.y;
    const slopeScale = Math.max(Math.abs(previous.y), Math.abs(current.y), Math.abs(next.y), 1);
    if (leftSlope * rightSlope < 0 && Math.abs(leftSlope - rightSlope) > slopeScale * 1e-10) {
      add({
        type: leftSlope > 0 ? 'maximum' : 'minimum',
        x: current.x,
        y: current.y,
      });
    }
  }

  if (xMin <= 0 && xMax >= 0) {
    const y = expression.evaluate(0);
    add({ type: 'y-intercept', x: 0, y });
  }
  return points;
}

function bisectRoot(expression: CompiledExpression, left: number, right: number): number {
  let a = left;
  let b = right;
  let fa = expression.evaluate(a);
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = a + (b - a) / 2;
    const fm = expression.evaluate(middle);
    if (!Number.isFinite(fm)) return Number.NaN;
    if (Math.abs(fm) < 1e-11) return middle;
    if (middle === a || middle === b) break;
    if (fa * fm <= 0) b = middle;
    else {
      a = middle;
      fa = fm;
    }
  }
  // A sign change may be a pole or a jump. Require an actual near-zero residual.
  const candidate = a + (b - a) / 2;
  return Math.abs(expression.evaluate(candidate)) <= 1e-9 ? candidate : Number.NaN;
}

export interface VectorResult {
  operation: VectorOperation;
  vector?: [number, number, number];
  scalar?: number;
  magnitude?: number;
  angleDegrees?: number;
  helperEndpoint?: [number, number, number];
}

export function validateVector(values: VectorValues): string | null {
  const components = [...values.a, ...values.b];
  if (!components.every(Number.isFinite)) return '向量分量必须是有限数字';
  if (components.some((value) => Math.abs(value) > MAX_VECTOR_COMPONENT)) {
    return '向量分量绝对值不能超过 1,000,000';
  }
  return null;
}

export function calculateVector(values: VectorValues): VectorResult {
  const [ax, ay, az] = values.a;
  const [bx, by, bz] = values.b;
  const magnitudeA = Math.hypot(ax, ay, az);
  const magnitudeB = Math.hypot(bx, by, bz);

  if (values.operation === 'add') {
    return {
      operation: 'add',
      vector: [ax + bx, ay + by, az + bz],
      helperEndpoint: [bx, by, bz],
    };
  }
  if (values.operation === 'subtract') {
    return {
      operation: 'subtract',
      vector: [ax - bx, ay - by, az - bz],
      helperEndpoint: [-bx, -by, -bz],
    };
  }
  if (values.operation === 'cross') {
    const vector: [number, number, number] = [
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx,
    ];
    return { operation: 'cross', vector, magnitude: Math.hypot(...vector) };
  }

  const scalar = ax * bx + ay * by + az * bz;
  const cosine = magnitudeA > 0 && magnitudeB > 0 ? scalar / (magnitudeA * magnitudeB) : Number.NaN;
  const result: VectorResult = { operation: 'dot', scalar };
  if (Number.isFinite(cosine)) {
    result.angleDegrees = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  }
  return result;
}
