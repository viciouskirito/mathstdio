// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { byId, debounce, formatNumber } from '../src/core/dom';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('DOM helpers', () => {
  it('finds typed elements and reports missing IDs', () => {
    const button = document.createElement('button');
    button.id = 'target';
    document.body.append(button);
    expect(byId<HTMLButtonElement>('target')).toBe(button);
    expect(() => byId('missing')).toThrow('缺少页面元素');
  });

  it('debounces calls', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const delayed = debounce(callback, 120);
    delayed();
    delayed();
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('formats regular, tiny, large and invalid values', () => {
    expect(formatNumber(1.23456, 3)).toBe('1.235');
    expect(formatNumber(1e-12)).toBe('0');
    expect(formatNumber(1e-5)).toBe('1.00e-5');
    expect(formatNumber(1e5)).toBe('1.00e+5');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});
