export type ToolId = 'graph' | 'curve' | 'vector';
export type ThemePreference = 'system' | 'light' | 'dark';
export type VectorOperation = 'add' | 'subtract' | 'dot' | 'cross';

export interface ViewRange {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphFunction {
  id: string;
  expression: string;
  color: string;
  error?: string;
}

export interface CurveDefinition {
  x: string;
  y: string;
  z: string;
  tMin: number;
  tMax: number;
}

export interface VectorValues {
  a: [number, number, number];
  b: [number, number, number];
  operation: VectorOperation;
}

export interface ExpressionError {
  code: 'EMPTY' | 'TOO_LONG' | 'TOO_COMPLEX' | 'UNSUPPORTED' | 'SYNTAX';
  message: string;
}

export interface CompiledExpression {
  readonly source: string;
  readonly variable: 'x' | 't';
  evaluate(value: number): number;
}

export type ExpressionResult =
  { ok: true; value: CompiledExpression } | { ok: false; error: ExpressionError };

export interface AppState {
  activeTool: ToolId;
  theme: ThemePreference;
  graph: { functions: GraphFunction[]; selectedId: string; range: ViewRange };
  curve: CurveDefinition;
  vector: VectorValues;
  ai: { status: 'idle' | 'checking' | 'ready' | 'error'; model: string };
}
