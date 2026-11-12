import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createDmHandler } from './slack-message.js';

const MAX_BODY_BYTES = 16 * 1024;

class MockInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function optionalId(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw new MockInputError(`${label} 无效`);
  }
  return value;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    throw new MockInputError('需要 application/json', 415);
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    throw new MockInputError('请求内容过大', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new MockInputError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new MockInputError('JSON 内容无效');
  }
}

export function createMockSlackBot({ createHandler = createDmHandler, now = Date.now } = {}) {
  const threads = new Map();
  const events = new Map();
  let sequence = 0;

  function threadKey(channel, threadTs) {
    return `${channel}:${threadTs}`;
  }

  function nextTs() {
    sequence += 1;
    return `${Math.floor(now() / 1000)}.${String(sequence).padStart(6, '0')}`;
  }

  const handleEvent = createHandler({
    postMessage: async ({ channel, thread_ts: threadTs, text }) => {
      const key = threadKey(channel, threadTs);
      const messages = threads.get(key);
      if (!messages) throw new Error('模拟 thread 不存在');
      messages.push({ from: 'bot', text, ts: nextTs() });
    },
  });

  async function receiveDm(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new MockInputError('消息内容无效');
    }
    const { text } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) {
      throw new MockInputError('text 必须是 1 到 10000 个字符');
    }
    const user = optionalId(input.userId, 'userId', 'U-MOCK');
    const channel = optionalId(input.channelId, 'channelId', 'D-MOCK');
    const requestedThreadTs = optionalId(input.threadTs, 'threadTs', undefined);
    const eventId = optionalId(input.eventId, 'eventId', `E-MOCK-${randomUUID()}`);
    const fingerprint = JSON.stringify({ text, user, channel, requestedThreadTs });
    let record = events.get(eventId);
    if (record && record.fingerprint !== fingerprint) {
      throw new MockInputError('eventId 已用于另一条消息', 409);
    }
    if (!record) {
      const ts = nextTs();
      const threadTs = requestedThreadTs || ts;
      const key = threadKey(channel, threadTs);
      if (requestedThreadTs && !threads.has(key)) {
        throw new MockInputError('threadTs 不存在', 404);
      }
      const event = { type: 'message', channel_type: 'im', channel, user, text, ts,
        ...(requestedThreadTs ? { thread_ts: requestedThreadTs } : {}) };
      record = { event, fingerprint, threadTs };
      events.set(eventId, record);
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key).push({ from: 'user', user, text, ts });
    }
    await handleEvent({ event: record.event, body: { event_id: eventId } });
    return { eventId, channel, threadTs: record.threadTs,
      messages: getThread(record.threadTs, channel) };
  }

  function getThread(threadTs, channel = 'D-MOCK') {
    const messages = threads.get(threadKey(channel, threadTs));
    return messages ? messages.map((message) => ({ ...message })) : null;
  }

  return { receiveDm, getThread };
}

export function createMockSlackServer({ bot = createMockSlackBot() } = {}) {
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (typeof host !== 'string' || !/^127\.0\.0\.1:\d+$/.test(host)
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        throw new MockInputError('只允许本机请求', 403);
      }
      const url = new URL(request.url || '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/messages' && request.method === 'POST') {
        sendJson(response, 200, { ok: true, ...await bot.receiveDm(await readJson(request)) });
        return;
      }
      const match = /^\/threads\/([^/]+)$/.exec(path);
      if (match && request.method === 'GET') {
        const threadTs = decodeURIComponent(match[1]);
        const channel = optionalId(url.searchParams.get('channelId') ?? undefined, 'channelId', 'D-MOCK');
        const messages = bot.getThread(threadTs, channel);
        if (!messages) throw new MockInputError('thread 不存在', 404);
        sendJson(response, 200, { ok: true, threadTs, messages });
        return;
      }
      sendJson(response, path === '/messages' || match ? 405 : 404, {
        ok: false, error: path === '/messages' || match ? '方法不支持' : '路径不存在',
      });
    } catch (error) {
      sendJson(response, error instanceof MockInputError ? error.status : 500, {
        ok: false,
        error: error instanceof MockInputError ? error.message : '模拟 Bot 处理失败',
      });
    }
  });
}
