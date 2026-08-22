export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

export function debounce<T extends (...args: never[]) => void>(callback: T, delay: number): T {
  let timer = 0;
  return ((...args: never[]) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  }) as T;
}

export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1e-10) return '0';
  if (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-4) return value.toExponential(2);
  return Number(value.toFixed(digits)).toString();
}
