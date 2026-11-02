import { compileExpression } from './expression';
import { validateRange } from './math';
import type { ViewRange } from '../types';

export const MAX_PROJECT_BYTES = 256 * 1024;
export const PROJECT_STORAGE_KEY = 'math-studio.projects-v1';
export interface GraphProject {
  schemaVersion: 1;
  name: string;
  functions: Array<{ expression: string; color: string }>;
  range: ViewRange;
  selectedIndex: number;
  quality: 'balanced' | 'precise';
}
export interface ProjectRevision {
  id: string;
  savedAt: string;
  project: GraphProject;
}
export interface ProjectLibrary {
  draft: GraphProject | null;
  revisions: ProjectRevision[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目结构无效');
  return value as Record<string, unknown>;
}

/** Return an explicit allowlist, never spread imported data into application state. */
export function validateProject(value: unknown): GraphProject {
  const data = record(value);
  if (data.schemaVersion !== 1) throw new Error('不支持此项目版本');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) {
    throw new Error('项目名称应为 1 至 80 个字符');
  }
  if (!Array.isArray(data.functions) || data.functions.length < 1 || data.functions.length > 8) {
    throw new Error('项目必须包含 1 至 8 条函数');
  }
  const functions = data.functions.map((item: unknown) => {
    const fn = record(item);
    if (typeof fn.expression !== 'string' || fn.expression.length > 200) {
      throw new Error('每条表达式最多 200 个字符');
    }
    if (typeof fn.color !== 'string' || !/^#[a-f\d]{6}$/i.test(fn.color)) {
      throw new Error('函数颜色格式无效');
    }
    return { expression: fn.expression, color: fn.color };
  });
  const inputRange = record(data.range);
  const range = Object.fromEntries(
    ['xMin', 'xMax', 'yMin', 'yMax'].map((key) => {
      if (typeof inputRange[key] !== 'number') throw new Error('视图范围必须是数字');
      return [key, inputRange[key]];
    }),
  ) as unknown as ViewRange;
  const validation = validateRange(range);
  if (!validation.ok) throw new Error(validation.message);
  if (
    !Number.isInteger(data.selectedIndex) ||
    (data.selectedIndex as number) < 0 ||
    (data.selectedIndex as number) >= functions.length
  )
    throw new Error('所选函数索引无效');
  if (data.quality !== 'balanced' && data.quality !== 'precise') throw new Error('采样设置无效');
  return {
    schemaVersion: 1,
    name: data.name.trim(),
    functions,
    range,
    selectedIndex: data.selectedIndex as number,
    quality: data.quality,
  };
}

export function parseProject(source: string): GraphProject {
  if (new TextEncoder().encode(source).byteLength > MAX_PROJECT_BYTES)
    throw new Error('项目文件不能超过 256 KB');
  return validateProject(JSON.parse(source) as unknown);
}

export function parseLibrary(source: string | null): ProjectLibrary {
  if (!source) return { draft: null, revisions: [] };
  if (source.length > MAX_PROJECT_BYTES) throw new Error('本地项目库过大');
  const library = record(JSON.parse(source) as unknown);
  if (!Array.isArray(library.revisions) || library.revisions.length > 20)
    throw new Error('项目版本列表无效');
  const revisions = library.revisions.map((value: unknown) => {
    const revision = record(value);
    if (
      typeof revision.id !== 'string' ||
      revision.id.length > 80 ||
      typeof revision.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(revision.savedAt))
    ) {
      throw new Error('项目版本信息无效');
    }
    return {
      id: revision.id,
      savedAt: revision.savedAt,
      project: validateProject(revision.project),
    };
  });
  return { draft: library.draft === null ? null : validateProject(library.draft), revisions };
}

function csvText(value: string): string {
  // Quoting alone does not prevent spreadsheet formula injection.
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function projectCsv(project: GraphProject, count = 1001): string {
  if (!Number.isInteger(count) || count < 2 || count > 5001)
    throw new Error('采样点数应在 2 至 5001 之间');
  const valid = validateProject(project);
  const expressions = valid.functions.map((fn) => {
    const result = compileExpression(fn.expression, 'x');
    if (!result.ok) throw new Error(`请先修正表达式：${result.error.message}`);
    return result.value;
  });
  const lines = ['function,expression,x,y,status'];
  expressions.forEach((expression, fnIndex) => {
    const source = csvText(expression.source);
    for (let index = 0; index < count; index += 1) {
      const x = valid.range.xMin + (index / (count - 1)) * (valid.range.xMax - valid.range.xMin);
      const y = expression.evaluate(x);
      lines.push(
        `f${fnIndex + 1},${source},${x},${Number.isFinite(y) ? y : ''},${Number.isFinite(y) ? 'finite' : 'undefined_or_overflow'}`,
      );
    }
  });
  return '\uFEFF' + lines.join('\r\n');
}
