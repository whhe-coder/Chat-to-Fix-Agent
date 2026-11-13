// 把 Chat-to-Fix 发件箱里的消息发到 Slack 讨论串（接口见 docs/chat-to-fix/slack/slackbot.md 4.2(2)，
// 游标规则见 docs/chat-to-fix/slack/architecture.md 4.4）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Slack 返回这些错误时，重发同一条也不会成功：记录后跳过，不挡住后面的消息。
// not_in_channel、限流和网络错误不在这里：机器人被拉回频道或稍后重试就能发出，所以停在这一条。
export const PERMANENT_POST_ERRORS = new Set(['channel_not_found', 'is_archived', 'msg_too_long', 'no_text']);

// 游标是 { outboxId, seq }：seq 是已发出的最后一条；outboxId 是这条所在发件箱的编号（Agent 没给编号时为 null）。
const cursorOf = (value) => {
  if (Number.isInteger(value) && value >= 0) return { outboxId: null, seq: value };
  if (value && Number.isInteger(value.seq) && value.seq >= 0) {
    return { outboxId: typeof value.outboxId === 'string' && value.outboxId !== '' ? value.outboxId : null, seq: value.seq };
  }
  return null;
};

export function createMemoryCursorStore(initial = 0) {
  let cursor = cursorOf(initial);
  return { load: async () => cursor, save: async (value) => { cursor = cursorOf(value); } };
}

// 文件内容是 JSON `{"outboxId":"…","seq":3}`；旧格式（只有数字）当作编号未知的同一个发件箱。
// 文件不存在或内容不对时 load 返回 null，表示还没有游标（第一次启动）。
export function createFileCursorStore(path) {
  return {
    async load() {
      let raw;
      try {
        raw = (await readFile(path, 'utf8')).trim();
      } catch {
        return null;
      }
      if (/^\d+$/.test(raw)) return cursorOf(Number(raw));
      try {
        return cursorOf(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async save(value) {
      const cursor = cursorOf(value);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${JSON.stringify(cursor)}\n`);
      await rename(temp, path);
    },
  };
}

const errorCode = (error) => error?.data?.error || error?.code || error?.name || 'unknown';
const idOf = (body) => (typeof body?.outboxId === 'string' && body.outboxId !== '' ? body.outboxId : null);

export function createOutboxRelay({
  api, postMessage, cursorStore, intervalMs = 3000, pageSize = 50, log = () => {},
}) {
  let cursor = null;
  let running = null;
  let timer = null;

  async function read(after) {
    const { status, body } = await api.getOutbox(after, pageSize);
    if (status !== 200 || !Array.isArray(body?.messages)) {
      log(`发件箱读取失败：HTTP ${status}`);
      return null;
    }
    return body;
  }

  async function save(next) {
    cursor = next;
    await cursorStore.save(next);
  }

  // 没有游标时从发件箱最新一条之后开始，不把以前的消息重发一遍。
  async function skipToLatest() {
    const first = await read(0);
    if (first === null) return null;
    let after;
    if (Number.isInteger(first.lastSeq)) {
      after = first.lastSeq;
    } else {
      // Agent 还没有 lastSeq 字段：翻页找到最后一条。
      after = 0;
      let page = first;
      for (;;) {
        for (const message of page.messages) after = message.seq;
        if (page.messages.length < pageSize) break;
        page = await read(after);
        if (page === null) return null;
      }
    }
    log(`没有发件箱游标，从第 ${after} 条之后开始转发，跳过 ${after} 条已有消息`);
    return { outboxId: idOf(first), seq: after };
  }

  // 对照发件箱编号和最大序号，判断游标还能不能用。返回要用的游标。
  function reconcile(body) {
    const id = idOf(body);
    if (id === null) return cursor; // Agent 还没有编号：照旧
    if (cursor.outboxId === null) return { outboxId: id, seq: cursor.seq }; // 旧游标：补上编号
    if (cursor.outboxId !== id) {
      log(`发件箱编号变了（${cursor.outboxId} → ${id}），发件箱被重置过，从头转发`);
      return { outboxId: id, seq: 0 };
    }
    if (Number.isInteger(body.lastSeq) && cursor.seq > body.lastSeq) {
      log(`游标 ${cursor.seq} 大于发件箱最大序号 ${body.lastSeq}，改为 ${body.lastSeq}`);
      return { outboxId: id, seq: body.lastSeq };
    }
    return cursor;
  }

  async function drain() {
    if (cursor === null) {
      const loaded = cursorOf(await cursorStore.load());
      if (loaded !== null) {
        cursor = loaded;
      } else {
        const start = await skipToLatest();
        if (start === null) return 0;
        await save(start);
      }
    }
    let delivered = 0;
    for (;;) {
      const body = await read(cursor.seq);
      if (body === null) return delivered;
      const checked = reconcile(body);
      if (checked !== cursor) {
        const reread = checked.seq !== cursor.seq;
        await save(checked);
        if (reread) continue; // 游标挪了，这一页按旧游标读的，重新读
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
        await save({ outboxId: cursor.outboxId, seq: message.seq });
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
