import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileCursorStore, createMemoryCursorStore, createOutboxRelay } from '../outbox-relay.js';

const msg = (seq) => ({ seq, channel: 'C1', threadTs: '1.1', text: `m${seq}` });
const slackError = (code) => Object.assign(new Error(code), { code: 'slack_webapi_platform_error', data: { error: code } });

function fakeOutbox(all) {
  const calls = [];
  return {
    calls,
    getOutbox: async (after, limit) => {
      calls.push([after, limit]);
      const messages = all.filter((m) => m.seq > after).slice(0, limit);
      return { status: 200, body: { messages, next: messages.at(-1)?.seq ?? after } };
    },
  };
}

test('按顺序发送，每条成功后存游标，参数里有 thread_ts 且不展开链接', async () => {
  const api = fakeOutbox([msg(1), msg(2), msg(3)]);
  const sent = [];
  const saved = [];
  const store = { load: async () => 0, save: async (v) => { saved.push(v); } };
  const relay = createOutboxRelay({ api, postMessage: async (m) => { sent.push(m); }, cursorStore: store });
  assert.equal(await relay.tick(), 3);
  assert.deepEqual(sent[0], { channel: 'C1', thread_ts: '1.1', text: 'm1', unfurl_links: false, unfurl_media: false });
  assert.deepEqual(sent.map((m) => m.text), ['m1', 'm2', 'm3']);
  assert.deepEqual(saved, [1, 2, 3]);
  assert.equal(await relay.tick(), 0);
  assert.equal(api.calls.at(-1)[0], 3);
});

test('分页：超过一页继续拉', async () => {
  const api = fakeOutbox([msg(1), msg(2), msg(3)]);
  const sent = [];
  const relay = createOutboxRelay({ api, postMessage: async (m) => { sent.push(m.text); }, cursorStore: createMemoryCursorStore(), pageSize: 2 });
  await relay.tick();
  assert.deepEqual(sent, ['m1', 'm2', 'm3']);
});

test('可重试的失败（限流、不在频道）：停在这一条，下一轮从这条重发', async () => {
  for (const code of ['ratelimited', 'not_in_channel']) {
    const api = fakeOutbox([msg(1), msg(2), msg(3)]);
    const sent = [];
    const logs = [];
    let fail = true;
    const store = createMemoryCursorStore();
    const relay = createOutboxRelay({
      api, cursorStore: store, log: (l) => logs.push(l),
      postMessage: async (m) => {
        if (m.text === 'm2' && fail) throw slackError(code);
        sent.push(m.text);
      },
    });
    assert.equal(await relay.tick(), 1);
    assert.deepEqual(sent, ['m1']);
    assert.equal(await store.load(), 1);
    assert.match(logs.join(), new RegExp(code));
    fail = false;
    await relay.tick();
    assert.deepEqual(sent, ['m1', 'm2', 'm3']);
    assert.equal(await store.load(), 3);
  }
});

test('永久失败（频道已归档、不存在等）：记录后跳过，不挡住后面的消息', async () => {
  const api = fakeOutbox([msg(1), msg(2), msg(3)]);
  const sent = [];
  const logs = [];
  const store = createMemoryCursorStore();
  const relay = createOutboxRelay({
    api, cursorStore: store, log: (l) => logs.push(l),
    postMessage: async (m) => {
      if (m.text === 'm2') throw slackError('is_archived');
      sent.push(m.text);
    },
  });
  assert.equal(await relay.tick(), 2);
  assert.deepEqual(sent, ['m1', 'm3']);
  assert.equal(await store.load(), 3);
  assert.match(logs.join(), /第 2 条无法发送，已跳过：is_archived/);
});

test('缺 channel、threadTs 或 text 的消息不发，但游标照样前进', async () => {
  const api = fakeOutbox([{ seq: 1, channel: 'C1', threadTs: '1.1', text: '' }, msg(2)]);
  const sent = [];
  const store = createMemoryCursorStore();
  const relay = createOutboxRelay({ api, postMessage: async (m) => { sent.push(m.text); }, cursorStore: store });
  assert.equal(await relay.tick(), 1);
  assert.deepEqual(sent, ['m2']);
  assert.equal(await store.load(), 2);
});

