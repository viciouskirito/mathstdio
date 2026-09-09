import type { CompiledExpression, ViewRange } from '../types';

export interface PlotPoint {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface DensityBand {
  leftCx: number;
  rightCx: number;
  minCy: number;
  maxCy: number;
}

export interface SampledPlot {
  points: Array<PlotPoint | null>;
  envelopes: DensityBand[];
  evaluations: number;
  limited: boolean;
  gaps: number;
}

/** Screen-space approximation. Bands show observed samples, never a proven range. */
export function samplePlot(
  expression: CompiledExpression,
  range: ViewRange,
  width: number,
  height: number,
  maxEvaluations = 16_000,
): SampledPlot {
  const result: SampledPlot = {
    points: [],
    envelopes: [],
    evaluations: 0,
    limited: false,
    gaps: 0,
  };
  const cells = Math.min(1200, Math.max(300, Math.ceil(width)));
  const xSpan = range.xMax - range.xMin;
  const ySpan = range.yMax - range.yMin;
  const evaluate = (x: number): PlotPoint | null => {
    if (result.evaluations >= maxEvaluations) {
      result.limited = true;
      return null;
    }
    result.evaluations += 1;
    const y = expression.evaluate(x);
    if (!Number.isFinite(y)) return null;
    // Bound only screen coordinates; keep the actual finite mathematical value.
    const cy = Math.max(-1e8, Math.min(1e8, ((range.yMax - y) / ySpan) * height));
    return { x, y, cx: ((x - range.xMin) / xSpan) * width, cy };
  };
  const append = (point: PlotPoint | null): void => {
    const previous = result.points.at(-1);
    if (point === null) {
      if (previous !== null) {
        result.points.push(null);
        result.gaps += 1;
      }
    } else if (previous?.x !== point.x) result.points.push(point);
  };

  // Probe every cell before refining any, so one singularity cannot starve the other side.
  // Uneven interior probes reduce coherent aliasing of periodic functions.
  const fractions = [0, 0.2113248654, 0.5, 0.7886751346, 1];
  const coarse: Array<Array<PlotPoint | null>> = [];
  let edge = evaluate(range.xMin);
  for (let index = 0; index < cells; index += 1) {
    const cell = [edge];
    for (const fraction of fractions.slice(1)) {
      cell.push(evaluate(range.xMin + ((index + fraction) / cells) * xSpan));
    }
    coarse.push(cell);
    edge = cell[4] ?? null;
  }

  const refine = (
    samples: Array<PlotPoint | null>,
    leftX: number,
    rightX: number,
    depth: number,
    allowance: { remaining: number },
  ): void => {
    const left = samples[0] ?? null;
    const right = samples[4] ?? null;
    const valid = samples.filter((point): point is PlotPoint => point !== null);
    const spanPx = ((rightX - leftX) / xSpan) * width;
    const complete = valid.length === 5;
    if (complete && left && right) {
      const offscreen = valid.every((p) => p.cy < -2) || valid.every((p) => p.cy > height + 2);
      if (offscreen) {
        append(null);
        append(right);
        return;
      }
      const deviation = Math.max(
        ...valid.map((p) => {
          const fraction = (p.x - leftX) / (rightX - leftX);
          return Math.abs(p.cy - (left.cy + (right.cy - left.cy) * fraction));
        }),
      );
      if (deviation <= 0.65) {
        append(left);
        append(right);
        return;
      }
    }

    const exhausted = allowance.remaining < 6 || result.evaluations + 6 > maxEvaluations;
    if (
      depth >= 10 ||
      spanPx <= (maxEvaluations > 16_000 ? 0.04 : 0.08) ||
      exhausted ||
      valid.length === 0
    ) {
      if (exhausted) result.limited = true;
      let reversals = 0;
      for (let index = 2; index < valid.length; index += 1) {
        const a = valid[index - 2];
        const b = valid[index - 1];
        const c = valid[index];
        if (!a || !b || !c) continue;
        if ((b.cy - a.cy) * (c.cy - b.cy) < -0.5) reversals += 1;
      }
      // Monotone jumps and poles are gaps. Only bounded oscillation gets a band.
      if (complete && reversals >= 2 && valid.every((p) => p.cy >= -height && p.cy <= height * 2)) {
        result.envelopes.push({
          leftCx: ((leftX - range.xMin) / xSpan) * width,
          rightCx: ((rightX - range.xMin) / xSpan) * width,
          minCy: Math.max(0, Math.min(...valid.map((p) => p.cy))),
          maxCy: Math.min(height, Math.max(...valid.map((p) => p.cy))),
        });
      }
      // Never join an unresolved interval or invent a value at an undefined point.
      append(left);
      append(null);
      append(right);
      return;
    }
    const middleX = leftX + (rightX - leftX) / 2;
    const middle = samples[2] ?? null;
    if (middleX === leftX || middleX === rightX) {
      append(null);
      append(right);
      return;
    }
    const children: [Array<PlotPoint | null>, Array<PlotPoint | null>] = [[left], [middle]];
    for (let side = 0; side < 2; side += 1) {
      const child = side === 0 ? children[0] : children[1];
      const start = side === 0 ? leftX : middleX;
      const end = side === 0 ? middleX : rightX;
      for (const fraction of fractions.slice(1, 4)) {
        child.push(evaluate(start + (end - start) * fraction));
        allowance.remaining -= 1;
      }
      child.push(side === 0 ? middle : right);
    }
    refine(children[0], leftX, middleX, depth + 1, allowance);
    refine(children[1], middleX, rightX, depth + 1, allowance);
  };
  for (const [index, cell] of coarse.entries()) {
    refine(
      cell,
      range.xMin + (index / cells) * xSpan,
      range.xMin + ((index + 1) / cells) * xSpan,
      0,
      { remaining: maxEvaluations > 16_000 ? 192 : 96 },
    );
  }
  return result;
}
