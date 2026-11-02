import { describe, expect, it } from 'vitest';
import {
  parseLibrary,
  parseProject,
  projectCsv,
  validateProject,
  type GraphProject,
} from '../src/core/projects';

const project: GraphProject = {
  schemaVersion: 1,
  name: '工程验证',
  functions: [{ expression: '1/x', color: '#2563eb' }],
  range: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
  selectedIndex: 0,
  quality: 'balanced',
};

describe('project interchange', () => {
  it('round trips project data and drops unrelated fields including credentials', () => {
    expect(
      parseProject(JSON.stringify({ ...project, apiKey: 'test-only', ai: { key: 'test-only' } })),
    ).toEqual(project);
  });
  it.each([
    null,
    [],
    { ...project, schemaVersion: 2 },
    { ...project, name: '' },
    { ...project, name: 'x'.repeat(81) },
    { ...project, functions: [] },
    { ...project, functions: Array(9).fill(project.functions[0]) },
    { ...project, functions: [{ expression: 'x'.repeat(201), color: '#2563eb' }] },
    { ...project, functions: [{ expression: 'x', color: 'url(evil)' }] },
    { ...project, range: { ...project.range, xMax: '1' } },
    { ...project, range: { ...project.range, xMax: 0, xMin: 1 } },
    { ...project, range: { ...project.range, xMax: Infinity } },
    { ...project, selectedIndex: 1 },
    { ...project, selectedIndex: -1 },
    { ...project, selectedIndex: 0.5 },
    { ...project, quality: 'unknown' },
  ])('rejects invalid or hostile project %#', (input) => {
    expect(() => validateProject(input)).toThrow();
  });
  it('rejects malformed and oversized JSON before applying it', () => {
    expect(() => parseProject('{')).toThrow();
    expect(() => parseProject(' '.repeat(262145))).toThrow('256 KB');
  });
  it('restores drafts and immutable revisions; rejects corrupt libraries', () => {
    expect(parseLibrary(null)).toEqual({ draft: null, revisions: [] });
    expect(parseLibrary('{"draft":null,"revisions":[]}')).toEqual({ draft: null, revisions: [] });
    const library = {
      draft: project,
      revisions: [{ id: 'test', savedAt: '2026-09-09T00:00:00Z', project }],
    };
    expect(parseLibrary(JSON.stringify(library))).toEqual(library);
    for (const input of [{}, { revisions: [{}] }, { revisions: Array(21).fill({}) }]) {
      expect(() => parseLibrary(JSON.stringify(input))).toThrow();
    }
    expect(() => parseLibrary(' '.repeat(262145))).toThrow();
  });
  it('exports real samples independently of the viewport and marks undefined points', () => {
    const csv = projectCsv(project, 5);
    expect(csv).toContain('f1,"1/x",0,,undefined_or_overflow');
    expect(csv).toContain('f1,"1/x",0.5,2,finite');
    expect(csv.split('\r\n')).toHaveLength(6);
  });
  it('prevents formula injection and rejects invalid expressions and sample counts', () => {
    expect(
      projectCsv({ ...project, functions: [{ expression: '-x', color: '#2563eb' }] }, 2),
    ).toContain('"\'-x"');
    expect(() =>
      projectCsv({ ...project, functions: [{ expression: 'import(x)', color: '#2563eb' }] }),
    ).toThrow('表达式');
    expect(() => projectCsv(project, 5002)).toThrow();
    expect(() => projectCsv(project, 1)).toThrow();
  });
});
