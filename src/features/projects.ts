import { byId } from '../core/dom';
import {
  MAX_PROJECT_BYTES,
  PROJECT_STORAGE_KEY,
  parseLibrary,
  parseProject,
  projectCsv,
  validateProject,
  type ProjectLibrary,
} from '../core/projects';
import type { Graph2D } from './graph2d';

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export class ProjectManager {
  readonly #graph: Graph2D;
  readonly #name = byId<HTMLInputElement>('project-name');
  readonly #status = byId<HTMLElement>('project-status');
  readonly #versions = byId<HTMLSelectElement>('project-versions');
  #library: ProjectLibrary = { draft: null, revisions: [] };
  #lastStored: string | null = null;
  #timer = 0;
  #storageAvailable = true;

  constructor(graph: Graph2D) {
    this.#graph = graph;
    try {
      this.#lastStored = localStorage.getItem(PROJECT_STORAGE_KEY);
      this.#library = parseLibrary(this.#lastStored);
      if (this.#library.draft) {
        this.#name.value = this.#library.draft.name;
        graph.restore(this.#library.draft);
        this.#status.textContent = '已恢复本机草稿。';
      }
    } catch {
      this.#storageAvailable = false;
      this.#status.textContent = '本地存储不可用或内容损坏；可继续编辑并导出项目备份。';
    }
    this.#renderVersions();
    this.#name.addEventListener('input', () => this.changed());
    byId<HTMLButtonElement>('project-save').addEventListener('click', () => this.#saveVersion());
    byId<HTMLButtonElement>('project-restore').addEventListener('click', () => {
      const revision = this.#library.revisions.find((item) => item.id === this.#versions.value);
      if (!revision) return;
      // Keep the current valid draft as a recoverable version before replacing it.
      if (!this.#saveVersion(false)) return;
      this.#name.value = revision.project.name;
      graph.restore(revision.project);
      this.changed();
      this.#status.textContent = '已恢复所选版本；此前内容保留在版本列表中。';
    });
    byId<HTMLButtonElement>('project-export').addEventListener('click', () =>
      this.#attempt(() => {
        const project = validateProject(graph.snapshot(this.#name.value));
        download(
          new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
          this.#filename('mathstudio.json'),
        );
        this.#status.textContent = '项目已导出，包含函数、范围与采样设置。';
      }),
    );
    byId<HTMLButtonElement>('graph-export-csv').addEventListener('click', () =>
      this.#attempt(() => {
        const csv = projectCsv(graph.snapshot(this.#name.value));
        download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), this.#filename('csv'));
        this.#status.textContent = '已导出每条函数 1001 个等距采样点；未定义或溢出值单独标记。';
      }),
    );
    byId<HTMLButtonElement>('graph-export-png').addEventListener('click', () => {
      void graph
        .exportImage()
        .then((blob) => {
          if (blob) download(blob, this.#filename('png'));
          this.#status.textContent = blob
            ? '图像已导出，包含表达式与时间。'
            : '图像导出失败，请重试。';
        })
        .catch(() => {
          this.#status.textContent = '图像导出失败，请重试。';
        });
    });
    const fileInput = byId<HTMLInputElement>('project-file');
    byId<HTMLButtonElement>('project-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_PROJECT_BYTES) {
        this.#status.textContent = '项目文件不能超过 256 KB。';
        return;
      }
      void file
        .text()
        .then((text) =>
          this.#attempt(() => {
            const project = parseProject(text);
            if (!this.#saveVersion(false)) return;
            this.#name.value = project.name;
            graph.restore(project);
            this.changed();
            this.#status.textContent = '已导入项目；此前内容保留在版本列表中。';
          }),
        )
        .catch(() => {
          this.#status.textContent = '无法读取项目文件。';
        });
    });
    window.addEventListener('pagehide', () => this.#saveDraft());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#saveDraft();
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== PROJECT_STORAGE_KEY && event.key !== null) return;
      this.#storageAvailable = false;
      this.#status.textContent =
        '其他标签页已更新项目库；自动保存已暂停。请先导出当前项目，再刷新读取新版本。';
    });
  }

  changed(): void {
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#saveDraft(), 600);
  }

  #saveDraft(): void {
    if (!this.#storageAvailable) return;
    this.#attempt(() => {
      this.#library.draft = validateProject(this.#graph.snapshot(this.#name.value));
      if (this.#persist()) this.#status.textContent = '草稿已自动保存到本机浏览器。';
    });
  }

  #saveVersion(showStatus = true): boolean {
    return this.#attempt(() => {
      const project = validateProject(this.#graph.snapshot(this.#name.value));
      this.#library.revisions.unshift({
        id: crypto.randomUUID(),
        savedAt: new Date().toISOString(),
        project,
      });
      this.#library.revisions = this.#library.revisions.slice(0, 20);
      this.#library.draft = project;
      const persisted = this.#persist();
      this.#renderVersions();
      if (showStatus)
        this.#status.textContent = persisted
          ? '已保存版本；本机最多保留最近 20 个版本。'
          : '版本仅保留在当前页面，请导出项目备份。';
    });
  }

  #persist(): boolean {
    if (!this.#storageAvailable) return false;
    try {
      if (localStorage.getItem(PROJECT_STORAGE_KEY) !== this.#lastStored) {
        throw new Error('项目库已在其他标签页更新');
      }
      const encoded = JSON.stringify(this.#library);
      localStorage.setItem(PROJECT_STORAGE_KEY, encoded);
      this.#lastStored = encoded;
      return true;
    } catch {
      this.#storageAvailable = false;
      this.#status.textContent = '本地保存失败或存在其他标签页更新；请导出项目备份后刷新。';
      return false;
    }
  }

  #renderVersions(): void {
    this.#versions.replaceChildren();
    if (!this.#library.revisions.length) {
      const empty = document.createElement('option');
      empty.textContent = '尚无版本，点击“保存版本”开始记录';
      this.#versions.append(empty);
    }
    for (const revision of this.#library.revisions) {
      const option = document.createElement('option');
      option.value = revision.id;
      option.textContent = `${revision.project.name} · ${new Date(revision.savedAt).toLocaleString('zh-CN')}`;
      this.#versions.append(option);
    }
    this.#versions.disabled = this.#library.revisions.length === 0;
    byId<HTMLButtonElement>('project-restore').disabled = this.#versions.disabled;
  }

  #filename(extension: string): string {
    return `${this.#name.value.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60) || 'math-studio'}.${extension}`;
  }

  #attempt(action: () => void): boolean {
    try {
      action();
      return true;
    } catch (error) {
      this.#status.textContent =
        error instanceof SyntaxError
          ? '文件不是有效的 JSON 项目。'
          : error instanceof Error
            ? error.message
            : '操作失败，请重试。';
      return false;
    }
  }
}
