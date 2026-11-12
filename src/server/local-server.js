import { createServer } from 'node:http';
import { createGitlabConnection } from '../gitlab/connection.js';
import { GitlabApiError } from '../gitlab/client.js';
import { createJiraConnection, JiraApiError, JiraInputError } from '../jira/connection.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

function verifyLocalWrite(request) {
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^127\.0\.0\.1:\d+$/.test(host)) {
    throw new HttpError(403, '只允许本机请求');
  }
  if (request.headers.origin && request.headers.origin !== `http://${host}`) {
    throw new HttpError(403, '不允许跨站写入');
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, '需要 application/json');
  }
}

async function readJson(request) {
  if (Number(request.headers['content-length']) > 65536) {
    throw new HttpError(413, '请求内容过大');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'JSON 内容无效');
  }
}

export function createLocalServer({
  connection,
  jiraConnection,
  jiraFactory = createJiraConnection,
  token = process.env.GITLAB_TOKEN || '',
  gitlabUrl,
  project,
  branch = process.env.GITLAB_BRANCH || 'master',
  fetchImpl = fetch,
} = {}) {
  const gitlab = connection ?? createGitlabConnection({ token, gitlabUrl, project, fetchImpl });
  let jira = jiraConnection;

  function getJira() {
    if (!jira) jira = jiraFactory();
    return jira;
  }

  return createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const checks = /^\/gitlab\/merge-requests\/([1-9]\d*)\/checks$/.exec(path);
    const addComment = /^\/jira\/issues\/(F2PGBA-[1-9]\d*)\/comments$/i.exec(path);
    const updateComment = /^\/jira\/issues\/(F2PGBA-[1-9]\d*)\/comments\/([1-9]\d*)$/i.exec(path);

    if (path === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && (path === '/gitlab/status' || checks)) {
      if (!gitlab.configured) {
        sendJson(response, 503, { ok: false, error: '找不到 GitLab token' });
        return;
      }
      try {
        if (checks) {
          const iid = Number(checks[1]);
          if (!Number.isSafeInteger(iid)) throw new HttpError(400, 'MR IID 无效');
          sendJson(response, 200, await gitlab.getMergeRequestChecks(iid));
        } else {
          sendJson(response, 200, { ok: true, ...await gitlab.checkConnection(branch) });
        }
      } catch (error) {
        sendJson(response, error instanceof HttpError ? error.status : 502, {
          ok: false,
          error: error instanceof HttpError || error instanceof GitlabApiError
            ? error.message : 'GitLab 连接失败',
        });
      }
      return;
    }

    const jiraRoute = Boolean(path === '/jira/board' || path === '/jira/issues' || addComment || updateComment);
    const allowedJiraMethod = (path === '/jira/board' && request.method === 'GET')
      || (path === '/jira/issues' && request.method === 'POST')
      || (addComment && request.method === 'POST')
      || (updateComment && request.method === 'PUT');
    if (!jiraRoute || !allowedJiraMethod) {
      const known = jiraRoute || path === '/health' || path === '/gitlab/status' || Boolean(checks);
      sendJson(response, known ? 405 : 404, {
        ok: false,
        error: known ? '方法不支持' : '路径不存在',
      });
      return;
    }

    try {
      if (request.method !== 'GET') verifyLocalWrite(request);
      let jiraClient;
      try {
        jiraClient = getJira();
      } catch {
        throw new HttpError(503, 'Jira 未配置');
      }
      if (!jiraClient.configured) throw new HttpError(503, '找不到 Jira token');

      if (path === '/jira/board') {
        sendJson(response, 200, { ok: true, ...await jiraClient.checkBoard() });
        return;
      }

      const data = await readJson(request);
      if (path === '/jira/issues') {
        sendJson(response, 201, { ok: true, ...await jiraClient.createIssue(data) });
      } else if (addComment) {
        sendJson(response, 201, {
          ok: true, ...await jiraClient.addComment({ issue: addComment[1], body: data.body }),
        });
      } else {
        sendJson(response, 200, {
          ok: true,
          ...await jiraClient.updateComment({ issue: updateComment[1], id: updateComment[2], body: data.body }),
        });
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status
        : error instanceof JiraInputError ? 400 : 502;
      sendJson(response, status, {
        ok: false,
        error: error instanceof HttpError || error instanceof JiraInputError || error instanceof JiraApiError
          ? error.message : 'Jira 连接失败',
      });
    }
  });
}
