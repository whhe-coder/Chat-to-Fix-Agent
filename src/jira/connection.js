import { execFileSync } from 'node:child_process';

const PROJECT_KEY = 'F2PGBA';

export class JiraInputError extends Error {}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new JiraInputError(`${label} 必须是 1 到 ${maxLength} 个字符`);
  }
  return value.trim();
}

function issueKey(value) {
  if (typeof value !== 'string' || !/^F2PGBA-[1-9]\d*$/i.test(value)) {
    throw new JiraInputError('只允许操作 F2PGBA 工单');
  }
  return value.toUpperCase();
}

function commentId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new JiraInputError('Comment ID 无效');
  }
  return value;
}

function toAdf(value) {
  return {
    type: 'doc',
    version: 1,
    content: value.replace(/\r\n?/g, '\n').split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

export class JiraApiError extends Error {
  constructor(status) {
    super(`Jira 返回 ${status}`);
    this.status = status;
  }
}

export function loadJiraToken({
  env = process.env,
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (env.JIRA_TOKEN) return env.JIRA_TOKEN;
  if (platform !== 'darwin') return undefined;
  try {
    return execFile('security', [
      'find-generic-password',
      '-a', 'local-agent',
      '-s', 'Chat-to-Fix-Agent/JIRA_TOKEN',
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createJiraConnection({
  token = loadJiraToken(),
  cloudId = process.env.JIRA_CLOUD_ID,
  boardId = process.env.JIRA_BOARD_ID,
  email = process.env.JIRA_EMAIL,
  fetchImpl = fetch,
} = {}) {
  if (typeof cloudId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(cloudId)) {
    throw new Error('JIRA_CLOUD_ID 必须是有效的 Cloud ID');
  }
  const id = boardId == null ? null : Number(boardId);

  async function request(method, path, body) {
    if (!token) throw new Error('找不到 Jira token');
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    const response = await fetchImpl(`https://api.atlassian.com/ex/jira/${cloudId}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new JiraApiError(response.status);
    return response.json();
  }

  async function checkBoard() {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error('JIRA_BOARD_ID 必须是正整数');
    }
    const data = await request('GET', `/rest/agile/1.0/board/${id}`);
    if (data?.id !== id || typeof data.name !== 'string') {
      throw new Error('Jira board 响应无效');
    }
    return { id, name: data.name, projectKey: data.location?.projectKeyId || null };
  }

  async function createIssue({ summary, description, issueTypeName }) {
    const fields = {
      project: { key: PROJECT_KEY },
      issuetype: { name: requiredText(issueTypeName, 'Issue type', 100) },
      summary: requiredText(summary, 'Summary', 255),
      description: toAdf(requiredText(description, 'Description', 20000)),
    };
    const data = await request('POST', '/rest/api/3/issue', { fields });
    if (typeof data?.id !== 'string' || typeof data?.key !== 'string' || !/^F2PGBA-[1-9]\d*$/.test(data.key)) {
      throw new Error('Jira 创建工单响应无效');
    }
    return { id: data.id, key: data.key };
  }

  async function addComment({ issue, body }) {
    const key = issueKey(issue);
    const data = await request('POST', `/rest/api/3/issue/${key}/comment`, {
      body: toAdf(requiredText(body, 'Comment', 20000)),
    });
    if (typeof data?.id !== 'string' || !/^[1-9]\d*$/.test(data.id)) {
      throw new Error('Jira 评论响应无效');
    }
    return { issue: key, id: data.id };
  }

  async function updateComment({ issue, id: existingCommentId, body }) {
    const key = issueKey(issue);
    const comment = commentId(existingCommentId);
    const data = await request('PUT', `/rest/api/3/issue/${key}/comment/${comment}`, {
      body: toAdf(requiredText(body, 'Comment', 20000)),
    });
    if (data?.id !== comment) throw new Error('Jira 评论响应无效');
    return { issue: key, id: comment };
  }

  return { configured: Boolean(token), checkBoard, createIssue, addComment, updateComment };
}