test('没有游标（第一次启动）：跳到最新一条之后，不重发已有消息，之后的新消息照常发', async () => {
  const all = [msg(1), msg(2), msg(3)];
  const api = fakeOutbox(all);
  const sent = [];
  const logs = [];
  let saved = null;
  const store = { load: async () => saved, save: async (v) => { saved = v; } };
  const relay = createOutboxRelay({
    api, cursorStore: store, pageSize: 2, log: (l) => logs.push(l),
    postMessage: async (m) => { sent.push(m.text); },
  });
  assert.equal(await relay.tick(), 0);
  assert.deepEqual(sent, []);
  assert.equal(saved, 3);
  assert.match(logs.join(), /跳过 3 条/);
  all.push(msg(4));
  assert.equal(await relay.tick(), 1);
  assert.deepEqual(sent, ['m4']);
});

test('没有游标且发件箱读不到：不发、不存游标，下一轮再试', async () => {
  let down = true;
  const inner = fakeOutbox([msg(1)]);
  const api = { getOutbox: async (...a) => (down ? { status: 503, body: null } : inner.getOutbox(...a)) };
  let saved = null;
  const store = { load: async () => saved, save: async (v) => { saved = v; } };
  const sent = [];
  const relay = createOutboxRelay({ api, cursorStore: store, postMessage: async (m) => { sent.push(m.text); } });
  assert.equal(await relay.tick(), 0);
  assert.equal(saved, null);
  down = false;
  assert.equal(await relay.tick(), 0);
  assert.equal(saved, 1);
  assert.deepEqual(sent, []);
});

test('接口失败不抛错，下一轮继续', async () => {
  let down = true;
  const inner = fakeOutbox([msg(1)]);
  const api = { getOutbox: async (...a) => { if (down) throw new Error('net'); return inner.getOutbox(...a); } };
  const sent = [];
  const relay = createOutboxRelay({ api, postMessage: async (m) => { sent.push(m.text); }, cursorStore: createMemoryCursorStore() });
  assert.equal(await relay.tick(), 0);
  down = false;
  assert.equal(await relay.tick(), 1);
});

test('同时只跑一轮 tick', async () => {
  const api = fakeOutbox([msg(1), msg(2)]);
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const relay = createOutboxRelay({
    api, cursorStore: createMemoryCursorStore(),
    postMessage: async (m) => { await gate; sent.push(m.text); },
  });
  const a = relay.tick();
  const b = relay.tick();
  release();
  await Promise.all([a, b]);
  assert.deepEqual(sent, ['m1', 'm2']);
  assert.equal(api.calls.length, 1);
});

test('start 定时拉取，stop 等当前一轮结束', async () => {
  const all = [msg(1)];
  const api = fakeOutbox(all);
  const sent = [];
  const relay = createOutboxRelay({ api, postMessage: async (m) => { sent.push(m.text); }, cursorStore: createMemoryCursorStore(), intervalMs: 10 });
  relay.start();
  await new Promise((r) => setTimeout(r, 30));
  all.push(msg(2));
  await new Promise((r) => setTimeout(r, 40));
  await relay.stop();
  assert.deepEqual(sent, ['m1', 'm2']);
});

test('文件游标：不存在或内容不对时为 null，保存后可读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-'));
  const path = join(dir, 'sub', 'outbox-cursor');
  const store = createFileCursorStore(path);
  assert.equal(await store.load(), null);
  await store.save(42);
  assert.equal((await readFile(path, 'utf8')).trim(), '42');
  assert.equal(await createFileCursorStore(path).load(), 42);
  await writeFile(path, 'abc\n');
  assert.equal(await createFileCursorStore(path).load(), null);
});
