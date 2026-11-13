import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFixCommandHandler, neutralizeBroadcasts,
  USAGE_TEXT, WRONG_CHANNEL_TEXT, UNAVAILABLE_TEXT, QUEUE_FULL_TEXT, POST_FAILED_TEXT,
} from '../fix-command.js';

const CH = 'C-FIX';

function setup(apiResult = { status: 202, body: { taskId: 'T-1' } }, healthResult = { status: 200, body: { up: true, queueFull: false, queueMax: 20 } }) {
  const log = [];
  const api = {
    health: async () => {
      log.push(['health']);
      if (healthResult instanceof Error) throw healthResult;
      return healthResult;
    },
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
  assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health', 'message', 'post']);
  assert.equal(s.log[2][1].channel, CH);
  assert.equal(s.log[2][1].text, '<@U1> 提交了修复请求：购买按钮拼错了');
  assert.equal(s.log[2][1].thread_ts, undefined);
  assert.deepEqual(s.log[3][1], {
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

test('/fix 健康检查连不上、超时、5xx、非 200：只回临时消息，不发任务消息，不 POST', async () => {
  for (const health of [new Error('down'), { status: 503, body: null }, { status: 500, body: null }, { status: 404, body: {} }]) {
    const s = setup(undefined, health);
    const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
    await s.run({}, handler);
    assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health']);
    assert.deepEqual(s.responses, [{ response_type: 'ephemeral', text: UNAVAILABLE_TEXT }]);
  }
});

test('/fix 队列已满：只回临时消息，不发任务消息，不 POST', async () => {
  const s = setup(undefined, { status: 200, body: { up: true, queueFull: true, queueMax: 20 } });
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({}, handler);
  assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health']);
  assert.deepEqual(s.responses, [{ response_type: 'ephemeral', text: QUEUE_FULL_TEXT }]);
});

test('/fix 5xx、网络错误（健康检查通过之后）：在任务讨论串里回服务连不上', async () => {
  for (const result of [{ status: 503, body: null }, new Error('down')]) {
    const s = setup(result);
    const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
    await s.run({}, handler);
    const last = s.log.at(-1)[1];
    assert.equal(last.thread_ts, '100.001');
    assert.equal(last.text, UNAVAILABLE_TEXT);
    assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health', 'message', 'post', 'message']);
    assert.equal(s.responses.length, 0);
  }
});

test('/fix 4xx：不另外说话', async () => {
  const s = setup({ status: 422, body: { error: 'channel_not_bound' } });
  const handler = createFixCommandHandler({ api: s.api, postMessage: s.postMessage, fixChannelId: CH });
  await s.run({}, handler);
  assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health', 'message', 'post']);
  assert.equal(s.responses.length, 0);
});

test('/fix 任务消息发不出去（例如机器人不在频道里）：临时消息告诉发起人，不 POST', async () => {
  for (const failure of [
    async () => { throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } }); },
    async () => ({ ok: true }),
  ]) {
    const s = setup();
    const logs = [];
    const handler = createFixCommandHandler({
      api: s.api, postMessage: failure, fixChannelId: CH, log: (l) => logs.push(l),
    });
    await s.run({}, handler);
    assert.deepEqual(s.log.map(([k]) => k), ['ack', 'health']);
    assert.deepEqual(s.responses, [{ response_type: 'ephemeral', text: POST_FAILED_TEXT }]);
    assert.equal(logs.length, 1);
  }
});
