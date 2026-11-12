// /fix 命令和讨论串里 @ 的处理（规格见 spec/slackenter.md 第 2 节）。

export const USAGE_TEXT = '用法：/fix 问题描述，例如：/fix 登录页的“忘记密码”链接点了没反应。';
export const WRONG_CHANNEL_TEXT = '请在指定频道里用 /fix。';
export const UNAVAILABLE_TEXT = 'Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。';
export const MENTION_UNAVAILABLE_TEXT = 'Chat-to-Fix 服务暂时连不上，这条补充没有送达，请稍后再 @ 我一次。';
export const NOT_IN_THREAD_TEXT = '新问题请用 /fix 提交。';

const LIFETIME_MS = 60 * 60 * 1000;

export function neutralizeBroadcasts(text) {
  return String(text)
    .replace(/<!(?:channel|here|everyone)(?:\|[^>]*)?>/g, '')
    .replace(/<!subteam\^[^>]*>/g, '')
    .replace(/@(?:channel|here|everyone)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 进程内去重，保留一小时（照 createDmHandler）。返回 true 表示第一次见。
function createSeen(now) {
  const recent = new Map();
  return function firstTime(id) {
    const time = now();
    for (const [key, at] of recent) {
      if (time - at > LIFETIME_MS) recent.delete(key);
    }
    if (recent.has(id)) return false;
    recent.set(id, time);
    return true;
  };
}

const isServiceDown = (status) => status >= 500;

export function createFixCommandHandler({ api, postMessage, fixChannelId, now = Date.now }) {
  const firstTime = createSeen(now);

  return async function handleFix({ command, ack, respond }) {
    await ack(); // 先确认，Slack 只给 3 秒。
    const triggerId = command?.trigger_id;
    if (triggerId && !firstTime(triggerId)) return;

    const text = typeof command?.text === 'string' ? command.text.trim() : '';
    if (!text) {
      await respond({ response_type: 'ephemeral', text: USAGE_TEXT });
      return;
    }
    if (!fixChannelId || command.channel_id !== fixChannelId) {
      await respond({ response_type: 'ephemeral', text: WRONG_CHANNEL_TEXT });
      return;
    }

    const posted = await postMessage({
      channel: fixChannelId,
      text: `<@${command.user_id}> 提交了修复请求：${neutralizeBroadcasts(text)}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    const ts = posted?.ts;
    if (!ts) throw new Error('任务消息没有返回 ts');

    let result;
    try {
      result = await api.postEvent({
        source: 'fix',
        eventId: `slash:${triggerId}`,
        channel: fixChannelId,
        threadTs: ts,
        messageTs: ts,
        user: { id: command.user_id, ...(command.user_name ? { name: command.user_name } : {}) },
        text,
      });
    } catch {
      result = { status: 503 };
    }
    if (isServiceDown(result.status)) {
      await postMessage({ channel: fixChannelId, thread_ts: ts, text: UNAVAILABLE_TEXT });
    }
    // 4xx：Chat-to-Fix 已把说明放进发件箱，这里不说话。
  };
}

export function createMentionHandler({
  api, fixChannelId, postEphemeral, postMessage, botUserId, now = Date.now,
}) {
  const firstTime = createSeen(now);

  function stripLeadingMention(text, botId) {
    const target = botId ? botId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Z0-9]+';
    return text.replace(new RegExp(`^\\s*<@${target}(?:\\|[^>]*)?>[:,，：]?\\s*`), '').trim();
  }

  return async function handleMention({ event, body }) {
    if (
      event?.type !== 'app_mention' ||
      event.bot_id ||
      event.subtype !== undefined ||
      event.edited ||
      !event.user ||
      !event.channel ||
      !event.ts ||
      typeof event.text !== 'string' ||
      event.channel !== fixChannelId
    ) {
      return;
    }
    const id = body?.event_id || `${event.channel}:${event.ts}`;
    if (!firstTime(id)) return;

    if (!event.thread_ts) {
      await postEphemeral({ channel: event.channel, user: event.user, text: NOT_IN_THREAD_TEXT });
      return;
    }
    const botId = botUserId ?? body?.authorizations?.[0]?.user_id;
    const text = stripLeadingMention(event.text, botId);
    if (!text) return;

    let result;
    try {
      result = await api.postEvent({
        source: 'mention',
        eventId: id,
        channel: event.channel,
        threadTs: event.thread_ts,
        messageTs: event.ts,
        user: { id: event.user },
        text,
      });
    } catch {
      result = { status: 503 };
    }
    if (isServiceDown(result.status) && postMessage) {
      await postMessage({
        channel: event.channel, thread_ts: event.thread_ts, text: MENTION_UNAVAILABLE_TEXT,
      });
    }
  };
}
