import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createChatToFixApi } from '../src/slackBot/chat-to-fix-api.js';
import { createMockSlackBot, createMockSlackServer } from '../src/slackBot/mock-slack-bot.js';

async function startChatToFixStub() {
  const events = [];
  const outbox = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://x');
    let status = 404;
    let body = {};
    if (request.method === 'POST' && url.pathname === '/events') {
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      events.push(event);
      status = 202;
      body = { taskId: 'T-1' };
    } else if (url.pathname === '/outbox') {
      const after = Number(url.searchParams.get('after'));
      const messages = outbox.filter((m) => m.seq > after);
      status = 200;
      body = { messages, next: messages.at(-1)?.seq ?? after };
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { events, outbox, server, url: `http://127.0.0.1:${server.address().port}` };
}

test('模拟 /fix：任务消息进频道讨论串并 POST，发件箱消息出现在同一讨论串', async (t) => {
  const stub = await startChatToFixStub();
  t.after(() => stub.server.close());
  const bot = createMockSlackBot({ api: createChatToFixApi({ baseUrl: stub.url, token: 't' }) });

  const fixed = await bot.receiveFix({ text: '购买按钮拼错了', userId: 'U-A' });
  assert.equal(fixed.acked, true);
  assert.equal(fixed.messages[0].text, '<@U-A> 提交了修复请求：购买按钮拼错了');
  assert.equal(stub.events.length, 1);
  assert.equal(stub.events[0].source, 'fix');
  assert.equal(stub.events[0].threadTs, fixed.threadTs);
  assert.equal(stub.events[0].channel, bot.fixChannelId);

  stub.outbox.push({ seq: 1, channel: bot.fixChannelId, threadTs: fixed.threadTs, text: '已收到，开始处理。' });
  assert.deepEqual(await bot.relayTick(), { delivered: 1 });
  const thread = bot.getThread(fixed.threadTs);
  assert.equal(thread.length, 2);
  assert.equal(thread[1].text, '已收到，开始处理。');

  const mention = await bot.receiveMention({ text: '改成 Add to cart', threadTs: fixed.threadTs, userId: 'U-A' });
  assert.equal(stub.events[1].source, 'mention');
  assert.equal(stub.events[1].text, '改成 Add to cart');
  assert.equal(stub.events[1].threadTs, fixed.threadTs);
  assert.equal(mention.messages.at(-1).from, 'user');

  const top = await bot.receiveMention({ text: '新问题' });
  assert.match(top.ephemeral[0].text, /新问题请用 \/fix 提交/);
  assert.equal(stub.events.length, 2);
});

test('模拟 /fix：错频道、空正文、重复 trigger 不重复处理；服务连不上时讨论串里有说明', async (t) => {
  const stub = await startChatToFixStub();
  t.after(() => stub.server.close());
  const bot = createMockSlackBot({ api: createChatToFixApi({ baseUrl: stub.url }) });
  assert.match((await bot.receiveFix({ text: 'x', channelId: 'C-OTHER' })).ephemeral[0].text, /指定频道/);
  assert.match((await bot.receiveFix({ text: '' })).ephemeral[0].text, /用法/);
  const first = await bot.receiveFix({ text: '问题', triggerId: 'T1' });
  const again = await bot.receiveFix({ text: '问题', triggerId: 'T1' });
  assert.equal(stub.events.length, 1);
  assert.equal(again.threadTs, first.threadTs);

  const down = createMockSlackBot({ api: createChatToFixApi({ baseUrl: 'http://127.0.0.1:1' }) });
  const result = await down.receiveFix({ text: '问题' });
  assert.match(result.messages.at(-1).text, /服务暂时连不上/);
});

test('模拟 HTTP 接口：/fix、/mentions、/relay/tick、/threads，旧私信接口照旧', async (t) => {
  const stub = await startChatToFixStub();
  t.after(() => stub.server.close());
  const bot = createMockSlackBot({ api: createChatToFixApi({ baseUrl: stub.url }) });
  const server = createMockSlackServer({ bot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const fix = await (await post('/fix', { text: '登录失败' })).json();
  assert.equal(fix.ok, true);
  stub.outbox.push({ seq: 1, channel: bot.fixChannelId, threadTs: fix.threadTs, text: '进度' });
  assert.equal((await (await post('/relay/tick', {})).json()).delivered, 1);
  const thread = await (await fetch(`${base}/threads/${encodeURIComponent(fix.threadTs)}`)).json();
  assert.equal(thread.messages.length, 2);

  const mention = await post('/mentions', { text: '补充', threadTs: fix.threadTs });
  assert.equal(mention.status, 200);
  assert.equal((await post('/mentions', { text: '补充', threadTs: '9.9' })).status, 404);
  assert.equal((await post('/mentions', { text: '新问题' }).then((r) => r.json())).ephemeral.length, 1);
  assert.equal((await (await fetch(`${base}/ephemerals`)).json()).ephemerals.length, 1);

  const dm = await post('/messages', { text: '请修复登录问题' });
  assert.equal(dm.status, 200);
  assert.equal((await dm.json()).messages.length, 2);
});
