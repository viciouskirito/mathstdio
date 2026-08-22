import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { byId } from '../core/dom';

const DEEPSEEK_API = 'https://api.deepseek.com';
const PREFERRED_MODEL = 'deepseek-v4-flash';
const CONNECT_TIMEOUT_MS = 15_000;
const ANALYSIS_TIMEOUT_MS = 45_000;

export interface DeepSeekAnalysisRequest {
  system: string;
  prompt: string;
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class DeepSeekApiError extends Error {
  readonly status: number | null;
  readonly code: 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' | 'ABORTED';

  constructor(message: string, code: DeepSeekApiError['code'], status: number | null = null) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.code = code;
    this.status = status;
  }
}

export class DeepSeekClient {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#fetch = fetchImplementation.bind(globalThis);
  }

  async connect(key: string, signal?: AbortSignal): Promise<string[]> {
    const response = await this.#request(
      '/models',
      key,
      { method: 'GET' },
      CONNECT_TIMEOUT_MS,
      signal,
    );
    const payload = (await this.#safeJson(response)) as ModelsResponse;
    const models = (payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    if (!models.length) {
      throw new DeepSeekApiError('连接成功，但没有返回可用模型。', 'INVALID_RESPONSE');
    }
    return [...new Set(models)];
  }

  async analyze(
    request: DeepSeekAnalysisRequest,
    key: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!model.trim()) throw new DeepSeekApiError('请先选择可用模型。', 'INVALID_RESPONSE');
    const response = await this.#request(
      '/chat/completions',
      key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          temperature: 0.35,
          max_tokens: 1200,
          stream: false,
          thinking: { type: 'disabled' },
        }),
      },
      ANALYSIS_TIMEOUT_MS,
      signal,
    );
    const payload = (await this.#safeJson(response)) as ChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new DeepSeekApiError('DeepSeek 返回了空响应，请重试。', 'INVALID_RESPONSE');
    }
    return content;
  }

  async #request(
    path: string,
    key: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    if (!key.trim()) throw new DeepSeekApiError('请输入 DeepSeek API Key。', 'INVALID_RESPONSE');
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${key.trim()}`);
      const response = await this.#fetch(`${DEEPSEEK_API}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw this.#httpError(response.status);
      return response;
    } catch (error) {
      if (error instanceof DeepSeekApiError) throw error;
      if (timedOut) throw new DeepSeekApiError('请求超时，请检查网络后重试。', 'TIMEOUT');
      if (externalSignal?.aborted) {
        throw new DeepSeekApiError('请求已取消。', 'ABORTED');
      }
      throw new DeepSeekApiError('无法连接 DeepSeek，请检查网络后重试。', 'NETWORK');
    } finally {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async #safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new DeepSeekApiError('服务返回了无法识别的数据。', 'INVALID_RESPONSE');
    }
  }

  #httpError(status: number): DeepSeekApiError {
    if (status === 401 || status === 403) {
      return new DeepSeekApiError('API Key 无效或无权访问，请检查后重试。', 'HTTP', status);
    }
    if (status === 429) {
      return new DeepSeekApiError('请求过于频繁或额度不足，请稍后重试。', 'HTTP', status);
    }
    if (status >= 500) {
      return new DeepSeekApiError('DeepSeek 服务暂时不可用，请稍后重试。', 'HTTP', status);
    }
    return new DeepSeekApiError(`DeepSeek 请求失败（HTTP ${status}）。`, 'HTTP', status);
  }
}

type ConnectionState = 'idle' | 'checking' | 'ready' | 'error';

export interface AIStateDetail {
  status: ConnectionState;
  model: string;
}

export class AIManager {
  readonly #dialog = byId<HTMLDialogElement>('api-dialog');
  readonly #keyInput = byId<HTMLInputElement>('api-key');
  readonly #modelSelect = byId<HTMLSelectElement>('api-model');
  readonly #connectButton = byId<HTMLButtonElement>('connect-api');
  readonly #statusElement = byId<HTMLSpanElement>('api-status');
  readonly #connectionDot = byId<HTMLSpanElement>('header-connection-dot');
  readonly #client: DeepSeekClient;
  readonly #onStateChange: ((detail: AIStateDetail) => void) | undefined;
  readonly #showToast: ((message: string) => void) | undefined;
  #key = '';
  #state: ConnectionState = 'idle';
  #connectController: AbortController | null = null;
  #analysisController: AbortController | null = null;

