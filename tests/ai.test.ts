// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AIManager,
  DeepSeekApiError,
  DeepSeekClient,
  type DeepSeekAnalysisRequest,
} from '../src/features/ai';

const request: DeepSeekAnalysisRequest = {
  system: '你是数学教师',
  prompt: '分析 sin(x)',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fixture(): void {
  document.body.innerHTML = `
    <button id="api-settings-button"></button>
    <span id="header-connection-dot"></span>
    <dialog id="api-dialog"></dialog>
    <input id="api-key" />
    <select id="api-model" disabled><option value="">连接后加载模型</option></select>
    <button id="connect-api"></button>
    <span id="api-status"></span>
    <button id="ai-one" class="ai-button"></button>
    <button id="ai-two" class="ai-button"></button>
    <div id="result"></div>
  `;
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
}

beforeEach(() => fixture());

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

describe('DeepSeekClient', () => {
  it('loads and deduplicates model IDs without exposing the key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-chat' }, { id: 2 }] }),
      );
    const client = new DeepSeekClient(fetchMock);
    await expect(client.connect('secret-key')).resolves.toEqual(['deepseek-chat']);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/models');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-key');
    expect(JSON.stringify(init)).not.toContain('secret-key');
  });

  it('posts analysis requests and returns assistant content', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '## 结论' } }] }));
    const client = new DeepSeekClient(fetchMock);
    await expect(client.analyze(request, 'key', 'deepseek-v4-flash')).resolves.toBe('## 结论');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'deepseek-v4-flash', stream: false });
    expect(body.messages).toEqual([
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ]);
  });

  it.each([
    [401, 'API Key 无效'],
    [403, 'API Key 无效'],
    [429, '请求过于频繁'],
    [500, '服务暂时不可用'],
    [418, 'HTTP 418'],
  ])('maps HTTP %s to a safe message', async (status, message) => {
    const client = new DeepSeekClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status })),
    );
    await expect(client.connect('key')).rejects.toMatchObject({
      status,
      message: expect.stringContaining(message),
    });
  });

  it('rejects missing models, empty chat content and malformed JSON', async () => {
    const noModels = new DeepSeekClient(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [] })),
    );
    await expect(noModels.connect('key')).rejects.toThrow('没有返回可用模型');

    const emptyChat = new DeepSeekClient(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })),
    );
    await expect(emptyChat.analyze(request, 'key', 'model')).rejects.toThrow('空响应');

    const malformed = new DeepSeekClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json', { status: 200 })),
    );
    await expect(malformed.connect('key')).rejects.toThrow('无法识别');
  });

  it('validates credentials and model before sending a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new DeepSeekClient(fetchMock);
    await expect(client.connect('')).rejects.toThrow('请输入');
    await expect(client.analyze(request, 'key', '')).rejects.toThrow('选择可用模型');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles network errors, timeouts and caller cancellation', async () => {
    const network = new DeepSeekClient(
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')),
    );
    await expect(network.connect('key')).rejects.toMatchObject({ code: 'NETWORK' });

    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const timeoutClient = new DeepSeekClient(hangingFetch);
    const timedRequest = timeoutClient.connect('key');
    const timedExpectation = expect(timedRequest).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_001);
    await timedExpectation;

    const controller = new AbortController();
    const cancelledRequest = timeoutClient.connect('key', controller.signal);
    const cancelledExpectation = expect(cancelledRequest).rejects.toMatchObject({
      code: 'ABORTED',
    });
    controller.abort();
    await cancelledExpectation;
  });
});

