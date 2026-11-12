import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./mock-channel.html', import.meta.url));
const SCRIPT = readFileSync(new URL('./mock-channel-client.js', import.meta.url));
const STYLE = readFileSync(new URL('./mock-channel.css', import.meta.url));

class MockError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function respond(response, status, body, type) {
  response.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}
const json = (response, status, body) => respond(response, status, JSON.stringify(body), 'application/json; charset=utf-8');

async function readJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw new MockError('需要 application/json', 415);
  if (Number(request.headers['content-length']) > 8192) throw new MockError('请求内容过大', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new MockError('请求内容过大', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MockError('JSON 内容无效'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MockError('消息内容无效');
  return body;
}

export function createMockChannel({ agentUrl = 'http://127.0.0.1:3090', channelId = 'CLOCAL', tokenProvider, fetchImpl = fetch, now = Date.now } = {}) {
  const target = new URL(agentUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/'
    || target.username || target.password || target.search || target.hash) throw new Error('Agent 地址必须是 http://127.0.0.1:<端口>');
  if (!/^C[A-Z0-9]+$/.test(channelId)) throw new Error('模拟频道 ID 无效');
  if (typeof tokenProvider !== 'function') throw new Error('需要 Agent token 读取函数');
  const events = new Map();
  const threads = new Map();
  let sequence = 0;
  let cursor = 0;
  let syncing;
  const nextTs = () => `${Math.floor(now() / 1000)}.${String(++sequence).padStart(6, '0')}`;

  async function agentRequest(method, path, body) {
    let token;
    try { token = await tokenProvider(); } catch { throw new MockError('找不到 Agent token；请先运行 npm start', 503); }
    if (typeof token !== 'string' || !token.trim()) throw new MockError('找不到 Agent token；请先运行 npm start', 503);
    let response;
    try {
      response = await fetchImpl(`${target.origin}${path}`, {
        method,
        headers: { 'x-chat-to-fix-token': token.trim(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
    } catch { throw new MockError('Agent 未连接；请确认 npm start 已启动', 503); }
    let data;
    try { data = await response.json(); } catch { throw new MockError('Agent 返回了无效响应', 502); }
    if (response.status === 401) throw new MockError('Agent token 无效；请重启模拟 Bot', 502);
    if (!response.ok) {
      const code = typeof data?.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : 'request_failed';
      const message = code === 'channel_not_bound' ? 'Agent 未绑定此频道；请核对 CHAT_TO_FIX_SLACK_CHANNEL 并重启 Agent' : `Agent 拒绝请求：${code}`;
      throw new MockError(message, response.status >= 500 ? 502 : response.status);
    }
    return data;
  }

  const visible = (record) => ({
    eventId: record.eventId, command: record.command, threadTs: record.threadTs,
    taskId: record.taskId, taskState: record.taskState, status: record.status, error: record.error,
    messages: record.messages.map((message) => ({ ...message })),
  });

  async function submit(input) {
    const command = input.text;
    if (typeof command !== 'string' || command.length > 4000) throw new MockError('请输入不超过 4000 字的 /fix 问题描述');
    const match = /^\/fix\s+([\s\S]+)$/.exec(command.trim());
    const issue = match?.[1].trim();
    if (!issue) throw new MockError('请输入 /fix 问题描述');
    const eventId = input.eventId === undefined ? `mock:${randomUUID()}` : input.eventId;
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) throw new MockError('eventId 无效');
    let record = events.get(eventId);
    if (record && record.command !== command.trim()) throw new MockError('eventId 已用于另一条命令', 409);
    if (!record) {
      const threadTs = nextTs();
      record = { eventId, command: command.trim(), issue, threadTs, taskId: null, taskState: null,
        status: 'pending', error: null, errorStatus: null, pending: null,
        messages: [{ from: 'user', text: command.trim(), ts: threadTs, at: new Date(now()).toISOString() }] };
      events.set(eventId, record);
      threads.set(threadTs, record);
    }
    if (record.status === 'sent') return { ok: true, duplicate: true, thread: visible(record) };
    if (!record.pending) {
      record.status = 'pending';
      record.error = null;
      record.pending = (async () => {
        try {
          const result = await agentRequest('POST', '/events', {
            source: 'fix', eventId, channel: channelId, threadTs: record.threadTs,
            messageTs: record.threadTs, text: record.issue, user: { id: 'UMOCK', name: '模拟用户' },
          });
          if (typeof result?.taskId !== 'string') throw new MockError('Agent 未返回任务编号', 502);
          record.taskId = result.taskId;
          record.taskState = result.state ?? 'queued';
          record.status = 'sent';
          record.messages.push({ from: 'bot', text: `已交给 Agent · 任务 ${result.taskId}`, ts: nextTs(), at: new Date(now()).toISOString() });
        } catch (error) {
          record.status = 'failed';
          record.error = error instanceof MockError ? error.message : '任务转发失败';
          record.errorStatus = error instanceof MockError ? error.status : 502;
        } finally { record.pending = null; }
      })();
    }
    await record.pending;
    return { ok: record.status === 'sent', duplicate: false, thread: visible(record), errorStatus: record.errorStatus };
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        for (let page = 0; page < 10; page += 1) {
          const result = await agentRequest('GET', `/outbox?after=${cursor}&limit=200`);
          if (!Array.isArray(result?.messages) || !Number.isInteger(result.next) || result.next < cursor) throw new MockError('Agent 发件箱响应无效', 502);
          for (const message of result.messages) {
            const record = message.channel === channelId ? threads.get(message.threadTs) : null;
            if (record && typeof message.text === 'string' && Number.isInteger(message.seq) && message.seq > cursor) {
              record.messages.push({ from: 'agent', text: message.text, seq: message.seq, at: message.at });
            }
          }
          cursor = result.next;
          if (result.messages.length < 200) break;
        }
        try {
          const result = await agentRequest('GET', '/tasks');
          for (const task of result.tasks ?? []) for (const record of threads.values()) {
            if (record.taskId === task.id) record.taskState = task.state;
          }
        } catch { /* Outbox messages remain available when task status is unavailable. */ }
        return { online: true, error: null };
      } catch (error) { return { online: false, error: error instanceof MockError ? error.message : 'Agent 连接失败' }; }
    })().finally(() => { syncing = null; });
    return syncing;
  }

  return { submit, sync, snapshot: () => ({ channelId, threads: [...threads.values()].map(visible).reverse() }) };
}

export function createMockChannelServer({ channel, serviceId } = {}) {
  if (!channel) throw new Error('需要模拟频道');
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (typeof host !== 'string' || !/^127\.0\.0\.1:\d+$/.test(host)
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) throw new MockError('只允许本机请求', 403);
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (path === '/_service/identity') {
        if (request.method === 'GET' && serviceId && request.headers['x-mock-service-id'] === serviceId) {
          return json(response, 200, { id: serviceId });
        }
        return json(response, 404, { error: '路径不存在' });
      }
      if (path === '/_service/shutdown') {
        if (request.method !== 'POST' || !serviceId || request.headers['x-mock-service-id'] !== serviceId) {
          return json(response, 404, { error: '路径不存在' });
        }
        response.once('finish', () => {
          server.close();
          server.closeAllConnections?.();
        });
        return json(response, 202, { stopping: true });
      }
      if (request.method === 'GET' && path === '/') return respond(response, 200, PAGE, 'text/html; charset=utf-8');
      if (request.method === 'GET' && path === '/mock-channel-client.js') return respond(response, 200, SCRIPT, 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && path === '/mock-channel.css') return respond(response, 200, STYLE, 'text/css; charset=utf-8');
      if (request.method === 'GET' && path === '/api/channel') return json(response, 200, { ok: true, agent: await channel.sync(), ...channel.snapshot() });
      if (request.method === 'POST' && path === '/api/messages') {
        const result = await channel.submit(await readJson(request));
        return json(response, result.ok ? (result.duplicate ? 200 : 202) : result.errorStatus, {
          ok: result.ok, duplicate: result.duplicate, thread: result.thread,
          ...(result.ok ? {} : { error: result.thread.error }),
        });
      }
      const known = ['/', '/mock-channel-client.js', '/mock-channel.css', '/api/channel', '/api/messages'].includes(path);
      return json(response, known ? 405 : 404, { ok: false, error: known ? '方法不支持' : '路径不存在' });
    } catch (error) {
      return json(response, error instanceof MockError ? error.status : 500, {
        ok: false, error: error instanceof MockError ? error.message : '模拟频道处理失败',
      });
    }
  });
  return server;
}
