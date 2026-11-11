import { createServer } from 'node:http';
import { createGitlabConnection } from '../gitlab/connection.js';
import { GitlabApiError } from '../gitlab/client.js';

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

export function createGitlabServer({
  connection,
  token = process.env.GITLAB_TOKEN || '',
  gitlabUrl,
  project,
  branch = process.env.GITLAB_BRANCH || 'master',
  fetchImpl = fetch,
} = {}) {
  const gitlab = connection ?? createGitlabConnection({ token, gitlabUrl, project, fetchImpl });

  return createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: '仅支持 GET' });
      return;
    }
    if (path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    const checks = /^\/gitlab\/merge-requests\/([1-9]\d*)\/checks$/.exec(path);
    if (path !== '/gitlab/status' && !checks) {
      sendJson(response, 404, { ok: false, error: '路径不存在' });
      return;
    }
    if (!gitlab.configured) {
      sendJson(response, 503, { ok: false, error: '找不到 GitLab token' });
      return;
    }

    try {
      if (checks) {
        const iid = Number(checks[1]);
        if (!Number.isSafeInteger(iid)) {
          sendJson(response, 400, { ok: false, error: 'MR IID 无效' });
          return;
        }
        sendJson(response, 200, await gitlab.getMergeRequestChecks(iid));
      } else {
        sendJson(response, 200, { ok: true, ...await gitlab.checkConnection(branch) });
      }
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error: error instanceof GitlabApiError ? error.message : 'GitLab 连接失败',
      });
    }
  });
}
