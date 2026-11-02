import {
  AmbientLight,
  ArrowHelper,
  AxesHelper,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { byId, debounce, formatNumber } from '../core/dom';
import { compileExpression } from '../core/expression';
import { calculateVector, MAX_RANGE_SPAN, validateVector, type VectorResult } from '../core/math';
import type { CurveDefinition, VectorOperation, VectorValues } from '../types';

const CURVE_COLOR = 0x06b6d4;
const VECTOR_A_COLOR = 0x2563eb;
const VECTOR_B_COLOR = 0xf97316;
const VECTOR_RESULT_COLOR = 0x8b5cf6;
const EPSILON = 1e-10;

interface CurvePreset extends CurveDefinition {
  label: string;
}

interface SceneHandle {
  readonly canvas: HTMLCanvasElement;
  readonly available: boolean;
  setActive(active: boolean): void;
  refreshTheme(): void;
  resetCamera(): void;
  setCurve(points: Vector3[]): void;
  setVectors(values: VectorValues, result: VectorResult): void;
  exportImage(filename?: string): void;
  dispose(): void;
}

const CURVE_PRESETS: Record<string, CurvePreset> = {
  helix: {
    label: '螺旋线',
    x: 'cos(t)',
    y: 'sin(t)',
    z: 't/10',
    tMin: 0,
    tMax: 62.8,
  },
  trefoil: {
    label: '三叶结',
    x: '(2+cos(3t))*cos(2t)',
    y: '(2+cos(3t))*sin(2t)',
    z: 'sin(3t)',
    tMin: 0,
    tMax: 6.283,
  },
  lissajous: {
    label: '利萨如曲线',
    x: 'sin(3t+pi/2)',
    y: 'sin(4t)',
    z: 'sin(5t)',
    tMin: 0,
    tMax: 6.283,
  },
  sphere: {
    label: '球面螺线',
    x: 'cos(t)*sin(t/20)',
    y: 'sin(t)*sin(t/20)',
    z: 'cos(t/20)',
    tMin: 0,
    tMax: 62.832,
  },
};

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) item.dispose();
    return;
  }
  material.dispose();
}

function disposeObject(object: Object3D): void {
  object.traverse((child) => {
    const disposable = child as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };
    disposable.geometry?.dispose();
    if (disposable.material) disposeMaterial(disposable.material);
  });
}

class MathScene implements SceneHandle {
  readonly canvas: HTMLCanvasElement;
  readonly available = true;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(42, 1, 0.01, 1e9);
  readonly #renderer: WebGLRenderer;
  readonly #controls: OrbitControls;
  readonly #dynamic = new Group();
  readonly #grid: GridHelper;
  readonly #resizeObserver: ResizeObserver;
  #active = false;
  #width = 0;
  #height = 0;
  #defaultDistance = 8;
  #renderCount = 0;

  constructor(canvas: HTMLCanvasElement, context: WebGLRenderingContext | WebGL2RenderingContext) {
    this.canvas = canvas;
    this.#renderer = new WebGLRenderer({
      canvas,
      context,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.#renderer.outputColorSpace = 'srgb';
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.#camera.position.set(5.5, 4.2, 6.5);
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enableDamping = false;
    this.#controls.enablePan = true;
    this.#controls.minDistance = 0.01;
    this.#controls.maxDistance = 1e8;
    this.#controls.addEventListener('change', () => this.render());

    const ambient = new AmbientLight(0xffffff, 1.45);
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(6, 8, 7);
    const fill = new DirectionalLight(0x8ab4ff, 0.75);
    fill.position.set(-7, 2, -5);
    this.#grid = new GridHelper(12, 24, 0x74809d, 0xb8bfd0);
    this.#grid.position.y = 0;
    const axes = new AxesHelper(4);
    this.#scene.add(ambient, key, fill, this.#grid, axes, this.#dynamic);
    this.refreshTheme();

    this.#resizeObserver = new ResizeObserver(() => this.resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    canvas.addEventListener('keydown', (event) => this.#keyboard(event));
    document.addEventListener('visibilitychange', this.#visibilityChanged);
  }

  setActive(active: boolean): void {
    this.#active = active;
    if (active) {
      requestAnimationFrame(() => {
        this.resize();
        this.render();
      });
    }
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      width === this.#width &&
      height === this.#height &&
      this.#renderer.getPixelRatio() === dpr
    ) {
      return;
    }
    this.#width = width;
    this.#height = height;
    this.#renderer.setPixelRatio(dpr);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.render();
  }

