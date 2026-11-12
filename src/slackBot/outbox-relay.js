// 把 Chat-to-Fix 发件箱里的消息发到 Slack 讨论串（规格见 spec/slackbot.md 4.2(2)）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createMemoryCursorStore(initial = 0) {
  let seq = initial;
  return { load: async () => seq, save: async (value) => { seq = value; } };
}

export function createFileCursorStore(path) {
  return {
    async load() {
      try {
        const value = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
        return Number.isInteger(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    async save(seq) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${seq}\n`);
      await rename(temp, path);
    },
  };
}

export function createOutboxRelay({
  api, postMessage, cursorStore, intervalMs = 3000, pageSize = 50, log = () => {},
}) {
  let cursor = null;
  let running = null;
  let timer = null;

  async function drain() {
    if (cursor === null) cursor = await cursorStore.load();
    let delivered = 0;
    for (;;) {
      const { status, body } = await api.getOutbox(cursor, pageSize);
      if (status !== 200 || !Array.isArray(body?.messages)) {
        log(`发件箱读取失败：HTTP ${status}`);
        return delivered;
      }
      for (const message of body.messages) {
        if (message.channel && message.threadTs && message.text) {
          try {
            await postMessage({
              channel: message.channel,
              thread_ts: message.threadTs,
              text: message.text,
              unfurl_links: false,
              unfurl_media: false,
            });
          } catch (error) {
            // 停在这一条，保持顺序，下一轮重试。
            log(`发件箱第 ${message.seq} 条发送失败：${error?.data?.error || error?.code || error?.name || 'unknown'}`);
            return delivered;
          }
          delivered += 1;
        }
        cursor = message.seq;
        await cursorStore.save(cursor);
      }
      if (body.messages.length < pageSize) return delivered;
    }
  }

  function tick() {
    if (running) return running;
    running = drain()
      .catch((error) => {
        log(`发件箱转发出错：${error?.code || error?.name || 'unknown'}`);
        return 0;
      })
      .finally(() => { running = null; });
    return running;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
  };
}
