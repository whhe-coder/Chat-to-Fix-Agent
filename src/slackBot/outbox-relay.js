// 把 Chat-to-Fix 发件箱里的消息发到 Slack 讨论串（接口见 docs/chat-to-fix/slack/slackbot.md 4.2(2)）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Slack 返回这些错误时，重发同一条也不会成功：记录后跳过，不挡住后面的消息。
// not_in_channel、限流和网络错误不在这里：机器人被拉回频道或稍后重试就能发出，所以停在这一条。
export const PERMANENT_POST_ERRORS = new Set(['channel_not_found', 'is_archived', 'msg_too_long', 'no_text']);

export function createMemoryCursorStore(initial = 0) {
  let seq = initial;
  return { load: async () => seq, save: async (value) => { seq = value; } };
}

// 文件不存在或内容不是非负整数时 load 返回 null，表示还没有游标（第一次启动）。
export function createFileCursorStore(path) {
  return {
    async load() {
      let raw;
      try {
        raw = (await readFile(path, 'utf8')).trim();
      } catch {
        return null;
      }
      return /^\d+$/.test(raw) ? Number(raw) : null;
    },
    async save(seq) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${seq}\n`);
      await rename(temp, path);
    },
  };
}

const errorCode = (error) => error?.data?.error || error?.code || error?.name || 'unknown';

export function createOutboxRelay({
  api, postMessage, cursorStore, intervalMs = 3000, pageSize = 50, log = () => {},
}) {
  let cursor = null;
  let running = null;
  let timer = null;

  // 没有游标时从发件箱最新一条之后开始，不把以前的消息重发一遍。
  async function skipToLatest() {
    let after = 0;
    let skipped = 0;
    for (;;) {
      const { status, body } = await api.getOutbox(after, pageSize);
      if (status !== 200 || !Array.isArray(body?.messages)) {
        log(`发件箱读取失败：HTTP ${status}`);
        return null;
      }
      for (const message of body.messages) after = message.seq;
      skipped += body.messages.length;
      if (body.messages.length < pageSize) break;
    }
    await cursorStore.save(after);
    log(`没有发件箱游标，从第 ${after} 条之后开始转发，跳过 ${skipped} 条已有消息`);
    return after;
  }

  async function drain() {
    if (cursor === null) {
      const loaded = await cursorStore.load();
      cursor = loaded ?? await skipToLatest();
      if (cursor === null) return 0;
    }
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
            delivered += 1;
          } catch (error) {
            const code = errorCode(error);
            if (!PERMANENT_POST_ERRORS.has(code)) {
              // 停在这一条，保持顺序，下一轮重试。
              log(`发件箱第 ${message.seq} 条发送失败，下一轮重试：${code}`);
              return delivered;
            }
            log(`发件箱第 ${message.seq} 条无法发送，已跳过：${code}`);
          }
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
        log(`发件箱转发出错：${errorCode(error)}`);
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
