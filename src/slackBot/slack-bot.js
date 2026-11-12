import '../load-local-env.js';
import { execFileSync } from 'node:child_process';
import { App, LogLevel } from '@slack/bolt';
import { createDmHandler } from './slack-message.js';

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

const app = new App({
  token: readToken('SLACK_BOT_TOKEN'),
  appToken: readToken('SLACK_APP_TOKEN'),
  socketMode: true,
  logLevel: LogLevel.WARN,
});
const handleDm = createDmHandler({
  postMessage: (message) => app.client.chat.postMessage(message),
});

app.event('message', async ({ event, body }) => {
  await handleDm({ event, body });
});

app.error(async (error) => {
  console.error('Slack 事件处理失败：', error?.code || error?.name || 'unknown');
});

try {
  await app.start();
  console.info('Slack 私信测试 Bot 已连接。');
} catch (error) {
  console.error('Slack 连接失败：', error?.code || error?.name || 'unknown');
  process.exitCode = 1;
}
