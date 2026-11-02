import { byId, debounce, formatNumber } from '../core/dom';
import { compileExpression } from '../core/expression';
import { analyzeSampledKeyPoints, computeDerivative, fitYRange, validateRange } from '../core/math';
import type { CompiledExpression, GraphFunction, ViewRange } from '../types';
import { samplePlot, type PlotPoint, type DensityBand, type SampledPlot } from '../core/sampling';
import type { GraphProject } from '../core/projects';

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
const SPECIAL_POINT_X_GAP_PX = 18;
const MAX_SPECIAL_POINTS_PER_SERIES = 16;

interface RuntimeFunction extends GraphFunction {
  compiled?: CompiledExpression;
  row: HTMLDivElement;
  input: HTMLInputElement;
  errorElement: HTMLParagraphElement;
  sampleCache?: { key: string; value: SampledPlot };
}

type SamplePoint = PlotPoint;
type EnvelopeSegment = DensityBand;

interface SampleSeries {
  runtime: RuntimeFunction;
  points: Array<SamplePoint | null>;
  validPoints: SamplePoint[];
  envelopes: EnvelopeSegment[];
}

interface SpecialPoint extends SamplePoint {
  color: string;
  label: string;
}

interface SnapPoint extends SamplePoint {
  color: string;
  expression: string;
  label?: string | undefined;
  derivative?: number | undefined;
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
  #snapPoint: SnapPoint | null = null;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #nextId = 1;
  #quality: 'balanced' | 'precise' = 'balanced';
  #restoring = false;

