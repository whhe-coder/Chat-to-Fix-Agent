import { execFileSync } from 'node:child_process';
import { createGitlabServer } from './gitlab-server.js';

function readGitlabToken() {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('security', [
      'find-generic-password',
      '-a', 'local-agent',
      '-s', 'Chat-to-Fix-Agent/GITLAB_TOKEN',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const port = Number(process.env.PORT || 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1 到 65535 的整数');
}

const server = createGitlabServer({ token: readGitlabToken() });
server.listen(port, '127.0.0.1', () => {
  console.info(`本地服务已启动：http://127.0.0.1:${port}`);
});
