import type { MathNode } from 'mathjs';
import { parse } from 'mathjs/number';
import type { CompiledExpression, ExpressionError, ExpressionResult } from '../types';

const MAX_SOURCE_LENGTH = 200;
const MAX_NODE_COUNT = 128;
const MAX_DEPTH = 24;
const CACHE_LIMIT = 64;

const FUNCTION_ARITY = new Map<string, number>([
  ['sin', 1],
  ['cos', 1],
  ['tan', 1],
  ['asin', 1],
  ['acos', 1],
  ['atan', 1],
  ['sinh', 1],
  ['cosh', 1],
  ['tanh', 1],
  ['sec', 1],
  ['csc', 1],
  ['cot', 1],
  ['sqrt', 1],
  ['cbrt', 1],
  ['abs', 1],
  ['exp', 1],
  ['floor', 1],
  ['ceil', 1],
  ['round', 1],
  ['log', 1],
  ['log10', 1],
]);
const ALLOWED_OPERATORS = new Set(['+', '-', '*', '/', '^']);

interface InspectableNode extends MathNode {
  type: string;
  op?: string;
  name?: string;
  value?: unknown;
  args?: InspectableNode[];
  fn?: InspectableNode;
  content?: InspectableNode;
}

interface CachedCode {
  source: string;
  code: ReturnType<MathNode['compile']>;
}

const codeCache = new Map<string, CachedCode>();

function expressionError(code: ExpressionError['code'], message: string): ExpressionResult {
  return { ok: false, error: { code, message } };
}

function normalizeExpression(source: string): string {
  return source
    .trim()
    .replaceAll('π', 'pi')
    .replace(/\bPI\b/g, 'pi')
    .replace(/\blog\s*(?=\()/gi, 'log10')
    .replace(/\bln\s*(?=\()/gi, 'log');
}

function validateNode(
  node: InspectableNode,
  variable: 'x' | 't',
  counter: { value: number },
  depth = 0,
): string | null {
  counter.value += 1;
  if (counter.value > MAX_NODE_COUNT || depth > MAX_DEPTH) return '表达式结构过于复杂';

  if (node.type === 'ConstantNode') {
    return typeof node.value === 'number' && Number.isFinite(node.value)
      ? null
      : '只支持有限实数常量';
  }
  if (node.type === 'SymbolNode') {
    return node.name === variable || node.name === 'pi' || node.name === 'e'
      ? null
      : `不支持符号“${node.name ?? ''}”`;
  }
  if (node.type === 'ParenthesisNode' && node.content) {
    return validateNode(node.content, variable, counter, depth + 1);
  }
  if (node.type === 'OperatorNode') {
    if (!node.op || !ALLOWED_OPERATORS.has(node.op)) return `不支持运算符“${node.op ?? ''}”`;
    for (const argument of node.args ?? []) {
      const error = validateNode(argument, variable, counter, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (node.type === 'FunctionNode') {
    const name = node.fn?.type === 'SymbolNode' ? node.fn.name : undefined;
    const expectedArity = name ? FUNCTION_ARITY.get(name) : undefined;
    if (!name || expectedArity === undefined) return `不支持函数“${name ?? ''}”`;
    if ((node.args?.length ?? 0) !== expectedArity) return `${name} 需要 ${expectedArity} 个参数`;
    for (const argument of node.args ?? []) {
      const error = validateNode(argument, variable, counter, depth + 1);
      if (error) return error;
    }
    return null;
  }
  return `不支持 ${node.type.replace(/Node$/, '') || '该'} 语法`;
}

function rememberCode(key: string, value: CachedCode): void {
  if (codeCache.has(key)) codeCache.delete(key);
  codeCache.set(key, value);
  if (codeCache.size > CACHE_LIMIT) {
    const oldestKey = codeCache.keys().next().value as string | undefined;
    if (oldestKey) codeCache.delete(oldestKey);
  }
}

export function compileExpression(source: string, variable: 'x' | 't'): ExpressionResult {
  const trimmed = source.trim();
  if (!trimmed) return expressionError('EMPTY', '请输入表达式');
  if (trimmed.length > MAX_SOURCE_LENGTH) {
    return expressionError('TOO_LONG', `表达式不能超过 ${MAX_SOURCE_LENGTH} 个字符`);
  }

  const normalized = normalizeExpression(trimmed);
  const cacheKey = `${variable}:${normalized}`;
  try {
    let cached = codeCache.get(cacheKey);
    if (!cached) {
      const node = parse(normalized) as InspectableNode;
      const counter = { value: 0 };
      const validationError = validateNode(node, variable, counter);
      if (validationError) {
        const code = validationError.includes('复杂') ? 'TOO_COMPLEX' : 'UNSUPPORTED';
        return expressionError(code, validationError);
      }
      cached = { source: normalized, code: node.compile() };
      rememberCode(cacheKey, cached);
    }

    const scope: Record<string, number> = { [variable]: 0 };
    const code = cached.code;
    const compiled: CompiledExpression = {
      source: trimmed,
      variable,
      evaluate(value: number): number {
        if (!Number.isFinite(value)) return Number.NaN;
        scope[variable] = value;
        try {
          const result = code.evaluate(scope) as unknown;
          return typeof result === 'number' && Number.isFinite(result) ? result : Number.NaN;
        } catch {
          return Number.NaN;
        }
      },
    };
    return { ok: true, value: compiled };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.replace(/^.*?:\s*/, '') : '表达式语法错误';
    return expressionError('SYNTAX', `无法解析表达式：${message}`);
  }
}

export function clearExpressionCache(): void {
  codeCache.clear();
}
