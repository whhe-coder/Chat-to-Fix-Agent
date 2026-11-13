import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createChatToFixApi } from '../chat-to-fix-api.js';

async function startStub(handler) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const record = { method: request.method, url: request.url, headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined };
    seen.push(record);
    const [status, body, delayMs] = handler(record);
    setTimeout(() => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    }, delayMs || 0);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
}

test('postEvent 带令牌头和 JSON 正文，返回状态和正文', async (t) => {
  const stub = await startStub(() => [202, { taskId: 'T-1' }]);
  t.after(() => stub.server.close());
  const api = createChatToFixApi({ baseUrl: stub.url, token: 'secret' });
  const result = await api.postEvent({ source: 'fix', text: 'x' });
  assert.deepEqual(result, { status: 202, body: { taskId: 'T-1' } });
  assert.equal(stub.seen[0].method, 'POST');
  assert.equal(stub.seen[0].url, '/events');
  assert.equal(stub.seen[0].headers['x-chat-to-fix-token'], 'secret');
  assert.equal(stub.seen[0].headers['content-type'], 'application/json');
  assert.deepEqual(stub.seen[0].body, { source: 'fix', text: 'x' });
});

test('4xx 和 5xx 不抛错；非 JSON 正文得到 null', async (t) => {
  const stub = await startStub((r) => (r.body.n === 1 ? [422, { error: 'channel_not_bound' }] : [502, 'bad gateway']));
  t.after(() => stub.server.close());
  const api = createChatToFixApi({ baseUrl: stub.url, token: 't' });
  assert.deepEqual(await api.postEvent({ n: 1 }), { status: 422, body: { error: 'channel_not_bound' } });
  assert.deepEqual(await api.postEvent({ n: 2 }), { status: 502, body: null });
});

test('getOutbox 和 health 的路径与参数', async (t) => {
  const stub = await startStub((r) => (r.url === '/health' ? [200, { ok: true }] : [200, { messages: [], next: 7 }]));
  t.after(() => stub.server.close());
  const api = createChatToFixApi({ baseUrl: `${stub.url}/`, token: 't' });
  assert.deepEqual((await api.getOutbox(7, 20)).body, { messages: [], next: 7 });
  assert.equal(stub.seen[0].url, '/outbox?after=7&limit=20');
  assert.equal(stub.seen[0].headers['x-chat-to-fix-token'], 't');
  assert.equal((await api.health()).status, 200);
  assert.equal(stub.seen[1].url, '/health');
});

test('连不上和超时抛带 code 的错误，错误信息不含令牌', async (t) => {
  const stub = await startStub(() => [200, {}, 300]);
  t.after(() => stub.server.close());
  const slow = createChatToFixApi({ baseUrl: stub.url, token: 'secret-token', timeoutMs: 50 });
  await assert.rejects(slow.health(), (error) => error.code === 'CHAT_TO_FIX_TIMEOUT'
    && !JSON.stringify(error).includes('secret-token') && !error.message.includes('secret-token'));
  // 起一个服务拿到端口后马上关掉，这个端口上的连接会被拒绝（ECONNREFUSED）。
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const { port } = closed.address();
  await new Promise((resolve) => { closed.close(resolve); });
  const dead = createChatToFixApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret-token' });
  await assert.rejects(dead.health(), (error) => error.code === 'CHAT_TO_FIX_NETWORK'
    && error.reason === 'ECONNREFUSED' && !error.message.includes('secret-token'));
});

test('token 可以是函数：每次请求时读取，空值不带令牌头', async (t) => {
  const stub = await startStub(() => [200, {}]);
  t.after(() => stub.server.close());
  let current = 'first';
  const api = createChatToFixApi({ baseUrl: stub.url, token: () => current });
  await api.health();
  current = 'second';
  await api.health();
  current = '';
  await api.health();
  assert.deepEqual(stub.seen.map((r) => r.headers['x-chat-to-fix-token']), ['first', 'second', undefined]);
});
