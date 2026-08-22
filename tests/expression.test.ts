import { beforeEach, describe, expect, it } from 'vitest';

import { clearExpressionCache, compileExpression } from '../src/core/expression';

function compile(source: string, variable: 'x' | 't' = 'x') {
  const result = compileExpression(source, variable);
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('compileExpression', () => {
  beforeEach(() => clearExpressionCache());

  it('respects arithmetic precedence and powers', () => {
    expect(compile('2+3*4').evaluate(0)).toBe(14);
    expect(compile('(2+3)*4').evaluate(0)).toBe(20);
    expect(compile('2^3^2').evaluate(0)).toBe(512);
    expect(compile('-2^2').evaluate(0)).toBe(-4);
  });

  it('supports implicit multiplication', () => {
    expect(compile('2x').evaluate(3)).toBe(6);
    expect(compile('(x+1)(x-1)').evaluate(3)).toBe(8);
    expect(compile('2pi').evaluate(0)).toBeCloseTo(2 * Math.PI);
  });

  it('supports constants, aliases and the t variable', () => {
    expect(compile('π + e').evaluate(0)).toBeCloseTo(Math.PI + Math.E);
    expect(compile('PI').evaluate(0)).toBeCloseTo(Math.PI);
    expect(compile('t^2', 't').evaluate(4)).toBe(16);
    expect(compile('log(100)').evaluate(0)).toBe(2);
    expect(compile('ln(e)').evaluate(0)).toBeCloseTo(1);
  });

  it.each([
    ['sin(x)', Math.sin(0.5)],
    ['cos(x)', Math.cos(0.5)],
    ['tan(x)', Math.tan(0.5)],
    ['asin(x)', Math.asin(0.5)],
    ['acos(x)', Math.acos(0.5)],
    ['atan(x)', Math.atan(0.5)],
    ['sinh(x)', Math.sinh(0.5)],
    ['cosh(x)', Math.cosh(0.5)],
    ['tanh(x)', Math.tanh(0.5)],
    ['sec(x)', 1 / Math.cos(0.5)],
    ['csc(x)', 1 / Math.sin(0.5)],
    ['cot(x)', 1 / Math.tan(0.5)],
    ['sqrt(x)', Math.sqrt(0.5)],
    ['cbrt(x)', Math.cbrt(0.5)],
    ['abs(-x)', 0.5],
    ['exp(x)', Math.exp(0.5)],
    ['floor(x)', 0],
    ['ceil(x)', 1],
    ['round(x)', 1],
  ])('evaluates %s', (source, expected) => {
    expect(compile(source).evaluate(0.5)).toBeCloseTo(expected, 10);
  });

  it('returns NaN for non-finite inputs and outputs', () => {
    const reciprocal = compile('1/x');
    expect(reciprocal.evaluate(0)).toBeNaN();
    expect(reciprocal.evaluate(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(compile('sqrt(x)').evaluate(-1)).toBeNaN();
  });

  it.each([
    ['a=1', '不支持'],
    ['x.foo', '不支持'],
    ['[x, 1]', '不支持'],
    ['unknown(x)', '不支持函数'],
    ['y+1', '不支持符号'],
    ['sin(x, 2)', '需要 1 个参数'],
    ['x!', '不支持运算符'],
  ])('rejects unsafe or unsupported syntax: %s', (source, message) => {
    const result = compileExpression(source, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it('enforces source and AST complexity limits', () => {
    const long = compileExpression('x'.repeat(201), 'x');
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe('TOO_LONG');

    const complex = compileExpression(Array.from({ length: 80 }, () => 'x').join('+'), 'x');
    expect(complex.ok).toBe(false);
    if (!complex.ok) expect(complex.error.code).toBe('TOO_COMPLEX');
  });

  it('handles empty and malformed expressions safely', () => {
    const empty = compileExpression('   ', 'x');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('EMPTY');
    const malformed = compileExpression('sin(', 'x');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('SYNTAX');
  });

  it('reuses compiled code without sharing variable values', () => {
    const first = compile('x^2+1');
    const second = compile('x^2+1');
    expect(first.evaluate(2)).toBe(5);
    expect(second.evaluate(3)).toBe(10);
    expect(first.evaluate(4)).toBe(17);
  });
});
