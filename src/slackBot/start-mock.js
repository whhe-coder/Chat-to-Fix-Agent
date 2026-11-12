import '../config/load-local-env.js';
import { createMockSlackBot, createMockSlackServer } from './mock-slack-bot.js';
import { createChatToFixApi } from './chat-to-fix-api.js';

const port = Number(process.env.MOCK_SLACK_PORT || 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MOCK_SLACK_PORT 必须是 1 到 65535 的整数');
}

const bot = createMockSlackBot({
  api: createChatToFixApi({
    baseUrl: process.env.CHAT_TO_FIX_API_URL || 'http://127.0.0.1:3090',
    token: process.env.CHAT_TO_FIX_API_TOKEN || '',
  }),
  fixChannelId: process.env.CHAT_TO_FIX_SLACK_CHANNEL || 'C-MOCK-FIX',
});
bot.startRelay();

createMockSlackServer({ bot }).listen(port, '127.0.0.1', () => {
  console.info(`模拟 Slack Bot 已启动：http://127.0.0.1:${port}`);
});
