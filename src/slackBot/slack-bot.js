import '../config/load-local-env.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import { createChatToFixApi } from './chat-to-fix-api.js';
import { createFixCommandHandler, createMentionHandler } from './fix-command.js';
import { createFileCursorStore, createOutboxRelay } from './outbox-relay.js';

function readToken(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'darwin') {
    throw new Error(`请通过环境变量提供 ${name}`);
  }
  try {
    const value = execFileSync('security', [
      'find-generic-password',
      '-a', 'local-agent',
      '-s', `Chat-to-Fix-Agent/${name}`,
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value) return value;
  } catch {
    // 只报告凭据名称，不输出钥匙串错误或 token。
  }
  throw new Error(`找不到 ${name}；请先保存到 Mac 钥匙串或设置环境变量`);
}

const fixChannelId = process.env.CHAT_TO_FIX_SLACK_CHANNEL;
if (!fixChannelId) {
  console.error('缺少 CHAT_TO_FIX_SLACK_CHANNEL：请填写指定频道的 ID（见 config/local-env/README.md），否则不启动。');
  process.exit(1);
}

const stateDir = process.env.SLACK_BOT_STATE_DIR
  || fileURLToPath(new URL('../../.local/', import.meta.url));

const app = new App({
  token: readToken('SLACK_BOT_TOKEN'),
  appToken: readToken('SLACK_APP_TOKEN'),
  socketMode: true,
  logLevel: LogLevel.WARN,
});
const api = createChatToFixApi({
  baseUrl: process.env.CHAT_TO_FIX_API_URL || 'http://127.0.0.1:3090',
  token: readToken('CHAT_TO_FIX_API_TOKEN'),
});
const postMessage = (message) => app.client.chat.postMessage(message);

let botUserId;
try {
  botUserId = (await app.client.auth.test()).user_id;
} catch {
  // 取不到就用事件里的 authorizations。
}

app.command('/fix', createFixCommandHandler({ api, postMessage, fixChannelId }));
const handleMention = createMentionHandler({
  api,
  fixChannelId,
  botUserId,
  postMessage,
  postEphemeral: (message) => app.client.chat.postEphemeral(message),
});
app.event('app_mention', async ({ event, body }) => {
  await handleMention({ event, body });
});

app.error(async (error) => {
  console.error('Slack 事件处理失败：', error?.code || error?.name || 'unknown');
});

const relay = createOutboxRelay({
  api,
  postMessage,
  cursorStore: createFileCursorStore(resolve(stateDir, 'outbox-cursor')),
  log: (line) => console.error(line),
});

try {
  await app.start();
  relay.start();
  console.info('Slack Bot 已连接：/fix、讨论串 @ 和发件箱转发已启动。');
} catch (error) {
  console.error('Slack 连接失败：', error?.code || error?.name || 'unknown');
  process.exitCode = 1;
}
