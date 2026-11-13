// Chat-to-Fix 本机 HTTP 控制接口的客户端（规格见 docs/chat-to-fix/slack/slackbot.md 4.2）。
// HTTP 状态码不抛错，由调用方判断；网络失败和超时抛带 code 的错误。不记录令牌。
// token 可以是字符串，也可以是每次请求时调用的函数（Agent 重启后令牌会变）。

export class ChatToFixApiError extends Error {
  // reason：底层网络错误码（如 ECONNREFUSED：请求没到对方），没有时为 null。
  constructor(code, message, reason = null) {
    super(message);
    this.name = 'ChatToFixApiError';
    this.code = code;
    this.reason = reason;
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
    const tokenValue = typeof token === 'function' ? token() : token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          ...(tokenValue ? { 'x-chat-to-fix-token': tokenValue } : {}),
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
      const reason = error?.cause?.code ?? error?.code ?? null;
      throw new ChatToFixApiError('CHAT_TO_FIX_NETWORK', 'Chat-to-Fix 接口连不上', typeof reason === 'string' ? reason : null);
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
