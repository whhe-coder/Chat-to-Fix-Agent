// /fix 命令的处理（行为见 docs/chat-to-fix/slack/slackenter.md 2.1；不处理讨论串里的 @）。

export const USAGE_TEXT = '用法：/fix 问题描述，例如：/fix 登录页的“忘记密码”链接点了没反应。';
export const WRONG_CHANNEL_TEXT = '请在指定频道里用 /fix。';
export const UNAVAILABLE_TEXT = 'Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。';
export const QUEUE_FULL_TEXT = '修复队列已满，这次请求没有接收，请稍后再试。';
export const POST_FAILED_TEXT = '机器人没能在频道里发出任务消息，这次请求没有开始处理。请稍后再试；一直这样请联系维护人员。';

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
const errorCode = (error) => error?.data?.error || error?.code || error?.name || 'unknown';

export function createFixCommandHandler({
  api, postMessage, fixChannelId, now = Date.now, log = () => {},
}) {
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

    // 发任务消息之前先看服务：连不上或队列满，就只回临时消息，频道里不留任务消息。
    let health;
    try {
      health = await api.health();
    } catch {
      health = { status: 503 };
    }
    if (health.status !== 200) {
      await respond({ response_type: 'ephemeral', text: UNAVAILABLE_TEXT });
      return;
    }
    if (health.body?.queueFull === true) {
      await respond({ response_type: 'ephemeral', text: QUEUE_FULL_TEXT });
      return;
    }

    // 任务消息发不出去（例如机器人不在频道里）时，用 response_url 告诉发起人；它不需要机器人在频道里。
    let ts;
    try {
      const posted = await postMessage({
        channel: fixChannelId,
        text: `<@${command.user_id}> 提交了修复请求：${neutralizeBroadcasts(text)}`,
        unfurl_links: false,
        unfurl_media: false,
      });
      ts = posted?.ts;
      if (!ts) throw new Error('no_ts');
    } catch (error) {
      log(`任务消息发送失败：${errorCode(error)}`);
      await respond({ response_type: 'ephemeral', text: POST_FAILED_TEXT });
      return;
    }

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
      // 健康检查通过后才失败，少见的竞态：任务消息已发出，在讨论串里说明。
      await postMessage({ channel: fixChannelId, thread_ts: ts, text: UNAVAILABLE_TEXT });
    }
    // 4xx：Chat-to-Fix 已把说明放进发件箱，这里不说话。
  };
}
