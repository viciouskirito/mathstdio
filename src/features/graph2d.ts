import { byId, debounce, formatNumber } from '../core/dom';
import { compileExpression } from '../core/expression';
import { analyzeSampledKeyPoints, fitYRange, validateRange } from '../core/math';
import type { CompiledExpression, GraphFunction, ViewRange } from '../types';

const SERIES_COLORS = [
  '#2563eb',
  '#e05252',
  '#0d9488',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#c026d3',
  '#65a30d',
];
const MAX_FUNCTIONS = 8;

interface RuntimeFunction extends GraphFunction {
  compiled?: CompiledExpression;
  row: HTMLDivElement;
  input: HTMLInputElement;
  errorElement: HTMLParagraphElement;
}

interface SamplePoint {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface SampleSeries {
  runtime: RuntimeFunction;
  points: Array<SamplePoint | null>;
  sampleCount: number;
}

interface SpecialPoint extends SamplePoint {
  color: string;
  label: string;
}

export interface GraphChangeDetail {
  functions: GraphFunction[];
  selectedId: string;
  range: ViewRange;
}

export class Graph2D {
  readonly canvas = byId<HTMLCanvasElement>('graph-canvas');
  readonly #context: CanvasRenderingContext2D;
  readonly #baseCanvas = document.createElement('canvas');
  readonly #baseContext: CanvasRenderingContext2D;
  readonly #list = byId<HTMLDivElement>('function-list');
  readonly #legend = byId<HTMLUListElement>('graph-legend');
  readonly #coordinates = byId<HTMLDivElement>('graph-coordinates');
  readonly #summary = byId<HTMLParagraphElement>('graph-summary');
  readonly #rangeError = byId<HTMLParagraphElement>('range-error');
  readonly #renderTime = byId<HTMLSpanElement>('graph-render-time');
  readonly #rangeInputs = {
    xMin: byId<HTMLInputElement>('range-x-min'),
    xMax: byId<HTMLInputElement>('range-x-max'),
    yMin: byId<HTMLInputElement>('range-y-min'),
    yMax: byId<HTMLInputElement>('range-y-max'),
  };
  readonly #functions: RuntimeFunction[] = [];
  readonly #activePointers = new Map<number, { x: number; y: number }>();
  readonly #resizeObserver: ResizeObserver;
  readonly #onChange: ((detail: GraphChangeDetail) => void) | undefined;
  #range: ViewRange = { xMin: -10, xMax: 10, yMin: -7, yMax: 7 };
  #selectedId = '';
  #series: SampleSeries[] = [];
  #specialPoints: SpecialPoint[] = [];
  #snapPoint: (SamplePoint & { color: string; expression: string; label?: string }) | null = null;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #nextId = 1;

  constructor(onChange?: (detail: GraphChangeDetail) => void) {
    const context = this.canvas.getContext('2d');
    const baseContext = this.#baseCanvas.getContext('2d');
    if (!context || !baseContext) throw new Error('当前浏览器不支持 2D Canvas');
    this.#context = context;
    this.#baseContext = baseContext;
    this.#onChange = onChange;

    this.#bindControls();
    this.addFunction('sin(x)', SERIES_COLORS[0] ?? '#2563eb');
    this.autoFit();
    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.resize();
  }

  get range(): ViewRange {
    return { ...this.#range };
  }

  get selectedExpression(): string {
    const selected = this.#functions.find((item) => item.id === this.#selectedId);
    return selected?.compiled ? selected.expression.trim() : '';
  }

  get expressions(): string[] {
    return this.#functions.flatMap((item) =>
      item.compiled && item.expression.trim() ? [item.expression.trim()] : [],
    );
  }

  setActive(active: boolean): void {
    if (active) requestAnimationFrame(() => this.resize());
  }

  refreshTheme(): void {
    this.render();
  }

  addFunction(expression = 'x', color?: string): void {
    if (this.#functions.length >= MAX_FUNCTIONS) {
      byId<HTMLParagraphElement>('function-limit').textContent =
        `最多同时绘制 ${MAX_FUNCTIONS} 条函数。`;
      return;
    }
    byId<HTMLParagraphElement>('function-limit').textContent = '';
    const id = `function-${this.#nextId++}`;
    const runtime = this.#createFunctionRow(
      id,
      expression,
      color ?? SERIES_COLORS[this.#functions.length] ?? '#2563eb',
    );
    this.#functions.push(runtime);
    this.#list.append(runtime.row);
    this.#reindexFunctionRows();
    this.#selectFunction(id);
    this.#compile(runtime);
    runtime.input.focus({ preventScroll: true });
    this.render();
    this.#emitChange();
  }