describe('AIManager', () => {
  it('selects v4 Flash first and keeps credentials out of storage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-flash' }, { id: 'other-flash' }],
      }),
    );
    const stateSpy = vi.fn();
    const manager = new AIManager(new DeepSeekClient(fetchMock), stateSpy);
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    if (!keyInput) throw new Error('fixture missing key input');
    keyInput.value = 'runtime-only-key';
    await manager.connect();
    expect(manager.ready).toBe(true);
    expect(manager.model).toBe('deepseek-v4-flash');
    expect(localStorage.length).toBe(0);
    expect(stateSpy).toHaveBeenLastCalledWith({ status: 'ready', model: 'deepseek-v4-flash' });
  });

  it('validates with Enter without submitting the dialog form', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'deepseek-v4-flash' }] }));
    const manager = new AIManager(new DeepSeekClient(fetchMock));
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    if (!keyInput) throw new Error('fixture missing key input');
    keyInput.value = 'key';
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    keyInput.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(manager.ready).toBe(true));
  });

  it('falls back to another Flash model, then the first model', async () => {
    const flashFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'chat' }, { id: 'FAST-FLASH' }] }));
    const flashManager = new AIManager(new DeepSeekClient(flashFetch));
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    if (!keyInput) throw new Error('fixture missing key input');
    keyInput.value = 'key';
    await flashManager.connect();
    expect(flashManager.model).toBe('FAST-FLASH');

    fixture();
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'first' }, { id: 'second' }] }));
    const firstManager = new AIManager(new DeepSeekClient(firstFetch));
    const nextKeyInput = document.querySelector<HTMLInputElement>('#api-key');
    if (!nextKeyInput) throw new Error('fixture missing key input');
    nextKeyInput.value = 'key';
    await firstManager.connect();
    expect(firstManager.model).toBe('first');
  });

  it('sanitizes malicious Markdown before rendering', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'deepseek-v4-flash' }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content:
                  '# 安全结果\n<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>[链接](https://example.com)',
              },
            },
          ],
        }),
      );
    const manager = new AIManager(new DeepSeekClient(fetchMock));
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    const button = document.querySelector<HTMLButtonElement>('#ai-one');
    const target = document.querySelector<HTMLDivElement>('#result');
    if (!keyInput || !button || !target) throw new Error('fixture incomplete');
    keyInput.value = 'key';
    await manager.connect();
    await manager.run(button, target, request);
    expect(target.querySelector('h1')?.textContent).toBe('安全结果');
    expect(target.querySelector('script')).toBeNull();
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('a')).toMatchObject({
      target: '_blank',
      rel: 'noopener noreferrer',
    });
  });

  it('locks duplicate analysis and restores controls', async () => {
    let resolveChat: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'model' }] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveChat = resolve;
          }),
      );
    const toast = vi.fn();
    const manager = new AIManager(new DeepSeekClient(fetchMock), undefined, toast);
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    const one = document.querySelector<HTMLButtonElement>('#ai-one');
    const two = document.querySelector<HTMLButtonElement>('#ai-two');
    const target = document.querySelector<HTMLDivElement>('#result');
    if (!keyInput || !one || !two || !target) throw new Error('fixture incomplete');
    keyInput.value = 'key';
    await manager.connect();
    const firstRun = manager.run(one, target, request);
    await Promise.resolve();
    await manager.run(two, target, request);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('正在进行'));
    expect(one.disabled).toBe(true);
    resolveChat?.(jsonResponse({ choices: [{ message: { content: '完成' } }] }));
    await firstRun;
    expect(one.disabled).toBe(false);
    expect(target.textContent).toContain('完成');
  });

  it('shows safe connection errors and invalidates when the key changes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    const manager = new AIManager(new DeepSeekClient(fetchMock));
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    const status = document.querySelector<HTMLSpanElement>('#api-status');
    if (!keyInput || !status) throw new Error('fixture incomplete');
    await manager.connect();
    expect(status.textContent).toContain('请输入');
    keyInput.value = 'bad-key';
    await manager.connect();
    expect(status.textContent).toContain('API Key 无效');
    expect(manager.ready).toBe(false);
    keyInput.dispatchEvent(new Event('input'));
    expect(status.textContent).toBe('尚未连接');
  });

  it('opens settings when analysis is requested before connection and can cancel state', async () => {
    const manager = new AIManager(new DeepSeekClient(vi.fn<typeof fetch>()));
    const button = document.querySelector<HTMLButtonElement>('#ai-one');
    const target = document.querySelector<HTMLDivElement>('#result');
    const dialog = document.querySelector<HTMLDialogElement>('#api-dialog');
    const keyInput = document.querySelector<HTMLInputElement>('#api-key');
    if (!button || !target || !dialog || !keyInput) throw new Error('fixture incomplete');
    await manager.run(button, target, request);
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(target.textContent).toContain('请先');
    keyInput.value = 'temporary';
    manager.cancel();
    expect(keyInput.value).toBe('');
    expect(manager.ready).toBe(false);
  });

  it('uses generic messaging for unexpected errors', () => {
    expect(new DeepSeekApiError('safe', 'NETWORK')).toMatchObject({
      name: 'DeepSeekApiError',
      message: 'safe',
      status: null,
    });
  });
});
