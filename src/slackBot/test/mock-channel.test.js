import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockChannel, createMockChannelServer } from '../mock-channel.js';
import { createHttp } from '../../chat-to-fix/core/task/http.ts';
import { createOutbox } from '../../chat-to-fix/core/task/outbox.ts';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const received = [];
  const messages = [];
  const tasks = [];
  const agent = createServer(async (request, response) => {
    assert.equal(request.headers['x-chat-to-fix-token'], 'local-test-token');
    const url = new URL(request.url, 'http://127.0.0.1');
    let body;
    if (request.method === 'POST' && url.pathname === '/events') {
      body = JSON.parse(await new Response(request).text());
      received.push(body);
      tasks.push({ id: `T-${received.length}`, state: 'running' });
      messages.push({ seq: messages.length + 1, channel: body.channel, threadTs: body.threadTs, text: '已创建 F2PGBA-1，正在处理', at: new Date().toISOString() });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ taskId: `T-${received.length}`, state: 'queued' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/outbox') {
      const after = Number(url.searchParams.get('after') || 0);
      const page = messages.filter((message) => message.seq > after);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ messages: page, next: page.at(-1)?.seq ?? after }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tasks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tasks }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not_found"}');
  });
  const agentUrl = await listen(agent);
  t.after(() => agent.close());
  const channel = createMockChannel({ agentUrl, tokenProvider: () => 'local-test-token' });
  const mock = createMockChannelServer({ channel });
  const mockUrl = await listen(mock);
  t.after(() => mock.close());
  const post = (body, headers = {}) => fetch(`${mockUrl}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { agentUrl, mockUrl, post, received, messages, channel };
}

test('频道网页把 /fix 转给 Agent，并显示回传进度和任务状态', async (t) => {
  const { mockUrl, post, received } = await fixture(t);
  const page = await fetch(mockUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /欢迎来到模拟频道/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

  const sent = await post({ text: '/fix 登录页按钮无响应', eventId: 'mock:E1' });
  assert.equal(sent.status, 202);
  const body = await sent.json();
  assert.equal(body.thread.taskId, 'T-1');
  assert.deepEqual(received[0], {
    source: 'fix', eventId: 'mock:E1', channel: 'CLOCAL', threadTs: body.thread.threadTs,
    messageTs: body.thread.threadTs, text: '登录页按钮无响应', user: { id: 'UMOCK', name: '模拟用户' },
  });

  const snapshot = await (await fetch(`${mockUrl}/api/channel`)).json();
  assert.equal(snapshot.agent.online, true);
  assert.equal(snapshot.threads[0].taskState, 'running');
  assert.deepEqual(snapshot.threads[0].messages.map((message) => message.from), ['user', 'bot', 'agent']);
  assert.match(snapshot.threads[0].messages[2].text, /F2PGBA-1/);
  assert.equal(JSON.stringify(snapshot).includes('local-test-token'), false);
  assert.equal((await (await fetch(`${mockUrl}/api/channel`)).json()).threads[0].messages.length, 3);
});

test('相同命令并发重试只转发一次，改用同一 eventId 提交其他内容会拒绝', async (t) => {
  const { post, received } = await fixture(t);
  const input = { text: '/fix 修复价格显示', eventId: 'mock:E2' };
  const [first, second] = await Promise.all([post(input), post(input)]);
  const [a, b] = await Promise.all([first.json(), second.json()]);
  assert.equal(received.length, 1);
  assert.equal(a.thread.threadTs, b.thread.threadTs);
  assert.equal((await (await post(input)).json()).duplicate, true);
  assert.equal(received.length, 1);
  assert.equal((await post({ text: '/fix 另一个问题', eventId: 'mock:E2' })).status, 409);
});

test('只接受本机页面的 /fix；转发失败后可用同一事件重试', async (t) => {
  const { agentUrl, mockUrl, post, received } = await fixture(t);
  assert.equal((await post({ text: '普通聊天' })).status, 400);
  assert.equal((await post({ text: '/fix   ' })).status, 400);
  assert.equal((await post({ text: '/fix 问题' }, { origin: 'https://example.com' })).status, 403);
  assert.equal(received.length, 0);

  let available = false;
  const channel = createMockChannel({ agentUrl, tokenProvider: () => available ? 'local-test-token' : '' });
  const server = createMockChannelServer({ channel });
  const retryUrl = await listen(server);
  t.after(() => server.close());
  const input = { text: '/fix 表单验证出错', eventId: 'mock:retry' };
  const submit = () => fetch(`${retryUrl}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const failed = await submit();
  assert.equal(failed.status, 503);
  const failedBody = await failed.json();
  assert.equal(failedBody.thread.status, 'failed');
  available = true;
  const success = await submit();
  assert.equal(success.status, 202);
  assert.equal((await success.json()).thread.threadTs, failedBody.thread.threadTs);
  assert.equal(received.length, 1);
});

test('模拟频道与 Agent 的真实 HTTP 接口能完成任务创建和发件箱回传', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mock-slack-agent-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const tasks = new Map();
  const eventIds = new Map();
  const order = [];
  const store = {
    knownEvent: async (id) => eventIds.get(id),
    createTask: async (origin, binding) => {
      const task = { id: `T-${tasks.size + 1}`, state: 'queued', origin, binding };
      tasks.set(task.id, task);
      eventIds.set(origin.eventId, task.id);
      return task;
    },
    findByThread: async (channel, threadTs) => [...tasks.values()].find((task) => task.origin.channel === channel && task.origin.threadTs === threadTs),
    getTask: async (id) => tasks.get(id),
    listTasks: async ({ state } = {}) => [...tasks.values()].filter((task) => !state || task.state === state),
  };
  const outbox = createOutbox({ dataDir, store });
  const queue = {
    full: async () => false,
    enqueue: async (id) => {
      order.push('enqueue');
      const task = tasks.get(id);
      await outbox.append({ channel: task.origin.channel, threadTs: task.origin.threadTs, purpose: 'ack', text: 'Agent 已收到问题' });
      return { position: 1 };
    },
  };
  const http = createHttp({
    config: { httpPort: 0, bindings: [{ channel: 'CLOCAL' }], limits: { maxConcurrent: 1, queueMax: 20 } },
    token: 'local-test-token', store, outbox, queue, runner: {}, notify: () => {},
    log: (line) => order.push(line),
  });
  await http.listen();
  t.after(() => http.close());
  const channel = createMockChannel({ agentUrl: `http://127.0.0.1:${http.port}`, tokenProvider: () => 'local-test-token' });
  const mock = createMockChannelServer({ channel });
  const mockUrl = await listen(mock);
  t.after(() => mock.close());
  const sent = await fetch(`${mockUrl}/api/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '/fix 修复表单错误', eventId: 'mock:real-http' }),
  });
  assert.equal(sent.status, 202);
  assert.equal(tasks.size, 1);
  assert.match(order[0], /收到 Slack \/fix.*CLOCAL.*UMOCK.*修复表单错误/);
  assert.equal(order[1], 'enqueue');
  assert.equal(order[0].includes('local-test-token'), false);
  assert.equal([...tasks.values()][0].origin.text, '修复表单错误');
  const snapshot = await (await fetch(`${mockUrl}/api/channel`)).json();
  assert.equal(snapshot.threads[0].messages.at(-1).text, 'Agent 已收到问题');
  assert.equal(snapshot.threads[0].taskId, 'T-1');
});
