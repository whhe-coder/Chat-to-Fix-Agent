import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileCursorStore, createMemoryCursorStore, createOutboxRelay } from '../src/slackBot/outbox-relay.js';

const msg = (seq) => ({ seq, channel: 'C1', threadTs: '1.1', text: `m${seq}` });

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

test('发送失败就停，保持顺序，下一轮从失败那条重试', async () => {
  const api = fakeOutbox([msg(1), msg(2), msg(3)]);
  const sent = [];
  const logs = [];
  let fail = true;
  const store = createMemoryCursorStore();
  const relay = createOutboxRelay({
    api, cursorStore: store, log: (l) => logs.push(l),
    postMessage: async (m) => {
      if (m.text === 'm2' && fail) throw Object.assign(new Error('x'), { data: { error: 'ratelimited' } });
      sent.push(m.text);
    },
  });
  assert.equal(await relay.tick(), 1);
  assert.deepEqual(sent, ['m1']);
  assert.equal(await store.load(), 1);
  assert.match(logs.join(), /ratelimited/);
  fail = false;
  await relay.tick();
  assert.deepEqual(sent, ['m1', 'm2', 'm3']);
  assert.equal(await store.load(), 3);
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
  assert.equal(api.calls.length, 1); // 只拉了一页，没有第二轮并行
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

test('文件游标：不存在为 0，保存后可读回，重启接着发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-'));
  const path = join(dir, 'sub', 'outbox-cursor');
  const store = createFileCursorStore(path);
  assert.equal(await store.load(), 0);
  await store.save(42);
  assert.equal((await readFile(path, 'utf8')).trim(), '42');
  assert.equal(await createFileCursorStore(path).load(), 42);
});