  constructor(
    client = new DeepSeekClient(),
    onStateChange?: (detail: AIStateDetail) => void,
    showToast?: (message: string) => void,
  ) {
    this.#client = client;
    this.#onStateChange = onStateChange;
    this.#showToast = showToast;
    this.#connectButton.addEventListener('click', () => void this.connect());
    this.#keyInput.addEventListener('input', () => this.#invalidateConnection());
    this.#keyInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void this.connect();
    });
    this.#modelSelect.addEventListener('change', () => this.#emitState());
    window.addEventListener('pagehide', () => this.cancel());
  }

  get model(): string {
    return this.#modelSelect.value;
  }

  get ready(): boolean {
    return this.#state === 'ready' && Boolean(this.#key) && Boolean(this.model);
  }

  open(): void {
    if (!this.#dialog.open) this.#dialog.showModal();
    requestAnimationFrame(() => this.#keyInput.focus());
  }

  async connect(): Promise<void> {
    if (this.#state === 'checking') return;
    const candidate = this.#keyInput.value.trim();
    if (!candidate) {
      this.#keyInput.setAttribute('aria-invalid', 'true');
      this.#setState('error', '请输入 API Key');
      return;
    }
    this.#keyInput.setAttribute('aria-invalid', 'false');
    this.#connectController?.abort();
    const controller = new AbortController();
    this.#connectController = controller;
    this.#connectButton.disabled = true;
    this.#modelSelect.disabled = true;
    this.#setState('checking', '正在验证…');
    try {
      const models = await this.#client.connect(candidate, controller.signal);
      if (controller.signal.aborted) return;
      this.#key = candidate;
      this.#populateModels(models);
      this.#modelSelect.disabled = false;
      this.#setState('ready', `已连接 · ${this.model}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#key = '';
      this.#resetModels();
      this.#setState('error', this.#errorMessage(error));
    } finally {
      if (this.#connectController === controller) this.#connectController = null;
      this.#connectButton.disabled = false;
    }
  }

  async run(
    button: HTMLButtonElement,
    target: HTMLElement,
    request: DeepSeekAnalysisRequest,
  ): Promise<void> {
    if (!this.ready) {
      target.replaceChildren(this.#message('请先在 AI 设置中验证 DeepSeek 连接。'));
      this.open();
      return;
    }
    if (this.#analysisController) {
      this.#showToast?.('已有分析正在进行，请稍候。');
      return;
    }
    const controller = new AbortController();
    this.#analysisController = controller;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ai-button')];
    for (const candidate of buttons) candidate.disabled = true;
    button.setAttribute('aria-busy', 'true');
    target.classList.add('is-loading');
    target.setAttribute('aria-busy', 'true');
    target.replaceChildren(this.#message('DeepSeek 正在分析…'));

    try {
      const markdown = await this.#client.analyze(
        request,
        this.#key,
        this.model,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      await this.#renderMarkdown(target, markdown);
    } catch (error) {
      if (!controller.signal.aborted)
        target.replaceChildren(this.#message(this.#errorMessage(error)));
    } finally {
      if (this.#analysisController === controller) this.#analysisController = null;
      for (const candidate of buttons) candidate.disabled = false;
      button.removeAttribute('aria-busy');
      target.classList.remove('is-loading');
      target.removeAttribute('aria-busy');
    }
  }

  cancel(): void {
    this.#connectController?.abort();
    this.#analysisController?.abort();
    this.#connectController = null;
    this.#analysisController = null;
    this.#key = '';
    this.#keyInput.value = '';
    this.#invalidateConnection();
  }

  #populateModels(models: string[]): void {
    const fragment = document.createDocumentFragment();
    for (const id of models) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      fragment.append(option);
    }
    this.#modelSelect.replaceChildren(fragment);
    const selected =
      models.find((id) => id === PREFERRED_MODEL) ??
      models.find((id) => id.toLowerCase().includes('flash')) ??
      models[0] ??
      '';
    this.#modelSelect.value = selected;
  }

  #resetModels(): void {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '连接后加载模型';
    this.#modelSelect.replaceChildren(option);
    this.#modelSelect.disabled = true;
  }

  #invalidateConnection(): void {
    this.#connectController?.abort();
    this.#analysisController?.abort();
    this.#connectController = null;
    this.#key = '';
    this.#resetModels();
    this.#setState('idle', '尚未连接');
  }

  #setState(state: ConnectionState, message: string): void {
    this.#state = state;
    this.#statusElement.textContent = message;
    this.#statusElement.classList.toggle('is-ready', state === 'ready');
    this.#statusElement.classList.toggle('is-error', state === 'error');
    this.#connectionDot.classList.toggle('is-ready', state === 'ready');
    this.#connectionDot.classList.toggle('is-error', state === 'error');
    this.#emitState();
  }

  #emitState(): void {
    this.#onStateChange?.({ status: this.#state, model: this.model });
  }

  async #renderMarkdown(target: HTMLElement, markdown: string): Promise<void> {
    const parsed = await marked.parse(markdown, { async: false, gfm: true, breaks: true });
    const clean = DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        'style',
        'script',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'button',
        'img',
      ],
      FORBID_ATTR: ['style'],
    });
    const template = document.createElement('template');
    template.innerHTML = clean;
    for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    target.replaceChildren(template.content.cloneNode(true));
  }

  #message(text: string): HTMLParagraphElement {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return paragraph;
  }

  #errorMessage(error: unknown): string {
    return error instanceof DeepSeekApiError ? error.message : '操作失败，请稍后重试。';
  }
}
