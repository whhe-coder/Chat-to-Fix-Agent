import '../load-local-env.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, LogLevel } from '@slack/bolt';
import { createChatToFixApi } from './chat-to-fix-api.js';
import { createFixCommandHandler } from './fix-command.js';
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

// Chat-to-Fix 接口令牌：和模拟频道（start-mock-channel.js）同一个来源，每次请求时读取，Agent 重启换令牌后不用重启 Bot。
const dataRoot = resolve(process.env.CHAT_TO_FIX_DATA || 'src/chat-to-fix/.data/connected');
function readAgentToken() {
  if (process.env.CHAT_TO_FIX_HTTP_TOKEN) return process.env.CHAT_TO_FIX_HTTP_TOKEN;
  try {
    return readFileSync(join(dataRoot, 'http-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const fixChannelId = process.env.CHAT_TO_FIX_SLACK_CHANNEL;
if (!fixChannelId) {
  console.error('缺少 CHAT_TO_FIX_SLACK_CHANNEL：请填写指定频道的 ID（见 config/local-env/README.md），否则不启动。');
  process.exit(1);
}

const stateDir = process.env.SLACK_BOT_STATE_DIR || fileURLToPath(new URL('./.data/', import.meta.url));
const log = (line) => console.error(line);

const app = new App({
  token: readToken('SLACK_BOT_TOKEN'),
  appToken: readToken('SLACK_APP_TOKEN'),
  socketMode: true,
  logLevel: LogLevel.WARN,
});
const agentUrl = process.env.CHAT_TO_FIX_API_URL || 'http://127.0.0.1:3090';
const api = createChatToFixApi({ baseUrl: agentUrl, token: readAgentToken });
const postMessage = (message) => app.client.chat.postMessage(message);

app.command('/fix', createFixCommandHandler({ api, postMessage, fixChannelId, log }));

app.error(async (error) => {
  console.error('Slack 事件处理失败：', error?.code || error?.name || 'unknown');
});

const relay = createOutboxRelay({
  api,
  postMessage,
  cursorStore: createFileCursorStore(resolve(stateDir, 'outbox-cursor')),
  log,
});

// 启动时核对频道（architecture.md 4.3）：Agent 在线且绑定的频道里没有本频道，就不启动；Agent 没开或没有 channels 字段，照常启动。
try {
  const { status, body } = await api.health();
  if (status === 200 && Array.isArray(body?.channels) && !body.channels.includes(fixChannelId)) {
    console.error(`频道不一致：CHAT_TO_FIX_SLACK_CHANNEL 是 ${fixChannelId}，Agent 绑定的是 ${body.channels.join(', ') || '（无）'}。改成一致后再启动。`);
    process.exit(1);
  }
} catch {
  console.warn('启动时连不上 Chat-to-Fix，先照常启动；每次 /fix 仍会检查服务和频道。');
}

try {
  await app.start();
  relay.start();
  console.info('Slack Bot 已连接：/fix 和发件箱转发已启动。');
} catch (error) {
  console.error('Slack 连接失败：', error?.code || error?.name || 'unknown');
  process.exitCode = 1;
}
