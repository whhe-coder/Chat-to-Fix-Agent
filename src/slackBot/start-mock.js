import '../load-local-env.js';
import { createMockSlackServer } from './mock-slack-bot.js';

const port = Number(process.env.MOCK_SLACK_PORT || 4001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MOCK_SLACK_PORT 必须是 1 到 65535 的整数');
}

createMockSlackServer().listen(port, '127.0.0.1', () => {
  console.info(`模拟 Slack Bot 已启动：http://127.0.0.1:${port}`);
});
