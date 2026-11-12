import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createMockSlackBot, createMockSlackServer } from '../src/slackBot/mock-slack-bot.js';

test('模拟私信进入原 thread，并保留发送者和频道', async () => {
  const bot = createMockSlackBot({ now: () => 1000 });
  const first = await bot.receiveDm({ text: '请修复登录问题', userId: 'U-TEST', channelId: 'D-TEST' });
  assert.equal(first.channel, 'D-TEST');
  assert.equal(first.messages.length, 2);
  assert.deepEqual(first.messages[0], {
    from: 'user', user: 'U-TEST', text: '请修复登录问题', ts: first.threadTs,
  });
  assert.equal(first.messages[1].from, 'bot');
  assert.match(first.messages[1].text, /Slack 接入测试/);

  const reply = await bot.receiveDm({
    text: '补充：仅新用户失败', channelId: 'D-TEST', threadTs: first.threadTs,
  });
  assert.equal(reply.threadTs, first.threadTs);
  assert.equal(reply.messages.length, 4);
});

test('相同 eventId 并发重试只记录一条消息和一次回复', async () => {
  const bot = createMockSlackBot();
  const input = { text: '请修复问题', eventId: 'E-RETRY' };
  const [first, retry] = await Promise.all([bot.receiveDm(input), bot.receiveDm(input)]);
  assert.equal(first.threadTs, retry.threadTs);
  assert.equal(bot.getThread(first.threadTs).length, 2);
  await assert.rejects(bot.receiveDm({ text: '另一问题', eventId: 'E-RETRY' }), /eventId 已用于另一条消息/);
});

test('可替换消息处理器以对接后续任务', async () => {
  const received = [];
  const bot = createMockSlackBot({
    createHandler: ({ postMessage }) => async ({ event, body }) => {
      received.push({ event, body });
      await postMessage({ channel: event.channel, thread_ts: event.ts, text: '任务已接收' });
    },
  });
  const result = await bot.receiveDm({ text: '问题描述' });
  assert.equal(received[0].event.text, '问题描述');
  assert.equal(received[0].body.event_id, result.eventId);
  assert.equal(result.messages[1].text, '任务已接收');
});

test('本机 HTTP 接口提交私信并查询 thread，拒绝跨站写入', async (t) => {
  const server = createMockSlackServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '请修复登录问题' }),
  });
  assert.equal(created.status, 200);
  const first = await created.json();
  assert.equal(first.messages.length, 2);

  const thread = await fetch(`${base}/threads/${encodeURIComponent(first.threadTs)}`);
  assert.equal(thread.status, 200);
  assert.equal((await thread.json()).messages.length, 2);

  const crossSite = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '不应处理' }),
  });
  assert.equal(crossSite.status, 403);
});
