// /fix 命令的处理（行为见 docs/chat-to-fix/slack/architecture.md 第 4 节和 spec/slack-fix-command.md；不处理讨论串里的 @）。

export const USAGE_TEXT = '用法：/fix 问题描述，例如：/fix 登录页的“忘记密码”链接点了没反应。';
export const WRONG_CHANNEL_TEXT = '请在指定频道里用 /fix。';
export const UNAVAILABLE_TEXT = 'Chat-to-Fix 服务暂时连不上，这次请求没有开始处理，请稍后再用 /fix 提交。';
export const QUEUE_FULL_TEXT = '修复队列已满，这次请求没有接收，请稍后再试。';
export const POST_FAILED_TEXT = '机器人没能在频道里发出任务消息，这次请求没有开始处理。请稍后再试；一直这样请联系维护人员。';
export const SUPERSEDED_TEXT = '这条 /fix 已被你后一条替代，只处理最后一条。';
export const MISCONFIGURED_TEXT = '机器人配置有误（频道和服务不一致），这次请求没有开始处理，请联系维护人员。';
export const MAYBE_STARTED_TEXT = '请求可能已经开始处理，请先看本讨论串后面的消息，不要重复提交。';

const LIFETIME_MS = 60 * 60 * 1000;
// 5 秒是初始尝试值，后续按实际使用情况调优（Logan 2026-11-14 的意见）。
export const DEBOUNCE_MS = 5000;
export const RETRY_DELAY_MS = 2000;

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

const errorCode = (error) => error?.data?.error || error?.code || error?.name || 'unknown';
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 交给 Agent：失败（网络错误、超时、5xx）时用同一个 eventId 重发一次，Agent 按 eventId 去重，不会建第二个任务。
// 返回 'ok'（2xx、4xx：4xx 的说明由 Agent 放进发件箱）、'not_started'（连不上，请求没到 Agent）或 'unknown'。
async function deliver(api, body, retryDelayMs) {
  let outcome = 'unknown';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await wait(retryDelayMs);
    try {
      const result = await api.postEvent(body);
      if (result.status < 500) return 'ok';
      outcome = 'unknown';
    } catch (error) {
      outcome = error?.code === 'CHAT_TO_FIX_NETWORK' && error?.reason === 'ECONNREFUSED' ? 'not_started' : 'unknown';
    }
  }
  return outcome;
}

export function createFixCommandHandler({
  api, postMessage, fixChannelId, now = Date.now, log = () => {},
  debounceMs = DEBOUNCE_MS, retryDelayMs = RETRY_DELAY_MS,
}) {
  const firstTime = createSeen(now);
  // 防抖：同一人同一频道，等 debounceMs 没有新的 /fix 才处理；期间再发就替代前一条。
  const pending = new Map();

  async function process(command, respond) {
    const text = command.text.trim();

    // 发任务消息之前先看服务：连不上、队列满或频道不对，就只回临时消息，频道里不留任务消息。
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
    const channels = health.body?.channels;
    if (Array.isArray(channels) && !channels.includes(fixChannelId)) {
      log(`频道不一致：Bot 是 ${fixChannelId}，Agent 绑定的是 ${channels.join(', ') || '（无）'}`);
      await respond({ response_type: 'ephemeral', text: MISCONFIGURED_TEXT });
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

    const outcome = await deliver(api, {
      source: 'fix',
      eventId: `slash:${command.trigger_id}`,
      channel: fixChannelId,
      threadTs: ts,
      messageTs: ts,
      user: { id: command.user_id, ...(command.user_name ? { name: command.user_name } : {}) },
      text,
    }, retryDelayMs);
    if (outcome === 'not_started') {
      await postMessage({ channel: fixChannelId, thread_ts: ts, text: UNAVAILABLE_TEXT });
    } else if (outcome === 'unknown') {
      log(`交给 Agent 两次都没有确定结果：slash:${command.trigger_id}`);
      await postMessage({ channel: fixChannelId, thread_ts: ts, text: MAYBE_STARTED_TEXT });
    }
  }

  return async function handleFix({ command, ack, respond }) {
    await ack(); // 先确认，Slack 只给 3 秒。
    const triggerId = command?.trigger_id;
    if (triggerId && !firstTime(triggerId)) return;

    // 先判频道再判正文：其他频道里不管有没有正文，都提示去指定频道。
    if (!fixChannelId || command?.channel_id !== fixChannelId) {
      await respond({ response_type: 'ephemeral', text: WRONG_CHANNEL_TEXT });
      return;
    }
    const text = typeof command?.text === 'string' ? command.text.trim() : '';
    if (!text) {
      await respond({ response_type: 'ephemeral', text: USAGE_TEXT });
      return;
    }

    const key = `${command.user_id}:${command.channel_id}`;
    const previous = pending.get(key);
    if (previous) {
      clearTimeout(previous.timer);
      previous.done();
      await previous.respond({ response_type: 'ephemeral', text: SUPERSEDED_TEXT });
    }
    // 返回的 promise 在这条处理完（或被替代）时结束，便于测试；Bolt 只要求先 ack。
    await new Promise((done) => {
      const entry = { respond, done };
      entry.timer = setTimeout(() => {
        if (pending.get(key) === entry) pending.delete(key);
        process(command, respond)
          .catch((error) => log(`/fix 处理出错：${errorCode(error)}`))
          .finally(done);
      }, debounceMs);
      pending.set(key, entry);
    });
  };
}