  snapshot(name: string): GraphProject {
    // Read live inputs so an export immediately after typing never loses the last edit.
    return {
      schemaVersion: 1,
      name: name.trim() || '未命名项目',
      functions: this.#functions.map((item) => ({
        expression: item.input.value,
        color: item.color,
      })),
      range: this.range,
      selectedIndex: Math.max(
        0,
        this.#functions.findIndex((item) => item.id === this.#selectedId),
      ),
      quality: this.#quality,
    };
  }

  restore(project: GraphProject): void {
    this.#restoring = true;
    for (const item of this.#functions) item.row.remove();
    this.#functions.length = 0;
    this.#range = { ...project.range };
    this.#quality = project.quality;
    byId<HTMLSelectElement>('graph-quality').value = this.#quality;
    for (const item of project.functions) this.addFunction(item.expression, item.color, false);
    const selected = this.#functions[project.selectedIndex];
    if (selected) this.#selectFunction(selected.id);
    this.#restoring = false;
    this.#syncRangeInputs();
    this.#rangeError.textContent = '';
    this.render();
    this.#emitChange();
  }

  exportImage(): Promise<Blob | null> {
    for (const item of this.#functions) {
      item.expression = item.input.value;
      this.#compile(item);
    }
    this.render();
    const output = document.createElement('canvas');
    output.width = this.#baseCanvas.width;
    output.height = this.#baseCanvas.height + (this.#functions.length * 24 + 54) * this.#dpr;
    const context = output.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--canvas')
      .trim();
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(this.#baseCanvas, 0, 0);
    context.scale(this.#dpr, this.#dpr);
    context.font = '12px sans-serif';
    this.#functions.forEach((item, index) => {
      context.fillStyle = item.color;
      context.fillText(
        `f${index + 1}(x) = ${item.expression}`,
        16,
        this.#height + 24 + index * 24,
        this.#width - 32,
      );
    });
    context.fillStyle = '#737a8c';
    context.fillText(
      `Math Studio · ${new Date().toISOString()} · 阴影为采样估计`,
      16,
      this.#height + 32 + this.#functions.length * 24,
      this.#width - 32,
    );
    return new Promise((resolve) => output.toBlob(resolve, 'image/png'));
  }

  constructor(onChange?: (detail: GraphChangeDetail) => void) {
    const context = this.canvas.getContext('2d');
    const baseContext = this.#baseCanvas.getContext('2d');
    if (!context || !baseContext) throw new Error('当前浏览器不支持 2D Canvas');
    this.#context = context;
    this.#baseContext = baseContext;
    this.#onChange = onChange;

    this.#bindControls();
    this.addFunction('sin(x)', SERIES_COLORS[0] ?? '#2563eb', false);
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

  addFunction(expression = 'x', color?: string, focus = true): void {
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
    if (focus) runtime.input.focus({ preventScroll: true });
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

  insertAtSelected(text: string): void {
    const selected =
      this.#functions.find((item) => item.id === this.#selectedId) ?? this.#functions[0];
    if (!selected) return;
    const input = selected.input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const previous = input.value;
    input.value = previous.slice(0, start) + text + previous.slice(end);
    const newPos = start + text.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
    selected.expression = input.value;
    this.#compile(selected);
    this.render();
    this.#emitChange();
  }

  setFunctionExpression(id: string, expression: string): void {
    const target = this.#functions.find((item) => item.id === id) ?? this.#functions[0];
    if (!target) return;
    target.input.value = expression;
    target.expression = expression;
    this.#compile(target);
    this.render();
    this.#emitChange();
  }

  async downloadImage(filename = 'math-studio-2d-graph.png'): Promise<void> {
    const blob = await this.exportImage();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (this.#restoring || this.#width < 10 || this.#height < 10) return;
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
    byId<HTMLSelectElement>('graph-quality').addEventListener('change', (event) => {
      this.#quality =
        (event.target as HTMLSelectElement).value === 'precise' ? 'precise' : 'balanced';
      this.render();
      this.#emitChange();
    });
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
    input.maxLength = 200;
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
      if (!this.#functions.includes(runtime)) return;
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
    const value = (key: keyof ViewRange): number => {
      const input = this.#rangeInputs[key];
      return input.value === input.dataset.displayValue ? this.#range[key] : input.valueAsNumber;
    };
    const candidate: ViewRange = {
      xMin: value('xMin'),
      xMax: value('xMax'),
      yMin: value('yMin'),
      yMax: value('yMax'),
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
    for (const key of Object.keys(this.#rangeInputs) as Array<keyof ViewRange>) {
      this.#rangeInputs[key].value = formatNumber(this.#range[key], 6);
      this.#rangeInputs[key].dataset.displayValue = this.#rangeInputs[key].value;
      this.#rangeInputs[key].title = String(this.#range[key]);
      this.#rangeInputs[key].setAttribute('aria-invalid', 'false');
    }
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
    for (const x of this.#ticks(this.#range.xMin, this.#range.xMax, xStep)) {
      const cx = this.#toCanvasX(x);
      context.moveTo(cx, 0);
      context.lineTo(cx, this.#height);
    }
    for (const y of this.#ticks(this.#range.yMin, this.#range.yMax, yStep)) {
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
    for (const x of this.#ticks(this.#range.xMin, this.#range.xMax, xStep)) {
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
    for (const y of this.#ticks(this.#range.yMin, this.#range.yMax, yStep)) {
      if (Math.abs(y) < yStep * 0.01) continue;
      context.fillText(formatNumber(y, 3), labelX, this.#toCanvasY(y));
    }
  }

  #drawFunctions(): void {
    const context = this.#baseContext;
    let envelopeCount = 0;
    let evaluations = 0;
    let limited = false;
    for (const runtime of this.#functions) {
      if (!runtime.compiled) continue;
      const cacheKey = JSON.stringify([
        runtime.expression,
        this.#range,
        this.#width,
        this.#height,
        this.#quality,
      ]);
      const samples =
        runtime.sampleCache?.key === cacheKey
          ? runtime.sampleCache.value
          : samplePlot(
              runtime.compiled,
              this.#range,
              this.#width,
              this.#height,
              this.#quality === 'precise' ? 32_000 : 16_000,
            );
      runtime.sampleCache = { key: cacheKey, value: samples };
      const series: SampleSeries = {
        runtime,
        points: samples.points,
        envelopes: samples.envelopes,
        validPoints: samples.points.filter((point): point is SamplePoint => point !== null),
      };
      evaluations += samples.evaluations;
      limited ||= samples.limited;
      context.beginPath();
      context.strokeStyle = runtime.color;
      context.lineWidth = 2.5;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      let previous: SamplePoint | null = null;
      for (const point of series.points) {
        if (!point) {
          previous = null;
          continue;
        }
        if (!previous) {
          context.moveTo(point.cx, point.cy);
        } else {
          context.lineTo(point.cx, point.cy);
        }
        previous = point;
      }
      context.stroke();
      this.#drawEnvelopes(context, runtime.color, series.envelopes);
      envelopeCount += series.envelopes.length;
      this.#series.push(series);
      this.#collectSpecialPoints(series);
    }
    this.canvas.dataset.envelopeCount = String(envelopeCount);
    this.canvas.dataset.evaluations = String(evaluations);
    this.canvas.dataset.qualityLimited = String(limited);
    byId<HTMLElement>('graph-quality-status').textContent = envelopeCount
      ? `密集区域以半透明采样带显示；不代表精确值域，放大可查看细节。${limited ? '部分区间达到采样上限。' : ''}`
      : limited
        ? '部分区间达到采样上限，已断开不确定连线；请放大或选择精细采样。'
        : '未定义点与不确定的间断处断开显示；图像为有限采样近似。';
  }

  #drawEnvelopes(
    context: CanvasRenderingContext2D,
    color: string,
    envelopes: EnvelopeSegment[],
  ): void {
    if (!envelopes.length) return;
    const joinedEnvelopes = envelopes;
    context.save();
    context.beginPath();
    for (const envelope of joinedEnvelopes) {
      context.moveTo(envelope.leftCx, envelope.minCy);
      context.lineTo(envelope.rightCx, envelope.minCy);
      context.lineTo(envelope.rightCx, envelope.maxCy);
      context.lineTo(envelope.leftCx, envelope.maxCy);
      context.closePath();
    }
    context.fillStyle = color;
    context.globalAlpha = 0.1;
    context.fill();

    context.beginPath();
    context.strokeStyle = color;
    context.globalAlpha = 0.3;
    context.lineWidth = 1;
    context.lineCap = 'round';
    for (const envelope of joinedEnvelopes) {
      context.moveTo(envelope.leftCx, envelope.minCy);
      context.lineTo(envelope.rightCx, envelope.minCy);
      context.moveTo(envelope.leftCx, envelope.maxCy);
      context.lineTo(envelope.rightCx, envelope.maxCy);
    }
    context.stroke();

    context.beginPath();
    context.globalAlpha = 0.16;
    context.lineWidth = 1.5;
    for (const envelope of joinedEnvelopes) {
      const centerCx = (envelope.leftCx + envelope.rightCx) / 2;
      context.moveTo(centerCx, envelope.minCy);
      context.lineTo(centerCx, envelope.maxCy);
    }
    context.stroke();
    context.restore();
  }

  #collectSpecialPoints(series: SampleSeries): void {
    const expression = series.runtime.compiled;
    if (!expression || series.envelopes.length > 4) return;
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
    const visiblePoints: typeof points = [];
    for (const point of points) {
      if (point.y < this.#range.yMin || point.y > this.#range.yMax) continue;
      const crowded = visiblePoints.some(
        (existing) =>
          Math.abs(this.#toCanvasX(existing.x) - this.#toCanvasX(point.x)) < SPECIAL_POINT_X_GAP_PX,
      );
      if (crowded) continue;
      visiblePoints.push(point);
      if (visiblePoints.length >= MAX_SPECIAL_POINTS_PER_SERIES) break;
    }
    for (const point of visiblePoints.slice(0, MAX_SPECIAL_POINTS_PER_SERIES)) {
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

    if (point.derivative !== undefined && Number.isFinite(point.derivative)) {
      context.save();
      context.strokeStyle = point.color;
      context.lineWidth = 1.5;
      context.setLineDash([4, 4]);

      const xSpan = this.#range.xMax - this.#range.xMin;
      const dxMath = (50 / Math.max(this.#width, 1)) * xSpan;
      const x1 = point.x - dxMath;
      const y1 = point.y - point.derivative * dxMath;
      const x2 = point.x + dxMath;
      const y2 = point.y + point.derivative * dxMath;

      context.beginPath();
      context.moveTo(this.#toCanvasX(x1), this.#toCanvasY(y1));
      context.lineTo(this.#toCanvasX(x2), this.#toCanvasY(y2));
      context.stroke();
      context.restore();
    }

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
    let best: SnapPoint | null = null;
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
      const index = this.#findSampleIndex(series.validPoints, mathX);
      for (let offset = -2; offset <= 2; offset += 1) {
        const point = series.validPoints[index + offset];
        if (!point) continue;
        const candidateDistance = Math.hypot(point.cx - canvasX, point.cy - canvasY);
        if (candidateDistance < distance) {
          distance = candidateDistance;
          const derivative = series.runtime.compiled
            ? computeDerivative(series.runtime.compiled, point.x)
            : undefined;
          best = {
            ...point,
            color: series.runtime.color,
            expression: series.runtime.expression,
            derivative,
          };
        }
      }
    }
    this.#snapPoint = best;
    this.#drawOverlay();
    if (best) {
      const prefix = best.label ? `${best.label} · ` : '';
      const slopeText =
        best.derivative !== undefined && Number.isFinite(best.derivative)
          ? `  |  f'(x) = ${formatNumber(best.derivative)}`
          : '';
      this.#coordinates.textContent = `${prefix}(${formatNumber(best.x)}, ${formatNumber(best.y)})${slopeText}`;
    } else {
      this.#coordinates.textContent = `(${formatNumber(mathX)}, ${formatNumber(this.#toMathY(canvasY))})`;
    }
  }

  #findSampleIndex(points: SamplePoint[], x: number): number {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const point = points[middle];
      if (!point || point.x < x) low = middle + 1;
      else high = middle;
    }
    return Math.min(Math.max(low, 0), Math.max(points.length - 1, 0));
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

  #ticks(minimum: number, maximum: number, step: number): number[] {
    const start = Math.ceil(minimum / step) * step;
    const count = Math.min(32, Math.max(0, Math.floor((maximum - start) / step) + 1));
    return Array.from({ length: count }, (_, index) => start + index * step);
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
    if (this.#restoring) return;
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