  removeFunction(id: string): void {
    if (this.#functions.length <= 1) return;
    const index = this.#functions.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = this.#functions.splice(index, 1);
    removed?.row.remove();
    byId<HTMLParagraphElement>('function-limit').textContent = '';
    if (this.#selectedId === id) {
      const next = this.#functions[Math.max(0, index - 1)] ?? this.#functions[0];
      if (next) this.#selectFunction(next.id);
    }
    this.#reindexFunctionRows();
    this.render();
    this.#emitChange();
  }

  reset(): void {
    this.#range = { xMin: -10, xMax: 10, yMin: -7, yMax: 7 };
    this.#syncRangeInputs();
    this.#rangeError.textContent = '';
    this.render();
    this.#emitChange();
  }

  autoFit(): void {
    const compiled = this.#functions.flatMap((item) => (item.compiled ? [item.compiled] : []));
    const [yMin, yMax] = fitYRange(compiled, this.#range.xMin, this.#range.xMax);
    this.#range = { ...this.#range, yMin, yMax };
    this.#syncRangeInputs();
    this.render();
    this.#emitChange();
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.#width && height === this.#height && dpr === this.#dpr) return;
    this.#width = width;
    this.#height = height;
    this.#dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.#baseCanvas.width = this.canvas.width;
    this.#baseCanvas.height = this.canvas.height;
    this.render();
  }

  render(): void {
    if (this.#width < 10 || this.#height < 10) return;
    const started = performance.now();
    this.#snapPoint = null;
    this.#series = [];
    this.#specialPoints = [];
    this.#configureContext(this.#baseContext);
    this.#drawBackground();
    this.#drawGridAndAxes();
    this.#drawFunctions();
    this.#drawSpecialPoints();
    this.#copyBase();
    this.#renderLegend();
    this.#coordinates.textContent = '(0, 0)';
    const expressions = this.expressions;
    this.#summary.textContent = expressions.length
      ? `当前绘制 ${expressions.length} 条函数：${expressions.join('、')}。X 范围 ${formatNumber(this.#range.xMin)} 至 ${formatNumber(this.#range.xMax)}，Y 范围 ${formatNumber(this.#range.yMin)} 至 ${formatNumber(this.#range.yMax)}。`
      : '尚未绘制有效函数。';
    const elapsed = performance.now() - started;
    this.#renderTime.textContent = `${elapsed.toFixed(1)} ms`;
    this.canvas.dataset.renderMs = elapsed.toFixed(2);
  }

  destroy(): void {
    this.#resizeObserver.disconnect();
  }

  #bindControls(): void {
    byId<HTMLButtonElement>('add-function').addEventListener('click', () => this.addFunction());
    byId<HTMLButtonElement>('auto-fit').addEventListener('click', () => this.autoFit());
    byId<HTMLButtonElement>('graph-fit-toolbar').addEventListener('click', () => this.autoFit());
    byId<HTMLButtonElement>('reset-graph').addEventListener('click', () => this.reset());

    for (const input of Object.values(this.#rangeInputs)) {
      input.addEventListener('change', () => this.#applyRangeInputs());
    }

    this.canvas.addEventListener('pointerdown', (event) => this.#pointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.#pointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.#pointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.#pointerUp(event));
    this.canvas.addEventListener('pointerleave', () => {
      if (this.#activePointers.size === 0) this.#clearSnap();
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const factor = Math.min(2, Math.max(0.5, Math.exp(event.deltaY * 0.001)));
        this.#zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
    this.canvas.addEventListener('keydown', (event) => this.#keyboard(event));
  }

  #createFunctionRow(id: string, expression: string, color: string): RuntimeFunction {
    const row = document.createElement('div');
    row.className = 'function-row';
    row.dataset.functionId = id;

    const label = document.createElement('label');
    const inputId = `${id}-input`;
    label.className = 'function-label';
    label.htmlFor = inputId;
    label.textContent = `f${this.#functions.length + 1}(x)`;

    const input = document.createElement('input');
    input.id = inputId;
    input.className = 'function-input';
    input.type = 'text';
    input.value = expression;
    input.placeholder = '例如 sin(x)';
    input.spellcheck = false;
    input.setAttribute('aria-label', `${label.textContent} 表达式`);

    const colorInput = document.createElement('input');
    colorInput.className = 'color-picker';
    colorInput.type = 'color';
    colorInput.value = color;
    colorInput.setAttribute('aria-label', `${label.textContent} 颜色`);

    const removeButton = document.createElement('button');
    removeButton.className = 'remove-function';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.setAttribute('aria-label', `删除 ${label.textContent}`);

    const errorElement = document.createElement('p');
    errorElement.className = 'function-error';
    errorElement.setAttribute('aria-live', 'polite');

    row.append(label, input, colorInput, removeButton, errorElement);

    const runtime: RuntimeFunction = { id, expression, color, row, input, errorElement };
    const compileLater = debounce(() => {
      runtime.expression = input.value;
      this.#compile(runtime);
      this.render();
      this.#emitChange();
    }, 120);
    input.addEventListener('input', compileLater);
    input.addEventListener('focus', () => this.#selectFunction(id));
    row.addEventListener('pointerdown', () => this.#selectFunction(id));
    colorInput.addEventListener('input', () => {
      runtime.color = colorInput.value;
      this.render();
      this.#emitChange();
    });
    removeButton.addEventListener('click', () => this.removeFunction(id));
    return runtime;
  }

  #compile(runtime: RuntimeFunction): void {
    const result = compileExpression(runtime.expression, 'x');
    runtime.row.classList.toggle('has-error', !result.ok);
    runtime.input.setAttribute('aria-invalid', String(!result.ok));
    if (result.ok) {
      runtime.compiled = result.value;
      delete runtime.error;
      runtime.errorElement.textContent = '';
    } else {
      delete runtime.compiled;
      runtime.error = result.error.message;
      runtime.errorElement.textContent = result.error.message;
    }
  }

  #selectFunction(id: string): void {
    this.#selectedId = id;
    for (const item of this.#functions) item.row.classList.toggle('is-selected', item.id === id);
    this.#emitChange();
  }

  #reindexFunctionRows(): void {
    this.#functions.forEach((item, index) => {
      const text = `f${index + 1}(x)`;
      const label = item.row.querySelector<HTMLLabelElement>('.function-label');
      const color = item.row.querySelector<HTMLInputElement>('.color-picker');
      const remove = item.row.querySelector<HTMLButtonElement>('.remove-function');
      if (label) label.textContent = text;
      item.input.setAttribute('aria-label', `${text} 表达式`);
      color?.setAttribute('aria-label', `${text} 颜色`);
      if (remove) {
        remove.disabled = this.#functions.length === 1;
        remove.setAttribute(
          'aria-label',
          this.#functions.length === 1 ? `${text}（至少保留一个函数）` : `删除 ${text}`,
        );
      }
    });
  }

  #applyRangeInputs(): void {
    const candidate: ViewRange = {
      xMin: this.#rangeInputs.xMin.valueAsNumber,
      xMax: this.#rangeInputs.xMax.valueAsNumber,
      yMin: this.#rangeInputs.yMin.valueAsNumber,
      yMax: this.#rangeInputs.yMax.valueAsNumber,
    };
    const result = validateRange(candidate);
    for (const input of Object.values(this.#rangeInputs)) {
      input.setAttribute('aria-invalid', String(!result.ok));
    }
    if (!result.ok) {
      this.#rangeError.textContent = result.message;
      return;
    }
    this.#rangeError.textContent = '';
    this.#range = result.value;
    this.render();
    this.#emitChange();
  }

  #syncRangeInputs(): void {
    this.#rangeInputs.xMin.value = formatNumber(this.#range.xMin);
    this.#rangeInputs.xMax.value = formatNumber(this.#range.xMax);
    this.#rangeInputs.yMin.value = formatNumber(this.#range.yMin);
    this.#rangeInputs.yMax.value = formatNumber(this.#range.yMax);
  }

  #configureContext(context: CanvasRenderingContext2D): void {
    context.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    context.clearRect(0, 0, this.#width, this.#height);
  }

  #drawBackground(): void {
    const style = getComputedStyle(document.documentElement);
    this.#baseContext.fillStyle = style.getPropertyValue('--canvas').trim() || '#fbfcff';
    this.#baseContext.fillRect(0, 0, this.#width, this.#height);
  }

  #drawGridAndAxes(): void {
    const context = this.#baseContext;
    const style = getComputedStyle(document.documentElement);
    const dark = document.documentElement.dataset.theme === 'dark';
    const gridColor = dark ? 'rgba(160,174,205,.12)' : 'rgba(73,91,133,.10)';
    const axisColor = style.getPropertyValue('--text-soft').trim() || '#61677d';
    const xStep = this.#niceStep(this.#range.xMax - this.#range.xMin);
    const yStep = this.#niceStep(this.#range.yMax - this.#range.yMin);
    context.lineWidth = 1;
    context.strokeStyle = gridColor;
    context.beginPath();
    for (let x = Math.ceil(this.#range.xMin / xStep) * xStep; x <= this.#range.xMax; x += xStep) {
      const cx = this.#toCanvasX(x);
      context.moveTo(cx, 0);
      context.lineTo(cx, this.#height);
    }
    for (let y = Math.ceil(this.#range.yMin / yStep) * yStep; y <= this.#range.yMax; y += yStep) {
      const cy = this.#toCanvasY(y);
      context.moveTo(0, cy);
      context.lineTo(this.#width, cy);
    }
    context.stroke();

    const originX = this.#toCanvasX(0);
    const originY = this.#toCanvasY(0);
    context.strokeStyle = axisColor;
    context.lineWidth = 1.4;
    context.beginPath();
    if (originY >= 0 && originY <= this.#height) {
      context.moveTo(0, originY);
      context.lineTo(this.#width, originY);
    }
    if (originX >= 0 && originX <= this.#width) {
      context.moveTo(originX, 0);
      context.lineTo(originX, this.#height);
    }
    context.stroke();

    context.fillStyle = axisColor;
    context.font = '11px "Noto Sans SC Variable", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const labelY = Math.min(this.#height - 18, Math.max(5, originY + 6));
    for (let x = Math.ceil(this.#range.xMin / xStep) * xStep; x <= this.#range.xMax; x += xStep) {
      if (Math.abs(x) < xStep * 0.01) continue;
      context.fillText(
        formatNumber(x, 3),
        Math.min(this.#width - 22, Math.max(22, this.#toCanvasX(x))),
        labelY,
      );
    }
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    const labelX = Math.min(this.#width - 5, Math.max(34, originX - 6));
    for (let y = Math.ceil(this.#range.yMin / yStep) * yStep; y <= this.#range.yMax; y += yStep) {
      if (Math.abs(y) < yStep * 0.01) continue;
      context.fillText(formatNumber(y, 3), labelX, this.#toCanvasY(y));
    }
  }

  #drawFunctions(): void {
    const context = this.#baseContext;
    const sampleCount = Math.min(1800, Math.max(600, Math.round(this.#width * 1.5)));
    const ySpan = this.#range.yMax - this.#range.yMin;
    for (const runtime of this.#functions) {
      if (!runtime.compiled) continue;
      const points: Array<SamplePoint | null> = [];
      context.beginPath();
      context.strokeStyle = runtime.color;
      context.lineWidth = 2.5;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      let previous: SamplePoint | null = null;
      for (let index = 0; index <= sampleCount; index += 1) {
        const x = this.#range.xMin + (index / sampleCount) * (this.#range.xMax - this.#range.xMin);
        const y = runtime.compiled.evaluate(x);
        const visible =
          Number.isFinite(y) && y >= this.#range.yMin - ySpan && y <= this.#range.yMax + ySpan;
        if (!visible) {
          points.push(null);
          previous = null;
          continue;
        }
        const point: SamplePoint = { x, y, cx: this.#toCanvasX(x), cy: this.#toCanvasY(y) };
        points.push(point);
        if (!previous || Math.abs(point.cy - previous.cy) > this.#height * 0.8) {
          context.moveTo(point.cx, point.cy);
        } else {
          context.lineTo(point.cx, point.cy);
        }
        previous = point;
      }
      context.stroke();
      const series: SampleSeries = { runtime, points, sampleCount };
      this.#series.push(series);
      this.#collectSpecialPoints(series);
    }
  }

  #collectSpecialPoints(series: SampleSeries): void {
    const expression = series.runtime.compiled;
    if (!expression) return;
    const points = analyzeSampledKeyPoints(
      expression,
      series.points,
      this.#range.xMin,
      this.#range.xMax,
    );
    const labels = {
      root: '零点',
      maximum: '极大值',
      minimum: '极小值',
      'y-intercept': 'Y 截距',
    } as const;
    for (const point of points) {
      if (point.y < this.#range.yMin || point.y > this.#range.yMax) continue;
      this.#pushSpecial({
        ...point,
        cx: this.#toCanvasX(point.x),
        cy: this.#toCanvasY(point.y),
        color: series.runtime.color,
        label: labels[point.type],
      });
    }
  }

  #pushSpecial(point: SpecialPoint): void {
    if (point.cx < 0 || point.cx > this.#width || point.cy < 0 || point.cy > this.#height) return;
    const duplicate = this.#specialPoints.some(
      (existing) => Math.hypot(existing.cx - point.cx, existing.cy - point.cy) < 7,
    );
    if (!duplicate) this.#specialPoints.push(point);
  }

  #drawSpecialPoints(): void {
    const context = this.#baseContext;
    for (const point of this.#specialPoints) {
      context.beginPath();
      context.arc(point.cx, point.cy, 4.5, 0, Math.PI * 2);
      context.fillStyle = point.color;
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
  }

  #renderLegend(): void {
    const fragment = document.createDocumentFragment();
    for (const runtime of this.#functions) {
      if (!runtime.compiled) continue;
      const item = document.createElement('li');
      item.className = 'legend-item';
      const line = document.createElement('span');
      line.className = 'legend-line';
      line.style.backgroundColor = runtime.color;
      const text = document.createElement('span');
      text.className = 'legend-expression';
      text.textContent = runtime.expression;
      item.append(line, text);
      fragment.append(item);
    }
    this.#legend.replaceChildren(fragment);
  }

  #copyBase(): void {
    this.#context.setTransform(1, 0, 0, 1, 0, 0);
    this.#context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#context.drawImage(this.#baseCanvas, 0, 0);
    this.#context.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
  }

  #drawOverlay(): void {
    this.#copyBase();
    const point = this.#snapPoint;
    if (!point) return;
    const context = this.#context;
    context.save();
    context.strokeStyle = 'rgba(100,110,140,.28)';
    context.setLineDash([4, 5]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(point.cx, 0);
    context.lineTo(point.cx, this.#height);
    context.moveTo(0, point.cy);
    context.lineTo(this.#width, point.cy);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.arc(point.cx, point.cy, 7, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = point.color;
    context.stroke();
    context.restore();
  }

  #pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.setPointerCapture(event.pointerId);
    this.#activePointers.set(event.pointerId, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    this.#clearSnap();
  }

  #pointerMove(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const position = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const previous = this.#activePointers.get(event.pointerId);
    if (!previous) {
      if (event.pointerType === 'mouse') this.#updateSnap(position.x, position.y);
      return;
    }

    if (this.#activePointers.size >= 2) {
      const otherEntry = [...this.#activePointers.entries()].find(([id]) => id !== event.pointerId);
      const other = otherEntry?.[1];
      if (other) {
        const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
        const newDistance = Math.hypot(position.x - other.x, position.y - other.y);
        this.#activePointers.set(event.pointerId, position);
        if (oldDistance > 1 && newDistance > 1) {
          this.#zoomAt(
            oldDistance / newDistance,
            (position.x + other.x) / 2,
            (position.y + other.y) / 2,
            false,
          );
        }
      }
      return;
    }

    this.#activePointers.set(event.pointerId, position);
    this.#panBy(position.x - previous.x, position.y - previous.y, false);
  }

  #pointerUp(event: PointerEvent): void {
    this.#activePointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    this.#syncRangeInputs();
    this.#emitChange();
  }

  #panBy(deltaX: number, deltaY: number, emit = true): void {
    const xShift = (-deltaX / this.#width) * (this.#range.xMax - this.#range.xMin);
    const yShift = (deltaY / this.#height) * (this.#range.yMax - this.#range.yMin);
    const candidate: ViewRange = {
      xMin: this.#range.xMin + xShift,
      xMax: this.#range.xMax + xShift,
      yMin: this.#range.yMin + yShift,
      yMax: this.#range.yMax + yShift,
    };
    if (!validateRange(candidate).ok) return;
    this.#range = candidate;
    this.render();
    if (emit) {
      this.#syncRangeInputs();
      this.#emitChange();
    }
  }

  #zoomAt(factor: number, canvasX: number, canvasY: number, emit = true): void {
    const centerX = this.#toMathX(canvasX);
    const centerY = this.#toMathY(canvasY);
    const candidate: ViewRange = {
      xMin: centerX - (centerX - this.#range.xMin) * factor,
      xMax: centerX + (this.#range.xMax - centerX) * factor,
      yMin: centerY - (centerY - this.#range.yMin) * factor,
      yMax: centerY + (this.#range.yMax - centerY) * factor,
    };
    if (!validateRange(candidate).ok) return;
    this.#range = candidate;
    this.render();
    if (emit) {
      this.#syncRangeInputs();
      this.#emitChange();
    }
  }

  #keyboard(event: KeyboardEvent): void {
    if (event.key === 'Home') this.reset();
    else if (event.key === 'ArrowLeft') this.#panBy(this.#width * 0.08, 0);
    else if (event.key === 'ArrowRight') this.#panBy(-this.#width * 0.08, 0);
    else if (event.key === 'ArrowUp') this.#panBy(0, this.#height * 0.08);
    else if (event.key === 'ArrowDown') this.#panBy(0, -this.#height * 0.08);
    else if (event.key === '+' || event.key === '=')
      this.#zoomAt(0.82, this.#width / 2, this.#height / 2);
    else if (event.key === '-' || event.key === '_')
      this.#zoomAt(1.22, this.#width / 2, this.#height / 2);
    else return;
    event.preventDefault();
  }

  #updateSnap(canvasX: number, canvasY: number): void {
    let best: (SamplePoint & { color: string; expression: string; label?: string }) | null = null;
    let distance = 18;
    for (const point of this.#specialPoints) {
      const candidateDistance = Math.hypot(point.cx - canvasX, point.cy - canvasY);
      if (candidateDistance < distance) {
        distance = candidateDistance;
        best = { ...point, expression: '', label: point.label };
      }
    }
    const mathX = this.#toMathX(canvasX);
    for (const series of this.#series) {
      const ratio = (mathX - this.#range.xMin) / (this.#range.xMax - this.#range.xMin);
      const index = Math.round(ratio * series.sampleCount);
      for (let offset = -2; offset <= 2; offset += 1) {
        const point = series.points[index + offset];
        if (!point) continue;
        const candidateDistance = Math.hypot(point.cx - canvasX, point.cy - canvasY);
        if (candidateDistance < distance) {
          distance = candidateDistance;
          best = { ...point, color: series.runtime.color, expression: series.runtime.expression };
        }
      }
    }
    this.#snapPoint = best;
    this.#drawOverlay();
    if (best) {
      const prefix = best.label ? `${best.label} · ` : '';
      this.#coordinates.textContent = `${prefix}(${formatNumber(best.x)}, ${formatNumber(best.y)})`;
    } else {
      this.#coordinates.textContent = `(${formatNumber(mathX)}, ${formatNumber(this.#toMathY(canvasY))})`;
    }
  }

  #clearSnap(): void {
    const hadOverlay = Boolean(this.#snapPoint);
    this.#snapPoint = null;
    this.#coordinates.textContent = '(0, 0)';
    if (hadOverlay) this.#copyBase();
  }

  #niceStep(range: number): number {
    const rough = range / 8;
    const power = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / power;
    const factor = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return factor * power;
  }

  #toCanvasX(value: number): number {
    return ((value - this.#range.xMin) / (this.#range.xMax - this.#range.xMin)) * this.#width;
  }

  #toCanvasY(value: number): number {
    return (
      this.#height -
      ((value - this.#range.yMin) / (this.#range.yMax - this.#range.yMin)) * this.#height
    );
  }

  #toMathX(value: number): number {
    return this.#range.xMin + (value / this.#width) * (this.#range.xMax - this.#range.xMin);
  }

  #toMathY(value: number): number {
    return this.#range.yMax - (value / this.#height) * (this.#range.yMax - this.#range.yMin);
  }

  #emitChange(): void {
    this.#onChange?.({
      functions: this.#functions.map(({ id, expression, color, error }) => {
        const item: GraphFunction = { id, expression, color };
        if (error) item.error = error;
        return item;
      }),
      selectedId: this.#selectedId,
      range: { ...this.#range },
    });
  }
}
