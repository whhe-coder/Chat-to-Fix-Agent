import '../load-local-env.js';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createMockChannel, createMockChannelServer } from './mock-channel.js';

const port = Number(process.env.MOCK_SLACK_PORT || 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_SLACK_PORT 必须是 1 到 65535 的整数');

const dataRoot = resolve(process.env.CHAT_TO_FIX_DATA || 'src/chat-to-fix/.data/connected');
const channel = createMockChannel({
  agentUrl: process.env.MOCK_SLACK_AGENT_URL || 'http://127.0.0.1:3090',
  channelId: process.env.CHAT_TO_FIX_SLACK_CHANNEL || 'CLOCAL',
  userId: process.env.MOCK_SLACK_USER_ID || 'UMOCK',
  userName: process.env.MOCK_SLACK_USER_NAME || '模拟用户',
  userEmail: process.env.MOCK_SLACK_USER_EMAIL || 'mock.user@example.com',
  tokenProvider: () => process.env.CHAT_TO_FIX_HTTP_TOKEN || readFileSync(join(dataRoot, 'http-token'), 'utf8'),
});

createMockChannelServer({ channel, serviceId: process.env.MOCK_SLACK_SERVICE_ID }).listen(port, '127.0.0.1', () => {
  console.info(`模拟 Slack 频道已启动：http://127.0.0.1:${port}`);
});
