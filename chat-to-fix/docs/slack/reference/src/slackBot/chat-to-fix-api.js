// Chat-to-Fix 本机 HTTP 控制接口的客户端（规格见 spec/slackbot.md 4.2）。
// HTTP 状态码不抛错，由调用方判断；网络失败和超时抛带 code 的错误。不记录令牌。

export class ChatToFixApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChatToFixApiError';
    this.code = code;
  }
}

export function createChatToFixApi({
  baseUrl = 'http://127.0.0.1:3090',
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          ...(token ? { 'x-chat-to-fix-token': token } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        // 非 JSON 或空正文：body 保持 null。
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ChatToFixApiError('CHAT_TO_FIX_TIMEOUT', 'Chat-to-Fix 接口超时');
      }
      throw new ChatToFixApiError('CHAT_TO_FIX_NETWORK', 'Chat-to-Fix 接口连不上');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    postEvent: (body) => request('POST', '/events', body),
    getOutbox: (after = 0, limit = 50) => request('GET',
      `/outbox?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`),
    health: () => request('GET', '/health'),
  };
}
