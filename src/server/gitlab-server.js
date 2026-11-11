import { createServer } from 'node:http';
import { createGitlabClient, GitlabApiError } from './gitlab-client.js';

const DEFAULT_GITLAB_URL = 'https://gitlab.loc';
const DEFAULT_PROJECT = 'account-platform/free-to-play-pc';

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

export function createGitlabServer({
  token = process.env.GITLAB_TOKEN,
  gitlabUrl = process.env.GITLAB_URL || DEFAULT_GITLAB_URL,
  project = process.env.GITLAB_PROJECT || DEFAULT_PROJECT,
  branch = process.env.GITLAB_BRANCH || 'master',
  fetchImpl = fetch,
} = {}) {
  const client = createGitlabClient({ token, gitlabUrl, project, fetchImpl });

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
    if (!token) {
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
        sendJson(response, 200, await client.getMergeRequestChecks(iid));
      } else {
        const data = await client.getBranch(branch);
        if (typeof data?.commit?.id !== 'string') throw new Error('缺少 commit ID');
        sendJson(response, 200, {
          ok: true,
          project,
          branch: data.name,
          commit: data.commit.id,
        });
      }
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error: error instanceof GitlabApiError ? error.message : 'GitLab 连接失败',
      });
    }
  });
}
