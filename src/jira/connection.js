import { execFileSync } from 'node:child_process';

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
  const id = Number(boardId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('JIRA_BOARD_ID 必须是正整数');

  async function checkBoard() {
    if (!token) throw new Error('找不到 Jira token');
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
      : `Bearer ${token}`;
    const response = await fetchImpl(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board/${id}`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new JiraApiError(response.status);
    const data = await response.json();
    if (data?.id !== id || typeof data.name !== 'string') {
      throw new Error('Jira board 响应无效');
    }
    return { id, name: data.name, projectKey: data.location?.projectKeyId || null };
  }

  return { configured: Boolean(token), checkBoard };
}
