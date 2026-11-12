import '../config/load-local-env.js';
import { createGitlabConnection } from '../gitlab/connection.js';
import { createLocalServer } from './local-server.js';

// 固定端口填 1 到 65535；填 0 时由系统分配临时端口。
const port = Number(process.env.PORT || 4000);

const connection = createGitlabConnection();
const server = createLocalServer({ connection });
server.listen(port, '127.0.0.1', () => {
  console.info(`本地服务已启动：http://127.0.0.1:${server.address().port}`);
});