  render(): void {
    if (!this.#active || document.visibilityState === 'hidden' || this.#width < 10) return;
    this.#renderer.render(this.#scene, this.#camera);
    this.#renderCount += 1;
    this.canvas.dataset.renderCount = String(this.#renderCount);
  }

  refreshTheme(): void {
    const dark = document.documentElement.dataset.theme === 'dark';
    this.#scene.background = new Color(dark ? 0x101522 : 0xf8faff);
    const materials = Array.isArray(this.#grid.material)
      ? this.#grid.material
      : [this.#grid.material];
    const [primary, secondary] = materials;
    if (primary && 'color' in primary) primary.color.set(dark ? 0x4d5c7b : 0x8792ac);
    if (secondary && 'color' in secondary) secondary.color.set(dark ? 0x263148 : 0xd9deea);
    this.render();
  }

  clearDynamic(): void {
    for (const child of [...this.#dynamic.children]) {
      this.#dynamic.remove(child);
      disposeObject(child);
    }
  }

  setCurve(points: Vector3[]): void {
    this.clearDynamic();
    const geometry = new BufferGeometry().setFromPoints(points);
    const material = new LineBasicMaterial({ color: CURVE_COLOR });
    this.#dynamic.add(new Line(geometry, material));

    const pointGeometry = new SphereGeometry(1, 18, 12);
    const pointMaterial = new MeshStandardMaterial({ color: CURVE_COLOR, roughness: 0.28 });
    const start = new Mesh(pointGeometry, pointMaterial);
    const bounds = new Box3().setFromPoints(points);
    const size = bounds.getSize(new Vector3()).length();
    const markerSize = Math.max(size * 0.012, 0.018);
    start.scale.setScalar(markerSize);
    start.position.copy(points[0] ?? new Vector3());
    this.#dynamic.add(start);
    this.fitToDynamic();
  }

  setVectors(values: VectorValues, result: VectorResult): void {
    this.clearDynamic();
    const origin = new Vector3();
    const a = new Vector3(...values.a);
    const b = new Vector3(...values.b);
    this.#addArrow(origin, a, VECTOR_A_COLOR, 'A');
    this.#addArrow(origin, b, VECTOR_B_COLOR, 'B');

    if (result.vector) {
      const output = new Vector3(...result.vector);
      this.#addArrow(origin, output, VECTOR_RESULT_COLOR, 'R');
      if (
        (result.operation === 'add' || result.operation === 'subtract') &&
        result.helperEndpoint
      ) {
        const helper = new Vector3(...result.helperEndpoint);
        this.#addDashedSegment(a, a.clone().add(helper), VECTOR_B_COLOR);
        this.#addDashedSegment(helper, helper.clone().add(a), VECTOR_A_COLOR);
      }
    }
    this.fitToDynamic();
  }

  fitToDynamic(): void {
    const box = new Box3().setFromObject(this.#dynamic);
    if (box.isEmpty()) {
      this.#defaultDistance = 8;
      this.resetCamera();
      return;
    }
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.length() / 2, 0.75);
    const fov = (this.#camera.fov * Math.PI) / 180;
    const distance = Math.max((radius / Math.sin(fov / 2)) * 1.18, 2);
    this.#defaultDistance = distance;
    this.#controls.target.copy(center);
    this.#camera.near = Math.max(distance / 10_000, 0.001);
    this.#camera.far = Math.max(distance * 10_000, 100);
    this.#camera.position
      .copy(center)
      .add(new Vector3(0.9, 0.65, 1).normalize().multiplyScalar(distance));
    this.#camera.updateProjectionMatrix();
    this.#controls.update();
    this.render();
  }

  resetCamera(): void {
    const center = new Box3().setFromObject(this.#dynamic).getCenter(new Vector3());
    if (!Number.isFinite(center.x)) center.set(0, 0, 0);
    this.#controls.target.copy(center);
    this.#camera.position
      .copy(center)
      .add(new Vector3(0.9, 0.65, 1).normalize().multiplyScalar(this.#defaultDistance));
    this.#camera.updateProjectionMatrix();
    this.#controls.update();
    this.render();
  }

  exportImage(filename = 'math-studio-scene.png'): void {
    this.#renderer.render(this.#scene, this.#camera);
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.#visibilityChanged);
    this.#resizeObserver.disconnect();
    this.#controls.dispose();
    this.clearDynamic();
    this.#renderer.dispose();
  }

  #addArrow(origin: Vector3, vector: Vector3, color: number, label: string): void {
    const length = vector.length();
    if (length <= EPSILON) {
      const geometry = new SphereGeometry(0.09, 16, 12);
      const material = new MeshStandardMaterial({ color, roughness: 0.35 });
      const marker = new Mesh(geometry, material);
      marker.name = `${label}-zero-vector`;
      marker.position.copy(origin);
      this.#dynamic.add(marker);
      return;
    }
    const headLength = Math.min(length * 0.22, Math.max(length * 0.08, 0.35));
    const headWidth = headLength * 0.48;
    const arrow = new ArrowHelper(
      vector.clone().normalize(),
      origin,
      length,
      color,
      headLength,
      headWidth,
    );
    arrow.name = label;
    this.#dynamic.add(arrow);
  }

  #addDashedSegment(start: Vector3, end: Vector3, color: number): void {
    const geometry = new BufferGeometry().setFromPoints([start, end]);
    const material = new LineDashedMaterial({
      color,
      dashSize: 0.16,
      gapSize: 0.1,
      opacity: 0.72,
      transparent: true,
    });
    const line = new Line(geometry, material);
    line.computeLineDistances();
    this.#dynamic.add(line);
  }

  #keyboard(event: KeyboardEvent): void {
    const offset = this.#camera.position.clone().sub(this.#controls.target);
    const spherical = {
      radius: offset.length(),
      theta: Math.atan2(offset.x, offset.z),
      phi: Math.acos(Math.max(-1, Math.min(1, offset.y / Math.max(offset.length(), EPSILON)))),
    };
    const rotateStep = Math.PI / 18;
    if (event.key === 'ArrowLeft') spherical.theta -= rotateStep;
    else if (event.key === 'ArrowRight') spherical.theta += rotateStep;
    else if (event.key === 'ArrowUp') spherical.phi = Math.max(0.08, spherical.phi - rotateStep);
    else if (event.key === 'ArrowDown')
      spherical.phi = Math.min(Math.PI - 0.08, spherical.phi + rotateStep);
    else if (event.key === '+' || event.key === '=') spherical.radius *= 0.82;
    else if (event.key === '-' || event.key === '_') spherical.radius *= 1.22;
    else if (event.key === 'Home') {
      this.resetCamera();
      event.preventDefault();
      return;
    } else return;

    spherical.radius = Math.max(
      this.#controls.minDistance,
      Math.min(this.#controls.maxDistance, spherical.radius),
    );
    offset.set(
      spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
      spherical.radius * Math.cos(spherical.phi),
      spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta),
    );
    this.#camera.position.copy(this.#controls.target).add(offset);
    this.#camera.lookAt(this.#controls.target);
    this.#controls.update();
    this.render();
    event.preventDefault();
  }

  readonly #visibilityChanged = (): void => {
    if (document.visibilityState === 'visible') this.render();
  };
}

class UnavailableMathScene implements SceneHandle {
  readonly available = false;
  readonly #notice: HTMLDivElement;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.dataset.webgl = 'unavailable';
    this.#notice = document.createElement('div');
    this.#notice.className = 'scene-fallback';
    this.#notice.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'scene-fallback-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◇';
    const title = document.createElement('strong');
    title.textContent = '3D 预览暂不可用';
    const description = document.createElement('span');
    description.textContent = '数值计算仍可使用；请启用硬件加速后刷新页面。';
    this.#notice.append(icon, title, description);
    canvas.parentElement?.append(this.#notice);
  }

  setActive(): void {}

  refreshTheme(): void {}

  resetCamera(): void {}

  setCurve(): void {}

  setVectors(): void {}

  exportImage(): void {}

  dispose(): void {
    this.#notice.remove();
  }
}

function createMathScene(canvas: HTMLCanvasElement): SceneHandle {
  try {
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return context ? new MathScene(canvas, context) : new UnavailableMathScene(canvas);
  } catch {
    return new UnavailableMathScene(canvas);
  }
}

export interface CurveChangeDetail {
  definition: CurveDefinition;
  pointCount: number;
}

export class CurveTool {
  readonly #scene: SceneHandle;
  readonly #inputs = {
    x: byId<HTMLInputElement>('curve-x'),
    y: byId<HTMLInputElement>('curve-y'),
    z: byId<HTMLInputElement>('curve-z'),
    tMin: byId<HTMLInputElement>('curve-t-min'),
    tMax: byId<HTMLInputElement>('curve-t-max'),
  };
  readonly #error = byId<HTMLParagraphElement>('curve-error');
  readonly #status = byId<HTMLSpanElement>('curve-status');
  readonly #summary = byId<HTMLParagraphElement>('curve-summary');
  readonly #onChange: ((detail: CurveChangeDetail) => void) | undefined;

  constructor(onChange?: (detail: CurveChangeDetail) => void) {
    this.#onChange = onChange;
    this.#scene = createMathScene(byId<HTMLCanvasElement>('curve-canvas'));
    byId<HTMLButtonElement>('draw-curve').addEventListener('click', () => this.draw());
    byId<HTMLButtonElement>('reset-curve-camera').addEventListener('click', () =>
      this.#scene.resetCamera(),
    );
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
      button.addEventListener('click', () => this.#applyPreset(button.dataset.preset ?? ''));
    }
    for (const input of Object.values(this.#inputs)) {
      input.addEventListener('input', () => this.#clearPresetSelection());
    }
    this.draw();
  }

  get definition(): CurveDefinition {
    return {
      x: this.#inputs.x.value.trim(),
      y: this.#inputs.y.value.trim(),
      z: this.#inputs.z.value.trim(),
      tMin: this.#inputs.tMin.valueAsNumber,
      tMax: this.#inputs.tMax.valueAsNumber,
    };
  }

  setActive(active: boolean): void {
    this.#scene.setActive(active);
  }

  refreshTheme(): void {
    this.#scene.refreshTheme();
  }

  draw(): boolean {
    const started = performance.now();
    const definition = this.definition;
    const span = definition.tMax - definition.tMin;
    if (!Number.isFinite(definition.tMin) || !Number.isFinite(definition.tMax)) {
      return this.#fail('参数范围必须是有限数字');
    }
    if (span <= 0) return this.#fail('t 结束值必须大于起始值');
    if (span < 1e-6 || span > MAX_RANGE_SPAN) {
      return this.#fail('t 范围跨度必须在 0.000001 至 1,000,000 之间');
    }

    const compiled = [
      compileExpression(definition.x, 't'),
      compileExpression(definition.y, 't'),
      compileExpression(definition.z, 't'),
    ] as const;
    const firstError = compiled.find((result) => !result.ok);
    if (firstError && !firstError.ok) return this.#fail(firstError.error.message);
    const evaluators = compiled.flatMap((result) => (result.ok ? [result.value] : []));
    if (evaluators.length !== 3) return this.#fail('参数方程无法编译');

    const sampleCount = 1000;
    const points: Vector3[] = [];
    let skipped = 0;
    for (let index = 0; index <= sampleCount; index += 1) {
      const t = definition.tMin + (index / sampleCount) * span;
      const values = evaluators.map((expression) => expression.evaluate(t));
      if (values.every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_RANGE_SPAN)) {
        points.push(new Vector3(values[0], values[1], values[2]));
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) return this.#fail('参数方程在当前范围内产生了非有限值，请调整表达式或范围');
    if (points.length < 2) return this.#fail('参数方程在当前范围内没有足够的有限点');

    this.#error.textContent = '';
    for (const input of Object.values(this.#inputs)) input.setAttribute('aria-invalid', 'false');
    this.#scene.setCurve(points);
    const elapsed = performance.now() - started;
    this.#status.textContent = this.#scene.available
      ? `${points.length.toLocaleString('zh-CN')} 点 · ${elapsed.toFixed(1)} ms`
      : `WebGL 不可用 · ${points.length.toLocaleString('zh-CN')} 点已校验`;
    const fallbackNotice = this.#scene.available
      ? ''
      : ' 当前设备无法显示 3D 预览，但表达式和参数范围已完成校验。';
    this.#summary.textContent = `已绘制参数曲线 x(t)=${definition.x}，y(t)=${definition.y}，z(t)=${definition.z}；t 从 ${formatNumber(definition.tMin)} 到 ${formatNumber(definition.tMax)}。${fallbackNotice}`;
    this.#scene.canvas.dataset.pointCount = String(points.length);
    this.#onChange?.({ definition, pointCount: points.length });
    return true;
  }

  exportImage(filename = 'math-studio-curve-3d.png'): void {
    this.#scene.exportImage(filename);
  }

  dispose(): void {
    this.#scene.dispose();
  }

  #applyPreset(id: string): void {
    const preset = CURVE_PRESETS[id];
    if (!preset) return;
    this.#inputs.x.value = preset.x;
    this.#inputs.y.value = preset.y;
    this.#inputs.z.value = preset.z;
    this.#inputs.tMin.value = String(preset.tMin);
    this.#inputs.tMax.value = String(preset.tMax);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
      const selected = button.dataset.preset === id;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    this.draw();
  }

  #clearPresetSelection(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
      button.classList.remove('is-active');
      button.setAttribute('aria-pressed', 'false');
    }
  }

  #fail(message: string): false {
    this.#error.textContent = message;
    this.#status.textContent = '绘制失败';
    for (const input of Object.values(this.#inputs)) input.setAttribute('aria-invalid', 'true');
    return false;
  }
}

export interface VectorChangeDetail {
  values: VectorValues;
  result: VectorResult;
}

export class VectorTool {
  readonly #scene: SceneHandle;
  readonly #inputs = {
    ax: byId<HTMLInputElement>('vector-ax'),
    ay: byId<HTMLInputElement>('vector-ay'),
    az: byId<HTMLInputElement>('vector-az'),
    bx: byId<HTMLInputElement>('vector-bx'),
    by: byId<HTMLInputElement>('vector-by'),
    bz: byId<HTMLInputElement>('vector-bz'),
  };
  readonly #error = byId<HTMLParagraphElement>('vector-error');
  readonly #status = byId<HTMLSpanElement>('vector-status');
  readonly #summary = byId<HTMLParagraphElement>('vector-summary');
  readonly #resultElement = byId<HTMLDivElement>('vector-result');
  readonly #onChange: ((detail: VectorChangeDetail) => void) | undefined;
  #operation: VectorOperation = 'add';
  #lastResult: VectorResult | null = null;

  constructor(onChange?: (detail: VectorChangeDetail) => void) {
    this.#onChange = onChange;
    this.#scene = createMathScene(byId<HTMLCanvasElement>('vector-canvas'));
    const updateLater = debounce(() => this.update(), 100);
    for (const input of Object.values(this.#inputs)) input.addEventListener('input', updateLater);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-operation]')) {
      button.addEventListener('click', () => {
        const operation = button.dataset.operation as VectorOperation | undefined;
        if (!operation) return;
        this.#operation = operation;
        for (const candidate of document.querySelectorAll<HTMLButtonElement>('[data-operation]')) {
          const selected = candidate === button;
          candidate.classList.toggle('is-active', selected);
          candidate.setAttribute('aria-pressed', String(selected));
        }
        this.update();
      });
    }
    byId<HTMLButtonElement>('reset-vector-camera').addEventListener('click', () =>
      this.#scene.resetCamera(),
    );
    this.update();
  }

  get values(): VectorValues {
    return {
      a: [
        this.#inputs.ax.valueAsNumber,
        this.#inputs.ay.valueAsNumber,
        this.#inputs.az.valueAsNumber,
      ],
      b: [
        this.#inputs.bx.valueAsNumber,
        this.#inputs.by.valueAsNumber,
        this.#inputs.bz.valueAsNumber,
      ],
      operation: this.#operation,
    };
  }

  get result(): VectorResult | null {
    return this.#lastResult;
  }

  setActive(active: boolean): void {
    this.#scene.setActive(active);
  }

  refreshTheme(): void {
    this.#scene.refreshTheme();
  }

  update(): boolean {
    const values = this.values;
    const validationError = validateVector(values);
    if (validationError) {
      this.#error.textContent = validationError;
      this.#status.textContent = '计算失败';
      for (const input of Object.values(this.#inputs)) input.setAttribute('aria-invalid', 'true');
      return false;
    }
    this.#error.textContent = '';
    for (const input of Object.values(this.#inputs)) input.setAttribute('aria-invalid', 'false');
    const result = calculateVector(values);
    this.#lastResult = result;
    this.#scene.setVectors(values, result);
    this.#renderResult(values, result);
    this.#onChange?.({ values, result });
    return true;
  }

  exportImage(filename = 'math-studio-vector-3d.png'): void {
    this.#scene.exportImage(filename);
  }

  dispose(): void {
    this.#scene.dispose();
  }

  #renderResult(values: VectorValues, result: VectorResult): void {
    const operationLabels: Record<VectorOperation, string> = {
      add: 'A + B',
      subtract: 'A − B',
      dot: 'A · B',
      cross: 'A × B',
    };
    const heading = document.createElement('strong');
    heading.textContent = operationLabels[result.operation];
    const value = document.createElement('span');
    if (result.vector) {
      value.textContent = `= (${result.vector.map((item) => formatNumber(item)).join(', ')})`;
    } else {
      value.textContent = `= ${formatNumber(result.scalar ?? Number.NaN)}`;
    }
    const detail = document.createElement('small');
    if (result.operation === 'dot') {
      detail.textContent = Number.isFinite(result.angleDegrees)
        ? `夹角 ${formatNumber(result.angleDegrees ?? 0, 2)}°`
        : '零向量没有确定的夹角';
    } else if (result.operation === 'cross') {
      detail.textContent = `结果模长 ${formatNumber(result.magnitude ?? 0)}`;
    } else {
      const endpoint = result.helperEndpoint ?? [0, 0, 0];
      detail.textContent = `辅助平移向量 (${endpoint.map((item) => formatNumber(item)).join(', ')})`;
    }
    this.#resultElement.replaceChildren(heading, value, detail);

    const aText = `(${values.a.map((item) => formatNumber(item)).join(', ')})`;
    const bText = `(${values.b.map((item) => formatNumber(item)).join(', ')})`;
    const zeroCount = [values.a, values.b].filter(
      (vector) => Math.hypot(...vector) <= EPSILON,
    ).length;
    const largestValue = Math.max(
      ...values.a.map(Math.abs),
      ...values.b.map(Math.abs),
      ...(result.vector ?? []).map(Math.abs),
      Math.abs(result.scalar ?? 0),
    );
    const largeNotice = largestValue > 1e5 ? '数值较大，场景已自动适配比例。' : '';
    const calculationStatus = zeroCount
      ? `${zeroCount} 个零向量`
      : largeNotice
        ? '数值较大 · 已适配'
        : '已更新';
    this.#status.textContent = this.#scene.available
      ? calculationStatus
      : `${calculationStatus} · WebGL 不可用`;
    const fallbackNotice = this.#scene.available
      ? ''
      : ' 当前设备无法显示 3D 预览，数值运算不受影响。';
    this.#summary.textContent = `向量 A=${aText}，B=${bText}；${operationLabels[result.operation]} ${value.textContent}。${detail.textContent}。${largeNotice}${fallbackNotice}`;
  }
}
