const TEST_REPLY = '已收到你的消息。当前是 Slack 接入测试，不会创建 Jira 工单或 GitLab MR。';

export function createDmHandler({ postMessage, now = Date.now }) {
  const recent = new Map();
  const lifetimeMs = 60 * 60 * 1000;

  return async function handleDm({ event, body }) {
    if (
      event?.type !== 'message' ||
      event.channel_type !== 'im' ||
      event.subtype !== undefined ||
      event.bot_id ||
      !event.user ||
      !event.channel ||
      !event.ts ||
      typeof event.text !== 'string' ||
      !event.text.trim()
    ) {
      return;
    }

    const time = now();
    for (const [id, entry] of recent) {
      if (time - entry.time > lifetimeMs) recent.delete(id);
    }
    const id = body?.event_id || `${event.channel}:${event.ts}`;
    if (recent.has(id)) return recent.get(id).pending;

    const pending = Promise.resolve().then(() => postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: TEST_REPLY,
    }));
    recent.set(id, { time, pending });
    try {
      await pending;
    } catch (error) {
      recent.delete(id);
      throw error;
    }
  };
}
