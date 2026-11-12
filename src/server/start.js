import '../config/load-local-env.js';
import { createGitlabConnection } from '../gitlab/connection.js';
import { createLocalServer } from './local-server.js';

const port = Number(process.env.PORT || 4000);

const connection = createGitlabConnection();
const server = createLocalServer({ connection });
server.listen(port, '127.0.0.1', () => {
  console.info(`本地服务已启动：http://127.0.0.1:${server.address().port}`);
});
