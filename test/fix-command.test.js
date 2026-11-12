import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFixCommandHandler, createMentionHandler, neutralizeBroadcasts,
  USAGE_TEXT, WRONG_CHANNEL_TEXT, UNAVAILABLE_TEXT, NOT_IN_THREAD_TEXT,
} from '../src/slackBot/fix-command.js';

const CH = 'C-FIX';

function setup(apiResult = { status: 202, body: { taskId: 'T-1' } }) {
  const log = [];
  const api = {
    postEvent: async (body) => {
      log.push(['post', body]);
      if (apiResult instanceof Error) throw apiResult;
      return apiResult;
    },
  };
  const postMessage = async (message) => { log.push(['message', message]); return { ok: true, ts: '100.001' }; };
  const responses = [];
  const run = (command, handler) => handler({
    command: { text: '购买按钮拼错了', user_id: 'U1', user_name: 'alice', channel_id: CH, trigger_id: 'TR1', ...command },
    ack: async () => { log.push(['ack']); },
    respond: async (r) => { responses.push(r); },
  });
  return { api, postMessage, log, responses, run };
}

test('neutralizeBroadcasts 去掉广播式提及', () => {
  assert.equal(neutralizeBroadcasts('<!channel> 看 <!here|here> <!everyone> <!subteam^S1|@dev> @channel @Here @everyone 好'), '看 好');
  assert.equal(neutralizeBroadcasts('邮件 a@channelx.com 和 <@U1>'), '邮件 a@channelx.com 和 <@U1>');
});

test('/fix 空正文：先确认，再回用法临时消息', async () => {
  const s = setup();
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({ text: '   ' }, handler);
  assert.deepEqual(s.log, [['ack']]);
  assert.deepEqual(s.responses, [{ response_type: 'ephemeral', text: USAGE_TEXT }]);
});

test('/fix 在别的频道或私信里：只回临时消息，不发任务消息', async () => {
  const s = setup();
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({ channel_id: 'C-OTHER', trigger_id: 'A' }, handler);
  await s.run({ channel_id: 'D1', trigger_id: 'B' }, handler);
  assert.equal(s.log.filter(([k]) => k !== 'ack').length, 0);
  assert.deepEqual(s.responses.map((r) => r.text), [WRONG_CHANNEL_TEXT, WRONG_CHANNEL_TEXT]);
});

test('/fix 通过：确认，发任务消息（去广播），再 POST /events', async () => {
  const s = setup();
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({ text: ' <!channel> 购买按钮拼错了 ' }, handler);
  assert.deepEqual(s.log.map(([k]) => k), ['ack', 'message', 'post']);
  assert.equal(s.log[1][1].channel, CH);
  assert.equal(s.log[1][1].text, '<@U1> 提交了修复请求：购买按钮拼错了');
  assert.equal(s.log[1][1].thread_ts, undefined);
  assert.deepEqual(s.log[2][1], {
    source: 'fix', eventId: 'slash:TR1', channel: CH, threadTs: '100.001', messageTs: '100.001',
    user: { id: 'U1', name: 'alice' }, text: '<!channel> 购买按钮拼错了',
  });
  assert.equal(s.responses.length, 0);
});

test('/fix 同一 trigger_id 重复送达只处理一次，一小时后可再处理', async () => {
  const s = setup();
  let time = 0;
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH, now: () => time });
  await Promise.all([s.run({}, handler), s.run({}, handler)]);
  assert.equal(s.log.filter(([k]) => k === 'post').length, 1);
  time = 61 * 60 * 1000;
  await s.run({}, handler);
  assert.equal(s.log.filter(([k]) => k === 'post').length, 2);
});

test('/fix 5xx、网络错误：在任务讨论串里回服务连不上', async () => {
  for (const result of [{ status: 503, body: null }, new Error('down')]) {
    const s = setup(result);
    const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
    await s.run({}, handler);
    const last = s.log.at(-1)[1];
    assert.equal(last.thread_ts, '100.001');
    assert.equal(last.text, UNAVAILABLE_TEXT);
  }
});

test('/fix 4xx：不另外说话', async () => {
  const s = setup({ status: 422, body: { error: 'channel_not_bound' } });
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({}, handler);
  assert.deepEqual(s.log.map(([k]) => k), ['ack', 'message', 'post']);
  assert.equal(s.responses.length, 0);
});

function mentionSetup(apiResult = { status: 202, body: {} }) {
  const posts = [];
  const ephemerals = [];
  const messages = [];
  const api = { postEvent: async (b) => { posts.push(b); return apiResult; } };
  const handler = createMentionHandler({
    api, fixChannelId: CH, botUserId: 'UBOT',
    postEphemeral: async (m) => { ephemerals.push(m); },
    postMessage: async (m) => { messages.push(m); },
  });
  const event = { type: 'app_mention', channel: CH, user: 'U1', ts: '200.002', thread_ts: '100.001', text: '<@UBOT> 改成 Add to cart' };
  return { posts, ephemerals, messages, handler, event };
}

test('@ 在讨论串里：POST source mention，去掉开头 @bot', async () => {
  const s = mentionSetup();
  await s.handler({ event: s.event, body: { event_id: 'Ev1' } });
  assert.deepEqual(s.posts, [{
    source: 'mention', eventId: 'Ev1', channel: CH, threadTs: '100.001', messageTs: '200.002',
    user: { id: 'U1' }, text: '改成 Add to cart',
  }]);
  assert.equal(s.ephemerals.length, 0);
});

test('@ 不在讨论串里：临时消息，不 POST', async () => {
  const s = mentionSetup();
  const { thread_ts: _omit, ...top } = s.event;
  await s.handler({ event: top, body: { event_id: 'Ev2' } });
  assert.deepEqual(s.ephemerals, [{ channel: CH, user: 'U1', text: NOT_IN_THREAD_TEXT }]);
  assert.equal(s.posts.length, 0);
});

test('@ 忽略：别的频道、bot、编辑、subtype', async () => {
  const s = mentionSetup();
  let n = 0;
  for (const change of [{ channel: 'C-OTHER' }, { bot_id: 'B1' }, { edited: { user: 'U1', ts: '1' } }, { subtype: 'thread_broadcast' }]) {
    await s.handler({ event: { ...s.event, ...change }, body: { event_id: `Ev-ign-${n++}` } });
  }
  assert.equal(s.posts.length + s.ephemerals.length + s.messages.length, 0);
});

test('@ 同一 event_id 只处理一次', async () => {
  const s = mentionSetup();
  await Promise.all([
    s.handler({ event: s.event, body: { event_id: 'Ev3' } }),
    s.handler({ event: s.event, body: { event_id: 'Ev3' } }),
  ]);
  assert.equal(s.posts.length, 1);
});

test('@ 没有 botUserId 时用 authorizations，5xx 在讨论串回一句', async () => {
  const posts = [];
  const messages = [];
  const handler = createMentionHandler({
    api: { postEvent: async (b) => { posts.push(b); return { status: 500, body: null }; } },
    fixChannelId: CH, postEphemeral: async () => {}, postMessage: async (m) => { messages.push(m); },
  });
  await handler({
    event: { type: 'app_mention', channel: CH, user: 'U1', ts: '3.1', thread_ts: '1.1', text: '<@UBOT>: 补充' },
    body: { event_id: 'Ev4', authorizations: [{ user_id: 'UBOT' }] },
  });
  assert.equal(posts[0].text, '补充');
  assert.equal(messages[0].thread_ts, '1.1');
});
