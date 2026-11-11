import assert from 'node:assert/strict';
import test from 'node:test';
import { createDmHandler } from '../src/slackBot/slack-message.js';

const event = {
  type: 'message',
  channel_type: 'im',
  channel: 'D123',
  user: 'U123',
  text: '请修复登录问题',
  ts: '123.456',
};

test('仅回复用户私信，并留在原 thread', async () => {
  const sent = [];
  const handle = createDmHandler({ postMessage: async (message) => sent.push(message) });
  await handle({ event: { ...event, thread_ts: '100.001' }, body: { event_id: 'E1' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'D123');
  assert.equal(sent[0].thread_ts, '100.001');
  assert.match(sent[0].text, /不会创建 Jira 工单或 GitLab MR/);
});

test('同一事件并发重试只回复一次', async () => {
  const sent = [];
  const handle = createDmHandler({ postMessage: async (message) => sent.push(message) });
  await Promise.all([
    handle({ event, body: { event_id: 'E2' } }),
    handle({ event, body: { event_id: 'E2' } }),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].thread_ts, event.ts);
});

test('忽略频道消息、Bot 消息、编辑事件和空消息', async () => {
  const sent = [];
  const handle = createDmHandler({ postMessage: async (message) => sent.push(message) });
  for (const changed of [
    { channel_type: 'channel' },
    { bot_id: 'B123' },
    { subtype: 'message_changed' },
    { text: ' ' },
  ]) {
    await handle({ event: { ...event, ...changed }, body: { event_id: JSON.stringify(changed) } });
  }
  assert.equal(sent.length, 0);
});

test('回复失败后同一事件再次送达可重试', async () => {
  let calls = 0;
  const handle = createDmHandler({
    postMessage: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
    },
  });
  await assert.rejects(handle({ event, body: { event_id: 'E3' } }));
  await handle({ event, body: { event_id: 'E3' } });
  assert.equal(calls, 2);
});
